package consumers

import (
	"net/http"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// TestConsoleRoutesRegisterWithoutConflict 路由冲突在 gin 里是**注册期 panic**，
// 而注册发生在进程启动时 —— 没有这条测试，一次 `/jobs/cancel` 和 `/jobs/:jobId`
// 撞车要等到部署上线才发现，而且是整个进程起不来。
func TestConsoleRoutesRegisterWithoutConflict(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	handler := NewHandler(nil)

	defer func() {
		if recovered := recover(); recovered != nil {
			t.Fatalf("路由注册不该 panic：%v", recovered)
		}
	}()
	handler.RegisterConsole(engine.Group("/api/galaxy"))
	handler.RegisterNative(engine.Group("/v1"))

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
		// 静态的 /orders/pay/sandbox 和管理员那条 /orders/pay 同层，注册期不能打架。
		"POST /api/galaxy/consumer/orders/pay",
		"POST /api/galaxy/consumer/orders/pay/sandbox",
	}
	// 商品目录已经挪去 /api/galaxy/admin/*。留在这儿的话，一个运营动作会
	// 继续挂在消费者路由组上，只靠一个中间件把门。
	gone := []string{"POST /api/galaxy/consumer/packages/save"}
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
			t.Errorf("%s 应当已经挪去 /api/galaxy/admin", route)
		}
	}
}

// TestPaymentCallbackNotRegisteredWithoutVerifier 没接支付渠道时那条路由必须
// 压根不存在。注册了但不验签的回调，等于把「发额度」挂在公网上让人随便调。
func TestPaymentCallbackNotRegisteredWithoutVerifier(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	NewHandler(paymentDisabled{}).RegisterCallbacks(engine.Group("/galaxy"))

	for _, route := range engine.Routes() {
		if strings.Contains(route.Path, "/payments/") {
			t.Fatalf("未接支付渠道时不该注册 %s %s", route.Method, route.Path)
		}
	}
}

func TestPaymentCallbackRegisteredWhenEnabled(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	NewHandler(paymentEnabled{}).RegisterCallbacks(engine.Group("/galaxy"))

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
