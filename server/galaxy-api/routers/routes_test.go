package routers

import (
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	authpkg "galaxy-api/pkg/auth"
	"galaxy-api/pkg/consumers"
	"galaxy-api/pkg/portal"
	"galaxy-api/pkg/providers"
)

// TestConsoleSurfacesShareOnePrefix /api/galaxy 下挂着四个包的路由：门户、两端登录、共享端、使用端。
// 各包自己的测试只看得到自己那一组，而 gin 的路由冲突是**注册期 panic** ——
// 两端的 auth 组和各自的业务组共用 /provider、/consumer 前缀，撞车要到进程启动时才发现。
//
// 顺带钉住：控制台上不再有任何运营接口。它们在 manager-api，认的是管理端账号。
func TestConsoleSurfacesShareOnePrefix(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()

	defer func() {
		if recovered := recover(); recovered != nil {
			t.Fatalf("控制台路由注册不该 panic：%v", recovered)
		}
	}()
	gate := authpkg.NewGate(nil)
	console := engine.Group("/api/galaxy")
	portal.NewHandler(nil, portal.Options{}).RegisterHandler(console)
	authpkg.NewHandler(nil, gate).RegisterHandler(console)
	providers.NewHandler(nil, gate).RegisterHandler(console)
	consumers.NewHandler(nil, gate, consumers.Options{}).RegisterConsole(console)

	registered := map[string]bool{}
	for _, route := range engine.Routes() {
		registered[route.Method+" "+route.Path] = true
		if strings.HasPrefix(route.Path, "/api/galaxy/admin") {
			t.Errorf("galaxy-api 不该再挂运营接口：%s %s", route.Method, route.Path)
		}
	}
	for _, route := range []string{
		"POST /api/galaxy/provider/auth/login",
		"GET /api/galaxy/provider/nodes",
		"POST /api/galaxy/consumer/auth/login",
		"GET /api/galaxy/consumer/keys",
		"GET /api/galaxy/portal/overview",
	} {
		if !registered[route] {
			t.Errorf("缺少路由 %s", route)
		}
	}
}
