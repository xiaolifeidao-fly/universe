package consumers

import (
	"net/http"
	"strings"
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
		"GET /api/galaxy/consumer/payments/channels",
		"POST /api/galaxy/consumer/orders/pay/sandbox",
		"GET /api/galaxy/consumer/catalog",
		"GET /api/galaxy/consumer/points",
		"GET /api/galaxy/consumer/points/ledger",
		"POST /api/galaxy/consumer/points/purchase",
		"GET /api/galaxy/consumer/referral",
		"GET /api/galaxy/consumer/referral/invitees",
		"POST /api/galaxy/consumer/keys/secret",
	}
	// 运营动作一律不挂在使用端路由组上：商品目录、给人发密钥、人工确认到账都在
	// manager-api 的 /api/galaxy/admin/* 下，认的是管理端账号。留在这儿的话，
	// 它们只能靠一个中间件把门，而 Galaxy 的账号体系里根本没有运营这种人。
	gone := []string{
		"POST /api/galaxy/consumer/packages/save",
		"POST /api/galaxy/consumer/keys/issue",
		"POST /api/galaxy/consumer/orders/pay",
		// 充积分是运营动作，使用端只能花。
		"POST /api/galaxy/consumer/points/recharge",
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

// TestPaymentCallbackNotRegisteredWithoutVerifier 没接支付渠道时那条路由必须
// 压根不存在。注册了但不验签的回调，等于把「发额度」挂在公网上让人随便调。
func TestPaymentCallbackNotRegisteredWithoutVerifier(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	NewHandler(paymentDisabled{}, auth.NewGate(nil), Options{}).RegisterCallbacks(engine.Group("/galaxy"))

	for _, route := range engine.Routes() {
		if strings.Contains(route.Path, "/payments/") {
			t.Fatalf("未接支付渠道时不该注册 %s %s", route.Method, route.Path)
		}
	}
}

func TestPaymentCallbackRegisteredWhenEnabled(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	NewHandler(paymentEnabled{}, auth.NewGate(nil), Options{}).RegisterCallbacks(engine.Group("/galaxy"))

	found := false
	for _, route := range engine.Routes() {
		if route.Method == http.MethodPost && route.Path == "/galaxy/payments/:channel/callback" {
			found = true
		}
	}
	if !found {
		t.Fatal("接了支付渠道就该有回调路由")
	}
}
