// Package auth 是管理端的鉴权中间件。
//
// 它替换掉 httpx.Require* 那一套：那套认的是 service/identity 的业务账号令牌，
// 留着它，web 控制台的账号照样能进 /api/users，「独立的管理端身份」就无从谈起。
//
// 中间件挂在 /api 整组上，逐请求做三件事：验令牌 → 判这条路由的资源授权 →
// 写方法再过一道角色的 writable 开关。
package auth

import (
	"strings"
	"sync"

	"github.com/gin-gonic/gin"

	"common/middleware/httpx"
	"service/manager"
)

const (
	ContextSessionKey = "manager.session"
	// httpxUserKey 是 httpx 往 gin context 里塞 UserPrincipal 用的键（字符串字面量，
	// httpx 没有导出常量）。这里跟着塞一份，manager-api/pkg/{users,bizlines,programs}
	// 里那几处 httpx.CallerID/CurrentUser 就不用改。
	httpxUserKey = "httpx.user"
)

// publicRoutes 是不需要登录的路由，在注册路由的同时登记。
//
// 用注册函数而不是在中间件里硬编码路径字符串：路径改了、前缀变了，
// 硬编码的那份不会跟着变，表现是登录接口自己也要求登录。
var publicRoutes sync.Map

func RegisterPublic(method, path string) {
	if key := routeKey(method, path); key != "" {
		publicRoutes.Store(key, struct{}{})
	}
}

// PublicPOST / PublicGET 注册一条公开路由，并同时登记白名单。
func PublicPOST(group *gin.RouterGroup, relativePath string, handlers ...gin.HandlerFunc) {
	RegisterPublic("POST", joinPath(group.BasePath(), relativePath))
	group.POST(relativePath, handlers...)
}

func PublicGET(group *gin.RouterGroup, relativePath string, handlers ...gin.HandlerFunc) {
	RegisterPublic("GET", joinPath(group.BasePath(), relativePath))
	group.GET(relativePath, handlers...)
}

func isPublic(method, path string) bool {
	_, ok := publicRoutes.Load(routeKey(method, path))
	return ok
}

// Middleware 挂在 /api 整组上。
func Middleware(service manager.Service) gin.HandlerFunc {
	return func(context *gin.Context) {
		if context.Request.Method == "OPTIONS" {
			context.Next()
			return
		}
		// 用 FullPath()（gin 的路由模板）而不是 URL.Path：资源表里存的是模板，
		// 拿具体路径去比对的话，每个 id 都得在表里占一行。
		routePath := context.FullPath()
		if routePath == "" {
			routePath = context.Request.URL.Path
		}
		if isPublic(context.Request.Method, routePath) {
			context.Next()
			return
		}

		session, err := service.Authorize(
			context.Request.Context(), extractToken(context), context.Request.Method, routePath)
		if err != nil {
			httpx.Fail(context, err.Error())
			context.Abort()
			return
		}

		context.Set(ContextSessionKey, session)
		context.Set(httpxUserKey, httpx.UserPrincipal{
			ID:          session.UserID,
			Username:    session.Username,
			DisplayName: session.DisplayName,
			// Role 固定 admin：管理端账号本来就都是平台管理员，细分靠角色与资源，
			// 不靠这个字段。它只是喂给 httpx.IsAdmin 那几个老判断的。
			Role:               "admin",
			MustChangePassword: session.MustChangePassword,
		})
		context.Next()
	}
}

// SessionFrom 取当前会话。handler 里要用户 id 时用它，
// 而不是去解 httpx.UserPrincipal —— 那份是给老代码兼容用的投影。
func SessionFrom(context *gin.Context) (manager.Session, bool) {
	value, ok := context.Get(ContextSessionKey)
	if !ok {
		return manager.Session{}, false
	}
	session, ok := value.(manager.Session)
	return session, ok
}

// TokenFrom 取本次请求携带的令牌，登出时要用它。
func TokenFrom(context *gin.Context) string { return extractToken(context) }

func extractToken(context *gin.Context) string {
	if token := strings.TrimSpace(context.GetHeader("token")); token != "" {
		return token
	}
	if token := strings.TrimSpace(context.GetHeader("X-Token")); token != "" {
		return token
	}
	authorization := strings.TrimSpace(context.GetHeader("Authorization"))
	if authorization == "" {
		return ""
	}
	if strings.HasPrefix(strings.ToLower(authorization), "bearer ") {
		return strings.TrimSpace(authorization[7:])
	}
	return authorization
}

func routeKey(method, path string) string {
	method = strings.ToUpper(strings.TrimSpace(method))
	path = normalizePath(path)
	if method == "" || path == "" {
		return ""
	}
	return method + " " + path
}

func joinPath(basePath, relativePath string) string {
	basePath = normalizePath(basePath)
	relativePath = normalizePath(relativePath)
	switch {
	case basePath == "":
		return relativePath
	case relativePath == "":
		return basePath
	default:
		return normalizePath(basePath + relativePath)
	}
}

func normalizePath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	if len(path) > 1 {
		path = strings.TrimRight(path, "/")
	}
	return path
}
