package main

import (
	"log"

	"github.com/gin-gonic/gin"

	"common/middleware/httpx"
	"galaxy-common/bootstrap"
	"galaxy-consumer-api/routers"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
	log.Print("galaxy-consumer-api stopped")
}

// run 单独一层是为了让清理跑在 log.Fatal 之前 —— Fatal 会直接 os.Exit，
// 写在 main 里的 defer 一个都不会执行。
func run() error {
	gin.SetMode(gin.ReleaseMode)
	drain := bootstrap.NewDrain()
	engine, assembly, err := routers.New(httpx.Boot("galaxy-consumer-api"), drain)
	if err != nil {
		return err
	}
	defer func() { _ = assembly.Control.Close() }()
	address := bootstrap.ListenAddress("GALAXY_CONSUMER_API_ADDR", ":10005")
	log.Printf("galaxy-consumer-api listening on %s", address)
	// 控制台和门户都没有长连接；支付回调更是秒级。时限给 30 秒足够。
	return bootstrap.Serve(engine, bootstrap.ServeOptions{
		Address: address, Drain: drain,
		Linger:  bootstrap.DurationProperty("galaxy.shutdown.drain_delay_ms", 5000),
		Timeout: bootstrap.DurationProperty("galaxy.shutdown.timeout_ms", 30000),
	})
}
