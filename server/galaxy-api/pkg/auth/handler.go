// Package auth 是 galaxy-api 的控制台登录入口。
//
// 它没有自己的 service/repository/dto：账号体系（凭据、令牌、用户记录）
// 已经在 service/identity 里，web-api、app-api、manager-api 共用同一套。
// 共享池控制台再造一份会把 user 表劈成两套互不认识的账号，
// 而设计里写明的是「复用现有用户体系」——这里只把 HTTP 绑上去。
//
// 令牌与另外三个服务互通，前提是各自 configs 里的 auth.token_secret 一致。
package auth

import (
	"strconv"

	"github.com/gin-gonic/gin"

	"common/middleware/httpx"
	"common/middleware/routers"
	"service/identity"
	identitydto "service/identity/dto"
)

type Handler struct {
	identities identity.Service
}

func NewHandler(identityService identity.Service) *Handler {
	return &Handler{identities: identityService}
}

// 路径必须是 /api/auth/login、/api/auth/me、/api/auth/password，一个字都不能改：
// common/middleware/httpx 的 requireChangedPassword 把后两条完整路径硬编码成
// 「没改初始密码也放行」的例外，其余接口一律拦到密码改掉为止。
// 少了 /auth/password，mustChangePassword=true 的账号会被自己的初始密码锁死——
// 改不了密码，也进不去任何控制台接口。
//
// 注意这组路由挂在 /api 上，不是 /api/galaxy：控制台业务面才在 /api/galaxy 下，
// 登录是跨服务共用的账号入口，路径与另外三个服务保持一致。
func (h *Handler) RegisterHandler(group *gin.RouterGroup) {
	group.POST("/auth/login", h.login)
	authorized := group.Group("/auth", httpx.RequireUser())
	authorized.GET("/me", h.me)
	authorized.POST("/password", h.changeOwnPassword)
}

func (h *Handler) login(context *gin.Context) {
	var request identitydto.LoginRequest
	if err := context.ShouldBindJSON(&request); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	result, err := h.identities.Login(context.Request.Context(), request)
	httpx.JSON(context, result, err)
}

func (h *Handler) me(context *gin.Context) {
	principal, _ := httpx.CurrentUser(context)
	id, err := strconv.ParseInt(principal.ID, 10, 64)
	if err != nil {
		httpx.Fail(context, "用户标识无效")
		return
	}
	view, err := h.identities.CurrentUser(context.Request.Context(), id)
	httpx.JSON(context, view, err)
}

func (h *Handler) changeOwnPassword(context *gin.Context) {
	principal, _ := httpx.CurrentUser(context)
	id, err := strconv.ParseInt(principal.ID, 10, 64)
	if err != nil {
		httpx.Fail(context, "用户标识无效")
		return
	}
	var request identitydto.ChangeOwnPasswordRequest
	if err := context.ShouldBindJSON(&request); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	result, err := h.identities.ChangeOwnPassword(context.Request.Context(), id, request)
	httpx.JSON(context, result, err)
}

var _ routers.Handler = (*Handler)(nil)
