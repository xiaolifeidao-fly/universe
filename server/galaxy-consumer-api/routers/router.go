package routers

import (
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"galaxy-common/bootstrap"
)

func New(database *gorm.DB, drain *bootstrap.Drain) (*gin.Engine, *Assembly, error) {
	assembly, err := Build(database)
	if err != nil {
		return nil, nil, err
	}
	return route(assembly, drain), assembly, nil
}
func route(assembly *Assembly, drain *bootstrap.Drain) *gin.Engine {
	engine := bootstrap.Engine(assembly.Metrics, drain)
	console := engine.Group("/api/galaxy")
	assembly.Auth.RegisterHandler(console)
	assembly.Consumers.RegisterConsole(console)
	assembly.Portal.RegisterHandler(console)
	assembly.Consumers.RegisterCallbacks(engine.Group("/galaxy"))
	return engine
}
