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

func TestBizLineIsEmptyWhenRequestOmitsIt(t *testing.T) {
	context, _ := gin.CreateTestContext(httptest.NewRecorder())
	context.Request = httptest.NewRequest(http.MethodGet, "/delivery/programs", nil)

	if got := BizLine(context); got != "" {
		t.Fatalf("BizLine() = %q, want empty", got)
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

func TestProjectScopePermissions(t *testing.T) {
	tests := []struct {
		name              string
		principal         UserPrincipal
		wantAccess        bool
		wantManageBiz     bool
		wantManageProgram bool
	}{
		{
			name: "business line manager inherits access and management for every project in the line",
			principal: UserPrincipal{
				ID:              "1",
				ManagedBizLines: []string{"whatsapp"},
			},
			wantAccess:        true,
			wantManageBiz:     true,
			wantManageProgram: true,
		},
		{
			name: "project manager can only manage the assigned project",
			principal: UserPrincipal{
				ID:                "2",
				ManagedProgramIDs: []int64{42},
			},
			wantAccess:        true,
			wantManageBiz:     false,
			wantManageProgram: true,
		},
		{
			name: "ordinary project member can view but cannot manage the project",
			principal: UserPrincipal{
				ID:         "3",
				BizLines:   []string{"whatsapp"},
				ProgramIDs: []int64{42},
			},
			wantAccess:        true,
			wantManageBiz:     false,
			wantManageProgram: false,
		},
		{
			name: "project manager cannot access or manage another project",
			principal: UserPrincipal{
				ID:                "4",
				ManagedProgramIDs: []int64{99},
			},
			wantAccess:        false,
			wantManageBiz:     false,
			wantManageProgram: false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ginContext, _ := gin.CreateTestContext(httptest.NewRecorder())
			ginContext.Set("httpx.user", test.principal)

			gotAccess := AuthorizeProgramInBizLine(ginContext, "whatsapp", 42) == nil
			if gotAccess != test.wantAccess {
				t.Fatalf("AuthorizeProgramInBizLine() access = %t, want %t", gotAccess, test.wantAccess)
			}
			if got := CanManageBizLine(ginContext, "whatsapp"); got != test.wantManageBiz {
				t.Fatalf("CanManageBizLine() = %t, want %t", got, test.wantManageBiz)
			}
			if got := CanAdministerProgram(ginContext, "whatsapp", 42); got != test.wantManageProgram {
				t.Fatalf("CanAdministerProgram() = %t, want %t", got, test.wantManageProgram)
			}
		})
	}
}

func containsResponse(value, wanted string) bool { return strings.Contains(value, wanted) }
