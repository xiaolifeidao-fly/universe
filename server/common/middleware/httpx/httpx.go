package httpx

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"common/middleware/db"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// config 是 Boot 读到的配置快照，供 Property 读取。
//
// 进程启动时读一次即可：配置文件在容器里是只读的，改配置走的是重新发布。
var config map[string]string

// UserPrincipal is the authenticated console identity carried by a request.
// The identity domain owns token validation and assignment loading; httpx only
// consumes this narrow shape so common does not depend on a business module.
type UserPrincipal struct {
	ID                 string
	Username           string
	DisplayName        string
	Role               string
	MustChangePassword bool
	BizLines           []string
	ProgramIDs         []int64
	Service            bool
}

// UserAuthenticator is injected by the aggregate application's composition
// root after it constructs the identity service.
type UserAuthenticator interface {
	AuthenticateToken(context.Context, string) (UserPrincipal, error)
}

var (
	authenticatorMu sync.RWMutex
	authenticator   UserAuthenticator
)

func SetUserAuthenticator(value UserAuthenticator) {
	authenticatorMu.Lock()
	defer authenticatorMu.Unlock()
	authenticator = value
}

const DefaultBizLine = "whatsapp"

// Property 读取 application.properties 里的一项配置。必须在 Boot 之后调用。
//
// 装配层用它拿外部依赖的凭证（如 llm.api_key）——
// 领域包一律不读配置，它们只认注入进来的实现。
func Property(key string) string { return config[key] }

// Boot opens the shared database once for the local aggregate process.
func Boot(_ string) *gorm.DB {
	values, err := properties("configs/application.properties")
	if err != nil {
		panic(fmt.Errorf("load application.properties: %w", err))
	}
	config = values
	dsn := strings.TrimSpace(values["sqlconn"])
	if dsn == "" {
		panic("sqlconn is required")
	}
	database, err := gorm.Open(mysql.Open(dsn), &gorm.Config{
		DisableForeignKeyConstraintWhenMigrating: true,
		Logger:                                   logger.Default.LogMode(logger.Error),
	})
	if err != nil {
		panic(fmt.Errorf("connect database: %w", err))
	}

	// 连接池必须设上限。database/sql 的默认值是 MaxOpenConns=0（无上限）、
	// MaxIdleConns=2 —— 归因这类扫历史数据的离线作业一跑，连接数会一路涨到
	// MySQL 的 max_connections，此时同步链路上的 /risk/gate/check 拿不到新连接
	// 是直接建连接失败，不是排队等待，下发会中断。
	pool, err := database.DB()
	if err != nil {
		panic(fmt.Errorf("database pool: %w", err))
	}
	pool.SetMaxOpenConns(50)
	pool.SetMaxIdleConns(10)
	pool.SetConnMaxLifetime(30 * time.Minute)

	db.SetDatabase(database)
	return database
}

func RequireUser() gin.HandlerFunc {
	return func(ginContext *gin.Context) {
		if !authenticateUser(ginContext) {
			return
		}
		if !requireChangedPassword(ginContext) {
			return
		}
		ginContext.Next()
	}
}

func RequireAdmin() gin.HandlerFunc {
	return func(ginContext *gin.Context) {
		if !authenticateUser(ginContext) {
			return
		}
		if !requireChangedPassword(ginContext) {
			return
		}
		if !IsAdmin(ginContext) {
			Fail(ginContext, "无权执行系统设置操作")
			ginContext.Abort()
			return
		}
		ginContext.Next()
	}
}

func RequireService() gin.HandlerFunc {
	return func(ginContext *gin.Context) {
		if !authenticateService(ginContext) {
			Fail(ginContext, "服务凭证无效")
			ginContext.Abort()
			return
		}
		ginContext.Next()
	}
}

func RequireDevice() gin.HandlerFunc {
	return func(ginContext *gin.Context) {
		// Device credentials are not part of the current management plane yet.
		// Keep this endpoint closed rather than treating arbitrary traffic as a device.
		Fail(ginContext, "设备凭证无效")
		ginContext.Abort()
	}
}

func RequireUserOrService() gin.HandlerFunc {
	return func(ginContext *gin.Context) {
		if authenticateService(ginContext) {
			ginContext.Next()
			return
		}
		if authenticateUser(ginContext) && requireChangedPassword(ginContext) {
			ginContext.Next()
		}
	}
}

