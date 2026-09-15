package main

import (
	"log"

	"github.com/gin-gonic/gin"

	"common/middleware/httpx"
	"galaxy-api/routers"
	"galaxy-common/bootstrap"
)

func main() {
	gin.SetMode(gin.ReleaseMode)
	engine, assembly, err := routers.New(httpx.Boot("galaxy-api"))
	if err != nil {
		log.Fatal(err)
	}
	defer func() { _ = assembly.Control.Close() }()
	address := bootstrap.ListenAddress("GALAXY_API_ADDR", ":10004")
	log.Printf("galaxy-api listening on %s", address)
	if err := engine.Run(address); err != nil {
		log.Fatal(err)
	}
}
