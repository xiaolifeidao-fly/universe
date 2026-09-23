package routers

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestCORSAllowsOnlyConfiguredPWAOrigins(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(cors("https://app.example.test/, http://localhost:7894, *"))
	router.OPTIONS("/*path", func(context *gin.Context) { context.Status(http.StatusNoContent) })
	router.GET("/api/commands", func(context *gin.Context) { context.JSON(http.StatusOK, gin.H{"ok": true}) })

	preflight := httptest.NewRequest(http.MethodOptions, "/api/commands", nil)
	preflight.Header.Set("Origin", "https://app.example.test")
	preflight.Header.Set("Access-Control-Request-Method", http.MethodPost)
	preflightResponse := httptest.NewRecorder()
	router.ServeHTTP(preflightResponse, preflight)
	if preflightResponse.Code != http.StatusNoContent || preflightResponse.Header().Get("Access-Control-Allow-Origin") != "https://app.example.test" {
		t.Fatalf("允许来源的预检响应不正确：status=%d headers=%v", preflightResponse.Code, preflightResponse.Header())
	}
	if preflightResponse.Header().Get("Access-Control-Allow-Headers") != corsAllowedHeaders || preflightResponse.Header().Get("Access-Control-Allow-Methods") != corsAllowedMethods {
		t.Fatalf("预检未声明移动端所需请求头或方法：%v", preflightResponse.Header())
	}

	disallowed := httptest.NewRequest(http.MethodGet, "/api/commands", nil)
	disallowed.Header.Set("Origin", "https://untrusted.example.test")
	disallowedResponse := httptest.NewRecorder()
	router.ServeHTTP(disallowedResponse, disallowed)
	if disallowedResponse.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("未配置来源不能获得跨域授权：%v", disallowedResponse.Header())
	}
}

func TestNormalizeCORSOriginRejectsWildcardAndPaths(t *testing.T) {
	if got := normalizeCORSOrigin("https://APP.example.test/"); got != "https://app.example.test" {
		t.Fatalf("规范化来源不正确：%q", got)
	}
	for _, value := range []string{"*", "https://app.example.test/path", "file:///tmp/app", "https://user@app.example.test"} {
		if got := normalizeCORSOrigin(value); got != "" {
			t.Fatalf("不安全来源未被拒绝：%q -> %q", value, got)
		}
	}
}
