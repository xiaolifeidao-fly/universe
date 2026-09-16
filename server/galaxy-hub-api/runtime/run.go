package runtime

import (
	"context"
	"log"
	"time"

	"github.com/gin-gonic/gin"

	"common/middleware/httpx"
	"galaxy-common/bootstrap"
	"galaxy-hub-api/routers"
)

func Run() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
	log.Print("galaxy-hub-api stopped")
}

// run 单独一层是为了让清理跑在 log.Fatal 之前 —— Fatal 会直接 os.Exit，
// 写在 main 里的 defer 一个都不会执行。
func run() error {
	gin.SetMode(gin.ReleaseMode)
	database := httpx.Boot("galaxy-hub-api")
	drain := bootstrap.NewDrain()
	engine, assembly, err := routers.New(database, drain)
	if err != nil {
		return err
	}
	defer func() { _ = assembly.Control.Close() }()

	// 后台循环统一挂在这个 context 上：优雅退出时一次性叫停。
	// 派单器在退出期间继续认领新活是没有意义的 —— 领到的活最后还是要靠
	// 这个进程把字节交出去，而它马上就不在了。
	background, stopBackground := context.WithCancel(context.Background())
	defer stopBackground()

	// export 接入的派单器：Hub 主动把活推到那些声明了公网地址的机器上。
	// 长轮询那条路不需要它 —— 那些机器自己会来领。
	assembly.Export.Start(background)

	// 巡检：密钥到期转冻结、掉线节点摘除、额度计数器快照回 MySQL。
	// 定时跑而不是靠请求触发 —— 一把长期不用的密钥也必须按时失效。
	go loop(background, time.Minute, 30*time.Second, func(ctx context.Context) {
		if err := assembly.Galaxy.Sweep(ctx); err != nil {
			log.Printf("galaxy sweep failed: %v", err)
		}
	})

	// 抽检单独一条节奏：重放一次要花和原请求一样久，跟巡检挤在一分钟里会互相拖。
	go loop(background, 5*time.Minute, 10*time.Minute, func(ctx context.Context) {
		if done, err := assembly.Galaxy.RunProbes(ctx, 20); err != nil {
			log.Printf("galaxy audit probes failed: %v", err)
		} else if done > 0 {
			log.Printf("galaxy audit probes checked: %d", done)
		}
	})

	address := bootstrap.ListenAddress("GALAXY_HUB_API_ADDR", ":10006")
	log.Printf("galaxy-hub-api listening on %s", address)
	// 退出时限要盖住 relay 的 maxRunSec（默认 600 秒）：那条连接上已经有字节
	// 流给消费者了，掐掉就是一次收不回的失败请求。可中断的那些（节点长轮询、
	// session / job 的 SSE 订阅）由 Drain 各自收线，不吃这个时限。
	// 绝大多数请求几秒就完，这个数只是上限，平时的退出快得多。
	return bootstrap.Serve(engine, bootstrap.ServeOptions{
		Address: address, Drain: drain, OnDrain: stopBackground,
		Linger:  bootstrap.DurationProperty("galaxy.shutdown.drain_delay_ms", 5000),
		Timeout: bootstrap.DurationProperty("galaxy.shutdown.timeout_ms", 630000),
	})
}

// loop 按 interval 跑一个后台作业，每轮各带自己的超时，ctx 一取消就收线。
//
// 取消要传到作业里面去，不是只停下一轮：抽检重放一次可能跑十分钟，
// 进程都要退出了还挂在上游请求上，等于把退出时间又拖长十分钟。
func loop(ctx context.Context, interval, timeout time.Duration, job func(context.Context)) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			round, cancel := context.WithTimeout(ctx, timeout)
			job(round)
			cancel()
		}
	}
}
