package routers

import (
	"context"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
	"service/bizline"
	"service/delivery"
	galaxysvc "service/galaxy"
	"service/identity"
	"service/manager"

	"common/middleware/httpx"
	commonrouters "common/middleware/routers"
	managerauth "manager-api/auth"
	bizlinespkg "manager-api/pkg/bizlines"
	consolepkg "manager-api/pkg/console"
	galaxypkg "manager-api/pkg/galaxy"
	programspkg "manager-api/pkg/programs"
	userspkg "manager-api/pkg/users"
)

// New 构造管理端的路由树。
//
// 鉴权是一道中间件挂在 /api 整组上，不再是每条路由各自声明 httpx.Require*：
// 管理端的权限是数据驱动的（角色 → 资源），写在路由上的静态声明表达不了
// 「这个角色能看不能改」。
//
// 每个服务实例都可以为 nil：注册路由只把方法值存进 handler，不会调用它们。
// managerseed / managerinit 就是全传 nil 来拿路由表的 —— **接口资源表按这张
// 路由表生成**，少注册一组，那组接口就永远不在资源表里，登录用户一律访问不到。
func New(
	managerService manager.Service,
	identityService identity.Service,
	bizLineService bizline.Service,
	deliveryService delivery.Service,
	galaxyService galaxysvc.Service,
) (*gin.Engine, error) {
	engine := gin.New()
	engine.Use(gin.Logger(), gin.Recovery())
	if err := engine.SetTrustedProxies(nil); err != nil {
		return nil, err
	}
	engine.Use(cors(httpx.Property("manager.cors_origins")))
	engine.OPTIONS("/*path", func(context *gin.Context) { context.Status(http.StatusNoContent) })
	engine.GET("/healthz", func(context *gin.Context) {
		context.JSON(http.StatusOK, gin.H{"success": true, "code": 0, "data": "ok", "message": "ok", "error": nil})
	})

	api := engine.Group("/api", managerauth.Middleware(managerService))
	for _, handler := range registerHandlers(managerService, identityService, bizLineService, deliveryService, galaxyService) {
		handler.RegisterHandler(api)
	}
	return engine, nil
}

// registerHandlers 是这个进程唯一的装配点。新增子域照这个形状加一行——
// controller 放 manager-api/pkg/{子域}/handler.go，需要新的业务能力时在
// service/ 下新建对应领域包，不要把业务逻辑写进 handler。
func registerHandlers(
	managerService manager.Service,
	identityService identity.Service,
	bizLineService bizline.Service,
	deliveryService delivery.Service,
	galaxyService galaxysvc.Service,
) []commonrouters.Handler {
	return []commonrouters.Handler{
		consolepkg.NewHandler(managerService),
		userspkg.NewHandler(identityService),
		bizlinespkg.NewHandler(bizLineService, identityService),
		programspkg.NewHandler(deliveryService),
		galaxypkg.NewHandler(galaxyService),
	}
}

// Routes 把 gin 的路由表转成领域层认识的形状，供接口资源同步与启动自检用。
func Routes(engine *gin.Engine) []manager.RouteRef {
	routes := engine.Routes()
	refs := make([]manager.RouteRef, 0, len(routes))
	for _, route := range routes {
		refs = append(refs, manager.RouteRef{Method: route.Method, Path: route.Path})
	}
	return refs
}

// ReportUnregisteredRoutes 启动自检。
//
// 没有它，新增接口忘了在资源表里登记，要等到有人点了才 403，而且从现象上
// 分不出是配置疏漏还是代码 bug。这里只报警不阻断启动 —— 漏登记的通常是新接口，
// 让整个进程起不来的代价比一条日志大得多。
func ReportUnregisteredRoutes(ctx context.Context, engine *gin.Engine, service manager.Service) {
	missing, err := service.UnregisteredRoutes(ctx, Routes(engine))
	if err != nil {
		log.Printf("manager-api: 路由自检失败: %v", err)
		return
	}
	if len(missing) == 0 {
		return
	}
	log.Printf("manager-api: %d 条路由未在资源表登记，登录用户一律访问不到（跑 cmd/managerinit 补齐）：", len(missing))
	for _, route := range missing {
		log.Printf("  %s %s", route.Method, route.Path)
	}
}
