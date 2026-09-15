// Package auth 是 Galaxy 控制台的登录入口与门禁。
//
// 账号是 Galaxy 自己的（service/galaxy/account），和任务宇宙的 service/identity 无关。
// 这个进程里没有 identity，也不调 httpx.SetUserAuthenticator —— httpx.RequireUser()
// 在这里调不通，控制台路由一律挂本包的 Gate。
//
// 登录按端分两组，端写在路径里，和各端业务接口同一个前缀：
//
//	/api/galaxy/provider/auth/*   共享端（Nova）
//	/api/galaxy/consumer/auth/*   使用端（Orbit）
//
// 两端是两批人：同一个用户名在两端可以各是一个账号，一端的令牌调不了另一端。
package auth

import (
	"github.com/gin-gonic/gin"

	"common/middleware/httpx"
	"common/middleware/routers"
	"service/galaxy/account"
	"service/galaxy/dto"
)

type Handler struct {
	accounts account.Service
	gate     *Gate
}

func NewHandler(accounts account.Service, gate *Gate) *Handler {
	return &Handler{accounts: accounts, gate: gate}
}

// RegisterHandler 挂在 /api/galaxy 上。
//
// me 和 password 两条的路径不能随手改：Gate 认它们是「必须改密码的人也走得通」的例外，
// 挪了位置，被运营重置过密码的账号就会被自己的临时密码锁死 —— 改不了，也进不去。
func (h *Handler) RegisterHandler(console *gin.RouterGroup) {
	h.RegisterSide(console, dto.SideProvider)
	h.RegisterSide(console, dto.SideConsumer)
}

// RegisterSide 只暴露当前服务所属端的账号入口。
func (h *Handler) RegisterSide(console *gin.RouterGroup, side string) {
	public := console.Group("/" + side + "/auth")
	public.POST("/register", h.register(side))
	public.POST("/login", h.login(side))

	self := console.Group("/"+side+"/auth", h.gate.Require(side))
	self.GET("/me", h.me)
	self.POST("/password", h.changePassword)
}

func (h *Handler) register(side string) gin.HandlerFunc {
	return func(context *gin.Context) {
		var req dto.RegisterAccountRequest
		if err := context.ShouldBindJSON(&req); err != nil {
			httpx.Fail(context, "请求格式不对")
			return
		}
		req.Side = side
		result, err := h.accounts.Register(context.Request.Context(), req)
		httpx.JSON(context, result, err)
	}
}

func (h *Handler) login(side string) gin.HandlerFunc {
	return func(context *gin.Context) {
		var req dto.LoginAccountRequest
		if err := context.ShouldBindJSON(&req); err != nil {
			httpx.Fail(context, "请求格式不对")
			return
		}
		req.Side = side
		result, err := h.accounts.Login(context.Request.Context(), req)
		httpx.JSON(context, result, err)
	}
}

// me 每次都从库里读：运营把人改成工作室、停用、重置密码，控制台要看得到最新的样子，
// 而登录时存在浏览器里的那份是登录那一刻的快照。
func (h *Handler) me(context *gin.Context) {
	view, err := h.accounts.Current(context.Request.Context(), Side(context), UserID(context))
	httpx.JSON(context, view, err)
}

func (h *Handler) changePassword(context *gin.Context) {
	var req dto.ChangeAccountPasswordRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, "请求格式不对")
		return
	}
	result, err := h.accounts.ChangeOwnPassword(context.Request.Context(), Side(context), UserID(context), req)
	httpx.JSON(context, result, err)
}

var _ routers.Handler = (*Handler)(nil)
