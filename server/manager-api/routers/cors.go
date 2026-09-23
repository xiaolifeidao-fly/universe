package routers

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/gin-gonic/gin"
)

// 和 app-api/routers/cors.go 是同一份实现（复制，不是 import——两个模块各自独立
// 部署，都需要自己能编译，这段代码本身没有业务逻辑，改动风险低，先不抽 shared）。
const corsAllowedHeaders = "Authorization, Content-Type, token, X-Biz-Line"
const corsAllowedMethods = "GET, POST, PUT, DELETE, OPTIONS"

// cors restricts cross-origin manager console requests to deployment-configured
// origins. manager-api accepts bearer-like headers, so a wildcard origin is
// never safe here.
func cors(origins string) gin.HandlerFunc {
	allowed := parseCORSOrigins(origins)
	return func(context *gin.Context) {
		origin := normalizeCORSOrigin(context.GetHeader("Origin"))
		if _, ok := allowed[origin]; ok {
			context.Header("Access-Control-Allow-Origin", origin)
			context.Writer.Header().Add("Vary", "Origin")
			if context.Request.Method == http.MethodOptions {
				context.Header("Access-Control-Allow-Headers", corsAllowedHeaders)
				context.Header("Access-Control-Allow-Methods", corsAllowedMethods)
				context.Header("Access-Control-Max-Age", "600")
				context.Status(http.StatusNoContent)
				context.Abort()
				return
			}
		}
		context.Next()
	}
}

func parseCORSOrigins(raw string) map[string]struct{} {
	allowed := make(map[string]struct{})
	for _, candidate := range strings.Split(raw, ",") {
		if origin := normalizeCORSOrigin(candidate); origin != "" {
			allowed[origin] = struct{}{}
		}
	}
	return allowed
}

func normalizeCORSOrigin(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" || value == "*" {
		return ""
	}
	parsed, err := url.ParseRequestURI(value)
	if err != nil || parsed.User != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return ""
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return ""
	}
	return strings.ToLower(parsed.Scheme) + "://" + strings.ToLower(parsed.Host)
}
