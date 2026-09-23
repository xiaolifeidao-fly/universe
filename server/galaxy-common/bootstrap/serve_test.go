package bootstrap

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/signal"
	"syscall"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"galaxy-common/metrics"
)

// nil 的 Drain 必须可用：没接生命周期的调用方（测试、将来新写的服务）里
// 那些 select 分支应当永不触发，而不是 panic。
func TestNilDrainIsUsable(t *testing.T) {
	var drain *Drain
	if drain.Active() {
		t.Fatal("nil Drain 不该是退出中")
	}
	if drain.Begun() != nil {
		t.Fatal("nil Drain 的 Begun() 应当是 nil channel —— select 到它永远阻塞")
	}
	drain.Begin() // 不该 panic
	select {
	case <-drain.Begun():
		t.Fatal("select 到 nil channel 不该就绪")
	default:
	}
}

func TestDrainBeginIsIdempotent(t *testing.T) {
	drain := NewDrain()
	if drain.Active() {
		t.Fatal("刚建出来不该是退出中")
	}
	drain.Begin()
	drain.Begin() // 重复关同一个 channel 会 panic，once 必须挡住
	if !drain.Active() {
		t.Fatal("Begin 之后应当是退出中")
	}
	select {
	case <-drain.Begun():
	default:
		t.Fatal("Begin 之后 Begun() 应当已就绪")
	}
}

// 存活与就绪是两件事：退出期间进程是健康的（它正在把在途请求送完），
// 这时 healthz 翻成失败等于让编排把它重启掉，而要翻的是 readyz。
func TestReadyzFlipsWhileHealthzStaysUp(t *testing.T) {
	gin.SetMode(gin.TestMode)
	drain := NewDrain()
	engine := Engine(metrics.New(), drain)

	status := func(path string) int {
		recorder := httptest.NewRecorder()
		engine.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		return recorder.Code
	}

	if code := status("/readyz"); code != http.StatusOK {
		t.Fatalf("退出之前 readyz 应当是 200，实际 %d", code)
	}
	drain.Begin()
	if code := status("/readyz"); code != http.StatusServiceUnavailable {
		t.Fatalf("退出之后 readyz 应当是 503，实际 %d", code)
	}
	if code := status("/healthz"); code != http.StatusOK {
		t.Fatalf("退出期间 healthz 必须仍是 200，实际 %d —— 否则编排会把正在收尾的进程重启掉", code)
	}
}

// 收到信号之后，在途请求要跑完才退出。这是整件事的核心：
// 没有它，每次发版都会掐断正在跑的请求。
func TestServeFinishesInFlightRequestOnSignal(t *testing.T) {
	// 先自己注册一次 SIGTERM，把进程的默认处置（直接终止）换掉。
	// 否则信号可能赶在 Serve 注册之前到达，测试进程当场死掉。
	guard := make(chan os.Signal, 1)
	signal.Notify(guard, syscall.SIGTERM)
	defer signal.Stop(guard)

	gin.SetMode(gin.TestMode)
	drain := NewDrain()
	engine := Engine(metrics.New(), drain)
	released := make(chan struct{})
	engine.GET("/slow", func(c *gin.Context) {
		<-released
		c.String(http.StatusOK, "done")
	})

	address := freeAddress(t)
	served := make(chan error, 1)
	go func() {
		served <- Serve(engine, ServeOptions{
			Address: address, Drain: drain,
			Linger: 10 * time.Millisecond, Timeout: 5 * time.Second,
		})
	}()

	base := "http://" + address
	waitUntilUp(t, base+"/readyz")

	// 一条在途请求：它必须在进程退出之前跑完。
	answered := make(chan int, 1)
	go func() {
		response, err := http.Get(base + "/slow")
		if err != nil {
			answered <- 0
			return
		}
		defer func() { _ = response.Body.Close() }()
		answered <- response.StatusCode
	}()
	time.Sleep(50 * time.Millisecond) // 让它确实进到处理器里

	if err := syscall.Kill(syscall.Getpid(), syscall.SIGTERM); err != nil {
		t.Fatalf("发信号失败：%v", err)
	}
	// 信号到达之后就绪要先翻掉，上游据此把这台摘出轮转。
	deadline := time.Now().Add(2 * time.Second)
	for !drain.Active() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if !drain.Active() {
		t.Fatal("收到 SIGTERM 之后没有进入退出状态")
	}

	select {
	case <-served:
		t.Fatal("在途请求还没跑完就退出了")
	case <-time.After(150 * time.Millisecond):
	}

	close(released)
	select {
	case code := <-answered:
		if code != http.StatusOK {
			t.Fatalf("在途请求应当正常完成，实际状态 %d", code)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("在途请求没有完成")
	}
	select {
	case err := <-served:
		if err != nil {
			t.Fatalf("Serve 应当干净退出，实际：%v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("在途请求跑完之后 Serve 没有退出")
	}
}

func freeAddress(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("找不到空闲端口：%v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	return fmt.Sprintf("127.0.0.1:%d", port)
}

func waitUntilUp(t *testing.T, url string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		response, err := http.Get(url)
		if err == nil {
			_ = response.Body.Close()
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("服务没有起来：%s", url)
}
