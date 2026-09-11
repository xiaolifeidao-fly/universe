package portal

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"service/galaxy"
	"service/galaxy/dto"
)

// stubService 只实现门户用到的两个方法，其余全靠嵌入的接口 ——
// 调到没实现的方法会 panic，那正是我们想要的：门户面多碰一个方法，
// 这里就会红，而不是悄悄多暴露一份数据。
type stubService struct {
	galaxy.Service
	catalog  dto.PortalOverview
	catalogs int
	leads    []dto.SubmitLeadRequest
}

func (s *stubService) PortalCatalog(context.Context, []string) (dto.PortalOverview, error) {
	s.catalogs++
	return s.catalog, nil
}

func (s *stubService) SubmitLead(_ context.Context, req dto.SubmitLeadRequest) (dto.LeadView, error) {
	s.leads = append(s.leads, req)
	return dto.LeadView{LeadID: "lead-1"}, nil
}

func newEngine(service galaxy.Service, options Options) *gin.Engine {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	NewHandler(service, options).RegisterHandler(engine.Group("/api/galaxy"))
	return engine
}

// TestPortalRoutesRegisterWithoutConflict 路由冲突在 gin 里是注册期 panic，
// 而注册发生在进程启动时 —— 撞车要等到部署上线才发现，且整个进程起不来。
func TestPortalRoutesRegisterWithoutConflict(t *testing.T) {
	defer func() {
		if recovered := recover(); recovered != nil {
			t.Fatalf("路由注册不该 panic：%v", recovered)
		}
	}()
	engine := newEngine(&stubService{}, Options{})

	want := []string{
		"GET /api/galaxy/portal/overview",
		"GET /api/galaxy/portal/models",
		"GET /api/galaxy/portal/pricing",
		"POST /api/galaxy/portal/leads",
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
	// 门户面**一条**带鉴权的路由都不该有，也不该多出别的路径 ——
	// 公开前缀下面多一条接口，就是多一条不需要身份就能读的通道。
	if len(engine.Routes()) != len(want) {
		t.Errorf("门户面只应有 %d 条路由，实际 %d 条", len(want), len(engine.Routes()))
	}
}

// TestOverviewCachesWithinTTL 公开地址直通数据库是压测通道。缓存生效期内
// 打多少次都只查一次。
func TestOverviewCachesWithinTTL(t *testing.T) {
	service := &stubService{catalog: dto.PortalOverview{Endpoint: "https://example.test/v1"}}
	engine := newEngine(service, Options{})

	for index := 0; index < 3; index++ {
		recorder := httptest.NewRecorder()
		engine.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/galaxy/portal/overview", nil))
		if recorder.Code != http.StatusOK {
			t.Fatalf("状态码 %d", recorder.Code)
		}
	}
	if service.catalogs != 1 {
		t.Errorf("TTL 内应只查一次库，实际 %d 次", service.catalogs)
	}
}

// TestSubmitLeadTakesForwardedIP 限流键必须取代理链的第一跳。
//
// 这套部署前面站着 nginx、门户自己还有一层 Next.js 代理，取 RemoteAddr 的话
// 所有来访者共用一个额度 —— 第六个人开始就再也提交不了了。
func TestSubmitLeadTakesForwardedIP(t *testing.T) {
	service := &stubService{}
	engine := newEngine(service, Options{})

	request := httptest.NewRequest(http.MethodPost, "/api/galaxy/portal/leads",
		strings.NewReader(`{"contact":"someone@example.test"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Forwarded-For", "203.0.113.9, 10.0.0.1")
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)

	if len(service.leads) != 1 {
		t.Fatalf("应写入一条线索，实际 %d 条", len(service.leads))
	}
	if service.leads[0].IP != "203.0.113.9" {
		t.Errorf("限流键应取第一跳，实际 %q", service.leads[0].IP)
	}
}

// TestJunkLeadsDoNotBurnTheHourlyCap 蜜罐命中和空联系方式都不写库，
// 所以它们一格额度都不该消耗。
//
// 之前是先扣额度再判这两样：60 个 {"contact":"","website":"x"} 就能把
// 「联系我们」关掉一小时，而且因为一行都没写，库里那道按 IP 的闸完全看不见这个人。
func TestJunkLeadsDoNotBurnTheHourlyCap(t *testing.T) {
	service := &stubService{}
	engine := newEngine(service, Options{LeadsPerHour: 2})

	post := func(body string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/galaxy/portal/leads", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		recorder := httptest.NewRecorder()
		engine.ServeHTTP(recorder, request)
		return recorder
	}

	// 蜜罐 + 空联系方式各来一打，额度一格都不该动。
	for index := 0; index < 12; index++ {
		post(`{"contact":"someone@example.test","website":"http://spam.test"}`)
		post(`{"contact":"   "}`)
	}

	// 额度还是满的：两条真留言都要收下。
	for index := 0; index < 2; index++ {
		var envelope struct {
			Success bool `json:"success"`
		}
		body := post(`{"contact":"someone@example.test"}`).Body.String()
		if err := json.Unmarshal([]byte(body), &envelope); err != nil {
			t.Fatalf("响应不是统一信封：%v", err)
		}
		if !envelope.Success {
			t.Fatalf("第 %d 条真留言被垃圾请求挤掉了：%s", index+1, body)
		}
	}
}

// TestSubmitLeadStopsAtHourlyCap 整站上限是「有人换着 IP 刷」的兜底闸。
// 按 IP 那道在库里，这里只验进程内这一道会关。
func TestSubmitLeadStopsAtHourlyCap(t *testing.T) {
	service := &stubService{}
	engine := newEngine(service, Options{LeadsPerHour: 2})

	var lastBody string
	for index := 0; index < 3; index++ {
		request := httptest.NewRequest(http.MethodPost, "/api/galaxy/portal/leads",
			strings.NewReader(`{"contact":"someone@example.test"}`))
		request.Header.Set("Content-Type", "application/json")
		recorder := httptest.NewRecorder()
		engine.ServeHTTP(recorder, request)
		lastBody = recorder.Body.String()
	}
	if len(service.leads) != 2 {
		t.Errorf("超过上限之后不该再写库，实际写入 %d 条", len(service.leads))
	}
	var envelope struct {
		Success bool `json:"success"`
	}
	if err := json.Unmarshal([]byte(lastBody), &envelope); err != nil {
		t.Fatalf("响应不是统一信封：%v", err)
	}
	if envelope.Success {
		t.Error("被限流的那次应该返回失败")
	}
}
