package httpx

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

type testAuthenticator struct{ principal UserPrincipal }

func (a testAuthenticator) AuthenticateToken(context.Context, string) (UserPrincipal, error) {
	if a.principal.ID == "" {
		return UserPrincipal{}, errors.New("invalid")
	}
	return a.principal, nil
}

func TestBizLineDefaultsWhenRequestOmitsIt(t *testing.T) {
	context, _ := gin.CreateTestContext(httptest.NewRecorder())
	context.Request = httptest.NewRequest(http.MethodGet, "/delivery/programs", nil)

	if got := BizLine(context); got != DefaultBizLine {
		t.Fatalf("BizLine() = %q, want %q", got, DefaultBizLine)
	}
}

func TestBizLineUsesExplicitNonBlankValue(t *testing.T) {
	context, _ := gin.CreateTestContext(httptest.NewRecorder())
	request := httptest.NewRequest(http.MethodGet, "/delivery/programs?bizLine=%20tiktok%20", nil)
	request.Header.Set("X-Biz-Line", "whatsapp")
	context.Request = request

	if got := BizLine(context); got != "tiktok" {
		t.Fatalf("BizLine() = %q, want tiktok", got)
	}
}

func TestRequireUserBlocksInitialPasswordUntilPasswordEndpoint(t *testing.T) {
	SetUserAuthenticator(testAuthenticator{principal: UserPrincipal{ID: "1", MustChangePassword: true}})
	defer SetUserAuthenticator(nil)

	engine := gin.New()
	engine.GET("/api/delivery/programs", RequireUser(), func(context *gin.Context) { JSON(context, "ok", nil) })
	engine.POST("/api/auth/password", RequireUser(), func(context *gin.Context) { JSON(context, "ok", nil) })

	blocked := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/delivery/programs", nil)
	request.Header.Set("token", "valid")
	engine.ServeHTTP(blocked, request)
	if blocked.Code != http.StatusOK || !containsResponse(blocked.Body.String(), "请先修改初始密码") {
		t.Fatalf("expected password-change block, got %s", blocked.Body.String())
	}

	allowed := httptest.NewRecorder()
	passwordRequest := httptest.NewRequest(http.MethodPost, "/api/auth/password", nil)
	passwordRequest.Header.Set("token", "valid")
	engine.ServeHTTP(allowed, passwordRequest)
	if allowed.Code != http.StatusOK || !containsResponse(allowed.Body.String(), `"success":true`) {
		t.Fatalf("expected password endpoint to be allowed, got %s", allowed.Body.String())
	}
}

func containsResponse(value, wanted string) bool { return strings.Contains(value, wanted) }
