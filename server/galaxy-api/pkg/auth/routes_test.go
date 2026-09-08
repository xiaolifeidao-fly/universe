package auth

import (
	"testing"

	"github.com/gin-gonic/gin"
)

// TestAuthRoutesRegisterAtSharedPaths 盯的是这次修复的那个坑：控制台曾经只注册了
// /api/galaxy/*，登录页打的 /api/auth/login 直接 404，前端只能看到「请求失败」。
//
// 路径是逐字断言的，不是模糊匹配：common/middleware/httpx 的 requireChangedPassword
// 把 "/api/auth/me" 和 "/api/auth/password" 两条**完整路径**硬编码成
// 「没改初始密码也放行」的例外。这里挪一个字（比如挂到 /api/galaxy/auth 下），
// mustChangePassword=true 的账号就会被自己的初始密码锁死在门外。
func TestAuthRoutesRegisterAtSharedPaths(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()

	defer func() {
		if recovered := recover(); recovered != nil {
			t.Fatalf("路由注册不该 panic：%v", recovered)
		}
	}()
	NewHandler(nil).RegisterHandler(engine.Group("/api"))

	want := []string{
		"POST /api/auth/login",
		"GET /api/auth/me",
		"POST /api/auth/password",
	}
	registered := map[string]bool{}
	for _, route := range engine.Routes() {
		registered[route.Method+" "+route.Path] = true
	}
	for _, route := range want {
		if !registered[route] {
			t.Errorf("缺少路由 %s", route)
		}
	}
}
