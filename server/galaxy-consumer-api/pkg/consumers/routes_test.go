package consumers

import (
	"testing"

	"github.com/gin-gonic/gin"

	"galaxy-common/auth"
)

// TestConsoleRoutesRegisterWithoutConflict 路由冲突在 gin 里是**注册期 panic**，
// 而注册发生在进程启动时 —— 没有这条测试，一次 `/jobs/cancel` 和 `/jobs/:jobId`
// 撞车要等到部署上线才发现，而且是整个进程起不来。
func TestConsoleRoutesRegisterWithoutConflict(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	handler := NewHandler(nil, auth.NewGate(nil), Options{})

	defer func() {
		if recovered := recover(); recovered != nil {
			t.Fatalf("路由注册不该 panic：%v", recovered)
		}
	}()
	handler.RegisterConsole(engine.Group("/api/galaxy"))

	want := []string{
		"GET /api/galaxy/consumer/sessions",
		"GET /api/galaxy/consumer/sessions/:sid/context",
		"POST /api/galaxy/consumer/sessions/:sid/close",
		"GET /api/galaxy/consumer/jobs",
		"GET /api/galaxy/consumer/jobs/:jobId",
		"GET /api/galaxy/consumer/jobs/:jobId/events",
		"POST /api/galaxy/consumer/jobs/:jobId/cancel",
		"GET /api/galaxy/consumer/disputes",
		"POST /api/galaxy/consumer/disputes",
		"POST /api/galaxy/consumer/disputes/:disputeId/withdraw",
		"GET /api/galaxy/consumer/catalog",
		"POST /api/galaxy/consumer/events/model-click",
		"GET /api/galaxy/consumer/points",
		"GET /api/galaxy/consumer/points/ledger",
		"GET /api/galaxy/consumer/referral",
		"GET /api/galaxy/consumer/referral/invitees",
		"POST /api/galaxy/consumer/keys",
		"POST /api/galaxy/consumer/keys/secret",
		"POST /api/galaxy/consumer/keys/renew",
		"POST /api/galaxy/consumer/keys/revoke",
	}
	// 两类路由都不该在这儿。
	//
	// 一类是运营动作：给人发密钥、充积分，都在 manager-api 的 /api/galaxy/admin/* 下，
	// 认的是管理端账号。留在这儿的话它们只能靠一个中间件把门，而 Galaxy 的账号体系里
	// 根本没有运营这种人。
	//
	// 一类是买卖：额度包已经下架，额度就是账户里的积分余额，只能由运营充进来。
	// 这一端还留着任何一条能下单、能付款的路由，就等于还能自助买到额度。
	gone := []string{
		"POST /api/galaxy/consumer/keys/issue",
		"POST /api/galaxy/consumer/points/recharge",
		"GET /api/galaxy/consumer/packages",
		"POST /api/galaxy/consumer/orders",
		"POST /api/galaxy/consumer/orders/cancel",
		"POST /api/galaxy/consumer/orders/pay/sandbox",
		"GET /api/galaxy/consumer/payments/channels",
		"POST /api/galaxy/consumer/points/purchase",
		"POST /api/galaxy/consumer/points/buy-model",
		"GET /api/galaxy/consumer/points/quote",
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
	for _, route := range gone {
		if registered[route] {
			t.Errorf("%s 是运营动作，应当在 manager-api 的 /api/galaxy/admin 下", route)
		}
	}
}
