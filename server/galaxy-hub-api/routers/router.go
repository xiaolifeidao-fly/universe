package routers

import (
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"galaxy-common/bootstrap"
	corepkg "galaxy-hub-api/adapters/core"
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
	consumer := engine.Group("/v1", corepkg.RequireConsumerKey(assembly.Galaxy))
	deps := corepkg.Deps{Galaxy: assembly.Galaxy, Exchange: assembly.Exchange, Journal: assembly.Journal}
	for _, adapter := range assembly.Registry.Adapters() {
		corepkg.Register(consumer, adapter, deps)
	}
	assembly.Native.RegisterNative(consumer)
	assembly.Agent.RegisterHandler(engine.Group("/agent/v1"))
	assembly.Bridge.RegisterHandler(engine.Group("/agent/v1"))
	return engine
}
