package bootstrap

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

// Drain 一次优雅退出的进度信号。
//
// 用「关掉一个 channel」而不是置一个标志位：要被叫醒的那些处理器正挂在自己的
// channel 上等（节点的长轮询、session / job 的 SSE 订阅），轮询一个 bool 它们看不见。
//
// 零值不可用，但 nil 指针是可用的：Begun() 返回 nil channel（select 到它永远阻塞），
// Active() 恒为 false。于是没接生命周期的调用方 —— 测试、将来新写的服务 ——
// 里那些 select 分支自然永不触发，不必到处判空。
type Drain struct {
	begun chan struct{}
	once  sync.Once
}

func NewDrain() *Drain { return &Drain{begun: make(chan struct{})} }

// Begin 宣布开始退出。重复调用无害。
func (d *Drain) Begin() {
	if d == nil {
		return
	}
	d.once.Do(func() { close(d.begun) })
}

// Begun 开始退出时会被关掉的 channel。
func (d *Drain) Begun() <-chan struct{} {
	if d == nil {
		return nil
	}
	return d.begun
}

func (d *Drain) Active() bool {
	if d == nil {
		return false
	}
	select {
	case <-d.begun:
		return true
	default:
		return false
	}
}

// ServeOptions 优雅退出的节奏。
type ServeOptions struct {
	Address string
	// Drain 退出信号。处理器据此收掉「可以中断」的那些连接。
	Drain *Drain
	// OnDrain 在退出开始的那一刻同步调用，用来停掉后台循环 ——
	// 派单器和巡检不该在这时候再去认领新活。
	OnDrain func()
	// Linger 宣布退出之后、关监听之前先等多久。
	//
	// 这一段是给上游摘流量用的：readiness 已经翻成 503，但 nginx reload 和
	// K8s 更新 Endpoints 都不是瞬时的。这时候就关监听，那几百毫秒里进来的
	// 请求吃的是连接拒绝 —— 明明是计划内的重启，用户看到的却是故障。
	Linger time.Duration
	// Timeout 等在途请求跑完的上限，到点仍未跑完的连接强制关闭。
	//
	// 它必须盖住最长的那类**不可中断**连接。对 Hub 来说是 relay 的 maxRunSec
	// （默认 600 秒）：那条连接上已经有字节流给消费者了，掐掉就是一次失败的请求，
	// 而且收不回来。可中断的那些（长轮询、SSE 订阅）由 Drain 各自收尾，不吃这个时限。
	Timeout time.Duration
}

// Serve 起 HTTP 服务并接管 SIGTERM / SIGINT。
//
// 顺序是定死的：宣布退出 → 停后台循环 → 等上游摘流量 → 关监听等在途跑完 → 退出。
// 第一步必须在关监听之前，否则节点会在最后一刻领到一个单元，
// 然后发现没法把上行推回来 —— 那条请求就白跑了。
func Serve(handler http.Handler, options ServeOptions) error {
	server := &http.Server{Addr: options.Address, Handler: handler}

	failed := make(chan error, 1)
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			failed <- err
		}
	}()

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(signals)

	select {
	case err := <-failed:
		return err
	case received := <-signals:
		log.Printf("收到 %s，开始优雅退出", received)
	}

	options.Drain.Begin()
	if options.OnDrain != nil {
		options.OnDrain()
	}
	if options.Linger > 0 {
		log.Printf("已停止领取新活，等 %s 让上游把这台摘出轮转", options.Linger)
		select {
		case received := <-signals:
			log.Printf("再次收到 %s，跳过等待", received)
		case <-time.After(options.Linger):
		}
	}

	timeout := options.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	log.Printf("关闭监听，等在途请求跑完（上限 %s）", timeout)
	done := make(chan error, 1)
	go func() { done <- server.Shutdown(ctx) }()
	select {
	case err := <-done:
		if err != nil {
			log.Printf("在途请求未能在 %s 内跑完，强制关闭：%v", timeout, err)
			return server.Close()
		}
		log.Print("在途请求已全部跑完")
		return nil
	case received := <-signals:
		// 人按了第二次 Ctrl-C，或者编排在升级强度。别再让他等十分钟。
		log.Printf("再次收到 %s，不再等在途请求", received)
		return server.Close()
	}
}
