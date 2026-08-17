package routers

import (
	"net/http"

	commonrouters "common/middleware/routers"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func New(database *gorm.DB) (*gin.Engine, error) {
	engine := gin.New()
	engine.Use(gin.Logger(), gin.Recovery())
	if err := engine.SetTrustedProxies(nil); err != nil {
		return nil, err
	}
	engine.GET("/healthz", func(context *gin.Context) {
		context.JSON(http.StatusOK, gin.H{"success": true, "code": 0, "data": "ok", "message": "ok", "error": nil})
	})

	api := engine.Group("/api")
	for _, handler := range registerHandlers(database) {
		handler.RegisterHandler(api)
	}
	return engine, nil
}

var _ commonrouters.Handler
