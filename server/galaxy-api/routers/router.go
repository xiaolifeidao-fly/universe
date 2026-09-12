package routers

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	corepkg "galaxy-api/adapters/core"
)

// New 构造 Hub 的路由树。三段链路各有各的鉴权与响应形态：
//
//	/v1/*                  消费者：sk- 算力密钥，官方 SDK 兼容，响应体是官方形态
//	/agent/v1/*            节点：node token，机器协议，按 HTTP 状态码分支
//	/api/galaxy/provider/* 共享端控制台（Nova）：共享端账号令牌，统一信封
//	/api/galaxy/consumer/* 使用端控制台（Orbit）：使用端账号令牌，统一信封
//
// 控制台账号是 Galaxy 自己的（service/galaxy/account），和任务宇宙那套无关；
// 两端各一批人，一端的令牌调不了另一端。运营接口不在这个进程里，在 manager-api。
//
// 不带鉴权的有两处：/api/galaxy/portal/* 是门户面，回答「你们卖什么、多少钱」；
// /api/galaxy/{provider,consumer}/auth/{login,register} 是两端的登录注册。
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
	// ai-bridge 的下载清单、安装脚本与下载跳转，挂在同一个前缀下（节点与安装脚本
	// 用的是同一个平台地址）。**不鉴权**：要装它的那台机器此刻还没有任何身份，
	// 而安装包不是秘密 —— 完整性由 sha256 与发布签名保证，能不能入池由接入密钥决定。
	assembly.Bridge.RegisterHandler(engine.Group("/agent/v1"))

	// 控制台面。门户面和两端的登录注册先挂：它们没有鉴权，放在最前面，
	// 读路由的人第一眼就会看到这件事。
	console := engine.Group("/api/galaxy")
	assembly.Portal.RegisterHandler(console)
	assembly.Auth.RegisterHandler(console)
	assembly.Providers.RegisterHandler(console)
	assembly.Consumers.RegisterConsole(console)

	return engine, assembly, nil
}