func requireChangedPassword(ginContext *gin.Context) bool {
	principal, ok := CurrentUser(ginContext)
	if !ok || !principal.MustChangePassword || ginContext.FullPath() == "/api/auth/me" || ginContext.FullPath() == "/api/auth/password" {
		return true
	}
	Fail(ginContext, "请先修改初始密码")
	ginContext.Abort()
	return false
}

func authenticateUser(ginContext *gin.Context) bool {
	token := strings.TrimSpace(ginContext.GetHeader("token"))
	if token == "" {
		token = strings.TrimSpace(strings.TrimPrefix(ginContext.GetHeader("Authorization"), "Bearer "))
	}
	if token == "" {
		Fail(ginContext, "not login")
		ginContext.Abort()
		return false
	}

	authenticatorMu.RLock()
	value := authenticator
	authenticatorMu.RUnlock()
	if value == nil {
		Fail(ginContext, "认证服务尚未初始化")
		ginContext.Abort()
		return false
	}
	principal, err := value.AuthenticateToken(ginContext.Request.Context(), token)
	if err != nil {
		Fail(ginContext, "not login")
		ginContext.Abort()
		return false
	}
	ginContext.Set("httpx.user", principal)
	return true
}

func authenticateService(ginContext *gin.Context) bool {
	want := strings.TrimSpace(Property("auth.service_token"))
	got := strings.TrimSpace(ginContext.GetHeader("X-Service-Token"))
	if want == "" || got == "" || got != want {
		return false
	}
	ginContext.Set("httpx.user", UserPrincipal{ID: "service", Username: "service", DisplayName: "Service", Role: "service", Service: true})
	return true
}

func CurrentUser(ginContext *gin.Context) (UserPrincipal, bool) {
	value, ok := ginContext.Get("httpx.user")
	if !ok {
		return UserPrincipal{}, false
	}
	principal, ok := value.(UserPrincipal)
	return principal, ok
}

func IsAdmin(ginContext *gin.Context) bool {
	principal, ok := CurrentUser(ginContext)
	return ok && principal.Role == "admin"
}

func AuthorizeBizLine(ginContext *gin.Context, bizLine string) error {
	principal, ok := CurrentUser(ginContext)
	if !ok {
		return errors.New("not login")
	}
	if principal.Service || principal.Role == "admin" || contains(principal.BizLines, bizLine) {
		return nil
	}
	return errors.New("无权访问该业务线")
}

func AuthorizeProgram(ginContext *gin.Context, programID int64) error {
	principal, ok := CurrentUser(ginContext)
	if !ok {
		return errors.New("not login")
	}
	if principal.Service || principal.Role == "admin" || containsProgramID(principal.ProgramIDs, programID) {
		return nil
	}
	return errors.New("无权访问该项目")
}

func CanAccessBizLine(ginContext *gin.Context, bizLine string) bool {
	return AuthorizeBizLine(ginContext, bizLine) == nil
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func containsProgramID(values []int64, wanted int64) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func BizLine(context *gin.Context) string {
	if value := strings.TrimSpace(context.Query("bizLine")); value != "" {
		return value
	}
	if value := strings.TrimSpace(context.GetHeader("X-Biz-Line")); value != "" {
		return value
	}
	return DefaultBizLine
}

func CallerID(context *gin.Context) string {
	if principal, ok := CurrentUser(context); ok && principal.ID != "" {
		return principal.ID
	}
	if value := context.GetHeader("X-User-ID"); value != "" {
		return value
	}
	return "local-console"
}

func CallerName(context *gin.Context) string {
	if principal, ok := CurrentUser(context); ok && principal.DisplayName != "" {
		return principal.DisplayName
	}
	return CallerID(context)
}

func JSON(context *gin.Context, data any, err error) {
	if err != nil {
		context.JSON(http.StatusOK, gin.H{"success": false, "code": -1, "data": nil, "message": "请求失败", "error": err.Error()})
		return
	}
	context.JSON(http.StatusOK, gin.H{"success": true, "code": 0, "data": data, "message": "请求成功", "error": nil})
}

func Fail(context *gin.Context, message string) {
	context.JSON(http.StatusOK, gin.H{"success": false, "code": -1, "data": nil, "message": "请求失败", "error": message})
}

func properties(path string) (map[string]string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	values := make(map[string]string)
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if ok {
			values[strings.TrimSpace(key)] = strings.TrimSpace(value)
		}
	}
	return values, scanner.Err()
}
