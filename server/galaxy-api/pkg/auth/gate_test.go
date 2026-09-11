package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"service/galaxy/account"
	"service/galaxy/dto"
)

// stubAccounts 按令牌字面量回答。只模拟 Authenticate 的三种结果：认得、凭证失效、库挂了。
type stubAccounts map[string]account.Principal

func (s stubAccounts) Authenticate(_ context.Context, side, token string) (account.Principal, error) {
	if token == "db-down" {
		return account.Principal{}, errors.New("dial tcp: connection refused")
	}
	principal, ok := s[token]
	if !ok || principal.Side != side {
		return account.Principal{}, account.ErrNotLogin
	}
	return principal, nil
}

type envelope struct {
	Success bool   `json:"success"`
	Error   string `json:"error"`
	Data    string `json:"data"`
}

func serve(t *testing.T, gate *Gate, method, path, token string) envelope {
	t.Helper()
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	console := engine.Group("/api/galaxy")
	echo := func(context *gin.Context) {
		context.JSON(http.StatusOK, gin.H{"success": true, "data": UserID(context)})
	}
	console.GET("/provider/nodes", gate.Provider(), echo)
	console.GET("/provider/auth/me", gate.Provider(), echo)
	console.GET("/consumer/keys", gate.Consumer(), echo)

	request := httptest.NewRequest(method, path, nil)
	if token != "" {
		request.Header.Set("token", token)
	}
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)
	var body envelope
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是 JSON：%s", recorder.Body.String())
	}
	return body
}

func TestGateSeparatesSides(t *testing.T) {
	gate := NewGate(stubAccounts{
		"nova-token":  {UserID: "pu_1", Side: dto.SideProvider, Username: "fly"},
		"orbit-token": {UserID: "cu_1", Side: dto.SideConsumer, Username: "fly"},
	})

	if body := serve(t, gate, http.MethodGet, "/api/galaxy/provider/nodes", "nova-token"); !body.Success || body.Data != "pu_1" {
		t.Fatalf("共享端令牌调共享端接口：%+v", body)
	}
	// 同一个人在使用端的令牌，调共享端的接口就是没登录。
	if body := serve(t, gate, http.MethodGet, "/api/galaxy/provider/nodes", "orbit-token"); body.Success || body.Error != notLogin {
		t.Fatalf("使用端令牌调共享端接口应当 not login：%+v", body)
	}
	if body := serve(t, gate, http.MethodGet, "/api/galaxy/consumer/keys", "nova-token"); body.Success || body.Error != notLogin {
		t.Fatalf("共享端令牌调使用端接口应当 not login：%+v", body)
	}
	if body := serve(t, gate, http.MethodGet, "/api/galaxy/consumer/keys", ""); body.Success || body.Error != notLogin {
		t.Fatalf("不带令牌应当 not login：%+v", body)
	}
}

// TestGateDoesNotLogOutOnInfraError 查库失败不能回 not login：客户端看到那四个字会清令牌，
// 数据库抖一下就把所有人踢回登录页。
func TestGateDoesNotLogOutOnInfraError(t *testing.T) {
	body := serve(t, NewGate(stubAccounts{}), http.MethodGet, "/api/galaxy/provider/nodes", "db-down")
	if body.Success || body.Error == notLogin {
		t.Fatalf("基础设施错误不该被说成没登录：%+v", body)
	}
}

// TestGateHoldsMustChangePassword 运营重置过密码的人，改掉之前只能看自己、改密码。
func TestGateHoldsMustChangePassword(t *testing.T) {
	gate := NewGate(stubAccounts{
		"reset-token": {UserID: "pu_2", Side: dto.SideProvider, MustChangePassword: true},
	})
	if body := serve(t, gate, http.MethodGet, "/api/galaxy/provider/nodes", "reset-token"); body.Success {
		t.Fatalf("没改临时密码就调业务接口应当被拦：%+v", body)
	}
	if body := serve(t, gate, http.MethodGet, "/api/galaxy/provider/auth/me", "reset-token"); !body.Success || body.Data != "pu_2" {
		t.Fatalf("没改临时密码也要能看自己是谁：%+v", body)
	}
}

func TestUserIDEmptyWithoutGate(t *testing.T) {
	gin.SetMode(gin.TestMode)
	context, _ := gin.CreateTestContext(httptest.NewRecorder())
	context.Request = httptest.NewRequest(http.MethodGet, "/", nil)
	context.Request.Header.Set("X-User-ID", "pu_someone")
	if got := UserID(context); got != "" {
		t.Fatalf("没挂门时 UserID 必须是空串，拿到了 %q", got)
	}
}
