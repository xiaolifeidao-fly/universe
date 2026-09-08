package auth_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"manager-api/auth"
	"service/manager"
)

// stubService 只实现中间件真正会调的那一个方法。嵌一个 nil 接口而不是把
// 二十多个方法抄一遍：真被调到就是空指针崩，那正是我们想要的信号 ——
// 说明中间件碰了不该碰的东西。
type stubService struct {
	manager.Service
	authorize func(token, method, path string) (manager.Session, error)
}

func (s stubService) Authorize(_ context.Context, token, method, path string) (manager.Session, error) {
	return s.authorize(token, method, path)
}

func newEngine(t *testing.T, service manager.Service) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	api := engine.Group("/api", auth.Middleware(service))
	auth.PublicPOST(api, "/auth/login", func(context *gin.Context) { context.String(http.StatusOK, "login") })
	api.GET("/users", func(context *gin.Context) { context.String(http.StatusOK, "users") })
	api.GET("/users/:id", func(context *gin.Context) {
		session, _ := auth.SessionFrom(context)
		context.String(http.StatusOK, session.UserID)
	})
	return engine
}

func call(engine *gin.Engine, method, path, token string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(method, path, nil)
	if token != "" {
		request.Header.Set("token", token)
	}
	engine.ServeHTTP(recorder, request)
	return recorder
}

// TestLoginIsPublic 登录接口自己不能要求登录。
// 白名单和路由是一起注册的（PublicPOST），这条钉住那个注册确实生效。
func TestLoginIsPublic(t *testing.T) {
	engine := newEngine(t, stubService{authorize: func(string, string, string) (manager.Session, error) {
		t.Fatal("公开路由不该走鉴权")
		return manager.Session{}, nil
	}})
	if body := call(engine, http.MethodPost, "/api/auth/login", "").Body.String(); body != "login" {
		t.Fatalf("登录接口应当放行，实际 %q", body)
	}
}

// TestMissingTokenIsRejected 没令牌一律拒。
func TestMissingTokenIsRejected(t *testing.T) {
	engine := newEngine(t, stubService{authorize: func(token, _, _ string) (manager.Session, error) {
		if token != "" {
			t.Fatalf("不该拿到令牌，实际 %q", token)
		}
		return manager.Session{}, manager.ErrNotLogin
	}})
	body := call(engine, http.MethodGet, "/api/users", "").Body.String()
	if !strings.Contains(body, "登录凭证") {
		t.Fatalf("响应里要带「登录凭证」，前端才会清 token 跳登录页，实际 %s", body)
	}
	if strings.Contains(body, "\"success\":true") {
		t.Fatalf("被拒的请求不该是成功响应：%s", body)
	}
}

// TestAuthorizeReceivesRouteTemplate 中间件必须把 gin 的**路由模板**交给领域层。
//
// 传具体路径（/api/users/7）的话，资源表里就得为每个 id 存一行 ——
// 这是整套接口级鉴权能不能落地的前提。
func TestAuthorizeReceivesRouteTemplate(t *testing.T) {
	var gotMethod, gotPath string
	engine := newEngine(t, stubService{authorize: func(_, method, path string) (manager.Session, error) {
		gotMethod, gotPath = method, path
		return manager.Session{UserID: "mu_1"}, nil
	}})
	recorder := call(engine, http.MethodGet, "/api/users/7", "t")
	if gotMethod != http.MethodGet || gotPath != "/api/users/:id" {
		t.Fatalf("领域层应当收到路由模板，实际 %s %s", gotMethod, gotPath)
	}
	if recorder.Body.String() != "mu_1" {
		t.Fatalf("会话应当能从 context 里取到，实际 %q", recorder.Body.String())
	}
}

// TestPrincipalIsMirroredForLegacyHandlers 老 handler 里那几处 httpx.CallerID
// 靠这份投影继续工作。少了它，users/bizlines/programs 的审计字段会变成
// httpx 的兜底值 "local-console"，看起来像是有人用本地控制台改了数据。
func TestPrincipalIsMirroredForLegacyHandlers(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	api := engine.Group("/api", auth.Middleware(stubService{
		authorize: func(string, string, string) (manager.Session, error) {
			return manager.Session{UserID: "mu_9", Username: "ops"}, nil
		},
	}))
	api.GET("/whoami", func(context *gin.Context) {
		context.String(http.StatusOK, httpxCallerID(context))
	})
	if body := call(engine, http.MethodGet, "/api/whoami", "t").Body.String(); body != "mu_9" {
		t.Fatalf("httpx.CallerID 应当拿到管理端用户 id，实际 %q", body)
	}
}

// TestTokenAcceptedFromBearer 三种头都认。前端用 token 头，
// 用命令行调接口的人习惯 Authorization: Bearer。
func TestTokenAcceptedFromBearer(t *testing.T) {
	var got string
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	api := engine.Group("/api", auth.Middleware(stubService{
		authorize: func(token, _, _ string) (manager.Session, error) {
			got = token
			return manager.Session{UserID: "mu_1"}, nil
		},
	}))
	api.GET("/users", func(context *gin.Context) { context.Status(http.StatusOK) })

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/users", nil)
	request.Header.Set("Authorization", "Bearer abc123")
	engine.ServeHTTP(recorder, request)
	if got != "abc123" {
		t.Fatalf("应当从 Bearer 里取出令牌，实际 %q", got)
	}
}
