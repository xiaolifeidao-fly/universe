package routers

import (
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"galaxy-common/bootstrap"
)

func New(database *gorm.DB) (*gin.Engine, *Assembly, error) {
	assembly, err := Build(database)
	if err != nil {
		return nil, nil, err
	}
	return route(assembly), assembly, nil
}
func route(assembly *Assembly) *gin.Engine {
	engine := bootstrap.Engine(assembly.Metrics)
	console := engine.Group("/api/galaxy")
	assembly.Auth.RegisterHandler(console)
	assembly.Consumers.RegisterConsole(console)
	assembly.Portal.RegisterHandler(console)
	assembly.Consumers.RegisterCallbacks(engine.Group("/galaxy"))
	return engine
}
