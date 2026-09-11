package routers

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	corepkg "galaxy-api/adapters/core"
)

// New 构造 Hub 的路由树。三段链路各有各的鉴权与响应形态：
//
//	/v1/*        消费者：sk- 算力密钥，官方 SDK 兼容，响应体是官方形态
//	/agent/v1/*  节点：node token，机器协议，按 HTTP 状态码分支
//	/api/galaxy  控制台：用户令牌，统一信封
//
// 例外只有一处：/api/galaxy/portal/* 是门户面，**不带鉴权** —— 它回答的是
// 「你们卖什么、多少钱」，收口在同一段路径下，方便一眼看出哪些是公开的。
func New(database *gorm.DB) (*gin.Engine, *Assembly, error) {
	assembly, err := Build(database)
	if err != nil {
		return nil, nil, err
	}

	engine := gin.New()
	engine.Use(gin.Logger(), gin.Recovery())
	if err := engine.SetTrustedProxies(nil); err != nil {
		return nil, nil, err
	}
	// 指标不挂鉴权：里面没有任何业务内容，谁能访问由部署侧决定
	// （通常只在内网监听，或放在网关后面）。
	engine.GET("/metrics", assembly.Metrics.Handler())
	engine.GET("/healthz", func(context *gin.Context) {
		context.JSON(http.StatusOK, gin.H{"success": true, "code": 0, "data": "ok", "message": "ok", "error": nil})
	})

	// 消费者面：适配器自己声明路径，通道层统一处理鉴权之后的全部流程。
	consumer := engine.Group("/v1", corepkg.RequireConsumerKey(assembly.Galaxy))
	deps := corepkg.Deps{Galaxy: assembly.Galaxy, Exchange: assembly.Exchange, Journal: assembly.Journal}
	for _, adapter := range assembly.Registry.Adapters() {
		corepkg.Register(consumer, adapter, deps)
	}
	assembly.Consumers.RegisterNative(consumer)

	// 支付渠道回调。不带用户鉴权 —— 打过来的是渠道的服务器，身份由报文签名证明。
	// 没接渠道时这组路由不注册。
	assembly.Consumers.RegisterCallbacks(engine.Group("/galaxy"))

	// 节点面。
	assembly.Agent.RegisterHandler(engine.Group("/agent/v1"))

	// 控制台面。登录挂在 /api 上（账号体系与 web/app/manager 共用同一套，
	// 路径也保持一致），共享池自己的业务接口才在 /api/galaxy 下。
	api := engine.Group("/api")
	assembly.Auth.RegisterHandler(api)
	console := api.Group("/galaxy")
	// 门户面先挂：它没有鉴权，放在最前面读路由的人第一眼就会看到这件事。
	assembly.Portal.RegisterHandler(console)
	assembly.Providers.RegisterHandler(console)
	assembly.Consumers.RegisterConsole(console)
	assembly.Admin.RegisterHandler(console)

	return engine, assembly, nil
}
