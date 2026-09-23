package auth

import (
	"testing"

	"github.com/gin-gonic/gin"
)

// TestAuthRoutesRegisterPerSide 两端各一组登录路由，挂在各自业务接口的前缀下。
//
// 路径逐字断言：Gate 按 /<端>/auth/me 与 /<端>/auth/password 这两个后缀放行必须改密码的人，
// 挪一个字，被运营重置过密码的账号就会被自己的临时密码锁死。
//
// 同时盯住老的 /api/auth/* 不再注册 —— 那是任务宇宙的账号入口，Galaxy 已经不认那套账号了。
func TestAuthRoutesRegisterPerSide(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()

	defer func() {
		if recovered := recover(); recovered != nil {
			t.Fatalf("路由注册不该 panic：%v", recovered)
		}
	}()
	NewHandler(nil, NewGate(nil)).RegisterHandler(engine.Group("/api/galaxy"))

	want := []string{
		"POST /api/galaxy/provider/auth/register",
		"POST /api/galaxy/provider/auth/login",
		"GET /api/galaxy/provider/auth/me",
		"POST /api/galaxy/provider/auth/password",
		"POST /api/galaxy/consumer/auth/register",
		"POST /api/galaxy/consumer/auth/login",
		"GET /api/galaxy/consumer/auth/me",
		"POST /api/galaxy/consumer/auth/password",
	}
	gone := []string{"POST /api/auth/login", "GET /api/auth/me", "POST /api/auth/password"}
	registered := map[string]bool{}
	for _, route := range engine.Routes() {
		registered[route.Method+" "+route.Path] = true
	}
	for _, route := range want {
		if !registered[route] {
			t.Errorf("缺少路由 %s", route)
		}
	}
	for _, route := range gone {
		if registered[route] {
			t.Errorf("%s 是任务宇宙的账号入口，不该再挂在 Galaxy 上", route)
		}
	}
}
