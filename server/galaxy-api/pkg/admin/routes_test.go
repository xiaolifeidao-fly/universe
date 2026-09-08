package admin

import (
	"testing"

	"github.com/gin-gonic/gin"
)

// TestAdminRoutesRegisterWithoutConflict 路由冲突在 gin 里是注册期 panic，
// 而注册发生在进程启动时 —— 撞车要等到部署上线才发现，且整个进程起不来。
//
// 顺带钉住商品目录的落点：它是运营动作，和封禁、裁决在同一组。
func TestAdminRoutesRegisterWithoutConflict(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()

	defer func() {
		if recovered := recover(); recovered != nil {
			t.Fatalf("路由注册不该 panic：%v", recovered)
		}
	}()
	NewHandler(nil).RegisterHandler(engine.Group("/api/galaxy"))

	want := []string{
		"GET /api/galaxy/admin/pool",
		"GET /api/galaxy/admin/nodes",
		"GET /api/galaxy/admin/disputes",
		"POST /api/galaxy/admin/disputes/resolve",
		"GET /api/galaxy/admin/packages",
		"POST /api/galaxy/admin/packages/save",
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
