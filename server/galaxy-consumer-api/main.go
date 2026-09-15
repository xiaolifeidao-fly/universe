package main

import (
	"log"

	"github.com/gin-gonic/gin"

	"common/middleware/httpx"
	"galaxy-common/bootstrap"
	"galaxy-consumer-api/routers"
)

func main() {
	gin.SetMode(gin.ReleaseMode)
	engine, assembly, err := routers.New(httpx.Boot("galaxy-consumer-api"))
	if err != nil {
		log.Fatal(err)
	}
	defer func() { _ = assembly.Control.Close() }()
	address := bootstrap.ListenAddress("GALAXY_CONSUMER_API_ADDR", ":10005")
	log.Printf("galaxy-consumer-api listening on %s", address)
	if err := engine.Run(address); err != nil {
		log.Fatal(err)
	}
}
