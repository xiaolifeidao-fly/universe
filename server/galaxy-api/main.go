package main

import (
	"context"
	"log"
	"os"
	"time"

	"github.com/gin-gonic/gin"

	"common/middleware/httpx"
	"galaxy-api/routers"
)

func main() {
	gin.SetMode(gin.ReleaseMode)
	database := httpx.Boot("galaxy-api")
	engine, assembly, err := routers.New(database)
	if err != nil {
		log.Fatal(err)
	}
	defer func() { _ = assembly.Control.Close() }()

	// export 接入的派单器：Hub 主动把活推到那些声明了公网地址的机器上。
	// 长轮询那条路不需要它 —— 那些机器自己会来领。
	dispatch, stopDispatch := context.WithCancel(context.Background())
	defer stopDispatch()
	assembly.Export.Start(dispatch)

	// 巡检：密钥到期转冻结、掉线节点摘除、额度计数器快照回 MySQL。
	// 定时跑而不是靠请求触发 —— 一把长期不用的密钥也必须按时失效。
	sweep := time.NewTicker(time.Minute)
	defer sweep.Stop()
	go func() {
		for range sweep.C {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			if err := assembly.Galaxy.Sweep(ctx); err != nil {
				log.Printf("galaxy sweep failed: %v", err)
			}
			cancel()
		}
	}()

	// 抽检单独一条节奏：重放一次要花和原请求一样久，跟巡检挤在一分钟里会互相拖。
	audit := time.NewTicker(5 * time.Minute)
	defer audit.Stop()
	go func() {
		for range audit.C {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
			if done, err := assembly.Galaxy.RunProbes(ctx, 20); err != nil {
				log.Printf("galaxy audit probes failed: %v", err)
			} else if done > 0 {
				log.Printf("galaxy audit probes checked: %d", done)
			}
			cancel()
		}
	}()

	log.Printf("galaxy-api listening on %s", listenAddress())
	if err := engine.Run(listenAddress()); err != nil {
		log.Fatal(err)
	}
}

// listenAddress 监听地址：环境变量 > 配置 server.address > :10004。
func listenAddress() string {
	if address := os.Getenv("GALAXY_API_ADDR"); address != "" {
		return address
	}
	if address := httpx.Property("server.address"); address != "" {
		return address
	}
	return ":10004"
}
