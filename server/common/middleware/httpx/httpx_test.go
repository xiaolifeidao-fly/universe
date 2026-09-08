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

// TestRequirePlatformAdminIgnoresProductResearchPersona pins the one difference
// between RequirePlatformAdmin and RequireAdmin. Without it, a platform admin
// who is not a product-research user cannot resolve a compute-pool dispute or
// ban a node — the only console that can act on the pool would be closed to
// exactly the people who run it.
func TestRequirePlatformAdminIgnoresProductResearchPersona(t *testing.T) {
	SetUserAuthenticator(testAuthenticator{principal: UserPrincipal{ID: "1", Role: "admin"}})
	defer SetUserAuthenticator(nil)

	engine := gin.New()
	engine.POST("/api/galaxy/admin/disputes/resolve", RequirePlatformAdmin(),
		func(context *gin.Context) { JSON(context, "ok", nil) })
	engine.POST("/api/system/users", RequireAdmin(),
		func(context *gin.Context) { JSON(context, "ok", nil) })

	platform := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/galaxy/admin/disputes/resolve", nil)
	request.Header.Set("token", "valid")
	engine.ServeHTTP(platform, request)
	if !containsResponse(platform.Body.String(), `"success":true`) {
		t.Fatalf("平台管理员应当能裁决工单，实际 %s", platform.Body.String())
	}

	// RequireAdmin 的身份门仍在，这条测试同时钉住「没顺手把它拆掉」。
	delivery := httptest.NewRecorder()
	deliveryRequest := httptest.NewRequest(http.MethodPost, "/api/system/users", nil)
	deliveryRequest.Header.Set("token", "valid")
	engine.ServeHTTP(delivery, deliveryRequest)
	if !containsResponse(delivery.Body.String(), "当前登录身份不是产品产研") {
		t.Fatalf("RequireAdmin 的产研身份门不该被拆掉，实际 %s", delivery.Body.String())
	}
}

// TestRequirePlatformAdminStillRequiresAdminRole 平台门只放宽身份，不放宽角色。
func TestRequirePlatformAdminStillRequiresAdminRole(t *testing.T) {
	SetUserAuthenticator(testAuthenticator{principal: UserPrincipal{ID: "2", Role: "member"}})
	defer SetUserAuthenticator(nil)

	engine := gin.New()
	engine.POST("/api/galaxy/admin/disputes/resolve", RequirePlatformAdmin(),
		func(context *gin.Context) { JSON(context, "ok", nil) })

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/galaxy/admin/disputes/resolve", nil)
	request.Header.Set("token", "valid")
	engine.ServeHTTP(recorder, request)
	if !containsResponse(recorder.Body.String(), "无权执行平台管理操作") {
		t.Fatalf("普通成员不该能裁决工单，实际 %s", recorder.Body.String())
	}
}
