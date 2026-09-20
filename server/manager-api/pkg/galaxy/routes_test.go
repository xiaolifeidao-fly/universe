package galaxy

import (
	"testing"

	"github.com/gin-gonic/gin"
)

// TestAdminRoutesRegisterWithoutConflict 共享池的运营接口全在这一组：galaxy-api 那边已经没有了。
//
// 路由冲突在 gin 里是注册期 panic。另外这张路由表就是接口资源表的来源 ——
// 少注册一条，那条接口就不会出现在 server/manager_galaxy_resources.sql 能登记的范围里。
func TestAdminRoutesRegisterWithoutConflict(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()

	defer func() {
		if recovered := recover(); recovered != nil {
			t.Fatalf("路由注册不该 panic：%v", recovered)
		}
	}()
	NewHandler(nil, nil).RegisterHandler(engine.Group("/api"))

	want := []string{
		"GET /api/galaxy/admin/pool",
		"GET /api/galaxy/admin/nodes",
		"POST /api/galaxy/admin/provider/type",
		"GET /api/galaxy/admin/disputes",
		"POST /api/galaxy/admin/disputes/resolve",
		"GET /api/galaxy/admin/users",
		"POST /api/galaxy/admin/users/status",
		"POST /api/galaxy/admin/users/password",
		"POST /api/galaxy/admin/keys/issue",
		"GET /api/galaxy/admin/portal/models",
		"POST /api/galaxy/admin/portal/models/save",
		"POST /api/galaxy/admin/portal/models/delete",
		"GET /api/galaxy/admin/portal/leads",
		"POST /api/galaxy/admin/portal/leads/handle",
		"GET /api/galaxy/admin/keys",
		"POST /api/galaxy/admin/keys/secret",
		"GET /api/galaxy/admin/points/ledger",
		"GET /api/galaxy/admin/points/summary",
		"POST /api/galaxy/admin/points/recharge",
		"GET /api/galaxy/admin/referral/settings",
		"POST /api/galaxy/admin/referral/settings/save",
		"GET /api/galaxy/admin/bridge/releases",
		"POST /api/galaxy/admin/bridge/releases/upload",
		"POST /api/galaxy/admin/bridge/releases/status",
		"GET /api/galaxy/admin/desktop/releases",
		"POST /api/galaxy/admin/desktop/releases/prepare",
		"POST /api/galaxy/admin/desktop/releases/publish",
		"POST /api/galaxy/admin/desktop/releases/status",
		"GET /api/galaxy/admin/payouts",
		"POST /api/galaxy/admin/payouts/handle",
		"POST /api/galaxy/admin/payouts/account",
		"GET /api/galaxy/admin/prices",
		"POST /api/galaxy/admin/prices/save",
		"POST /api/galaxy/admin/prices/delete",
		"GET /api/galaxy/admin/orders",
		"GET /api/galaxy/admin/bans",
		"POST /api/galaxy/admin/bans/set",
		"GET /api/galaxy/admin/overview",
		"GET /api/galaxy/admin/dashboard",
		"GET /api/galaxy/admin/mismatches",
		"GET /api/galaxy/admin/units",
		"POST /api/galaxy/admin/units/cancel",
		"GET /api/galaxy/admin/referrals",
		"GET /api/galaxy/admin/reputations",
		"POST /api/galaxy/admin/reputations/set",
		"GET /api/galaxy/admin/ledger",
		"GET /api/galaxy/admin/settings",
		"POST /api/galaxy/admin/settings/save",
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
