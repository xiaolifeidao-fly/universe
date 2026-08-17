package main

import (
	"log"
	"os"

	"web-api/routers"

	"common/middleware/httpx"
	"github.com/gin-gonic/gin"
)

func main() {
	gin.SetMode(gin.ReleaseMode)
	database := httpx.Boot("web-api")
	engine, err := routers.New(database)
	if err != nil {
		log.Fatal(err)
	}

	log.Printf("web-api listening on %s", listenAddress())
	if err := engine.Run(listenAddress()); err != nil {
		log.Fatal(err)
	}
}

// listenAddress 监听地址：环境变量 > 配置 server.address > :10001。
//
// 环境变量优先是给 start.sh 用的 —— 它按同样的顺序算出端口再去探 /healthz，
// 少了这一层，`WEB_API_ADDR=:9000 ./start.sh` 会变成「进程起在 10001、
// 脚本在 9000 上等就绪」，最后报一个和真实情况无关的启动失败。
func listenAddress() string {
	if address := os.Getenv("WEB_API_ADDR"); address != "" {
		return address
	}
	if address := httpx.Property("server.address"); address != "" {
		return address
	}
	return ":10001"
}
