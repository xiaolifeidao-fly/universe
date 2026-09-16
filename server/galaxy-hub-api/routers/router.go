package routers

import (
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"galaxy-common/bootstrap"
	corepkg "galaxy-hub-api/adapters/core"
)

func New(database *gorm.DB, drain *bootstrap.Drain) (*gin.Engine, *Assembly, error) {
	assembly, err := Build(database, drain)
	if err != nil {
		return nil, nil, err
	}
	return route(assembly, drain), assembly, nil
}
func route(assembly *Assembly, drain *bootstrap.Drain) *gin.Engine {
	engine := bootstrap.Engine(assembly.Metrics, drain)
	consumer := engine.Group("/v1", corepkg.RequireConsumerKey(assembly.Galaxy))
	// 用 Build 那份 Deps 而不是在这里重新拼一个：attach_timeout / node_probe_interval
	// 两项配置只写在那一份上，重拼会把它们丢掉，relay 就永远走代码里的默认值。
	for _, adapter := range assembly.Registry.Adapters() {
		corepkg.Register(consumer, adapter, *assembly.Deps)
	}
	assembly.Native.RegisterNative(consumer)
	assembly.Agent.RegisterHandler(engine.Group("/agent/v1"))
	assembly.Bridge.RegisterHandler(engine.Group("/agent/v1"))
	return engine
}
