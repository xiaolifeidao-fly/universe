// Package identity exposes login and administrator-only account management.
package identity

import (
	"strconv"

	"common/middleware/httpx"
	"common/middleware/routers"
	"service/identity"
	identitydto "service/identity/dto"

	"github.com/gin-gonic/gin"
)

type Handler struct{ service identity.Service }

func NewHandler(service identity.Service) *Handler { return &Handler{service: service} }

func (h *Handler) RegisterHandler(group *gin.RouterGroup) {
	group.POST("/auth/login", h.login)
	user := group.Group("/auth", httpx.RequireUser())
	user.GET("/me", h.me)
	user.GET("/members", h.members)
	user.POST("/password", h.changeOwnPassword)

	admin := group.Group("/system/users", httpx.RequireAdmin())
	admin.GET("", h.list)
	admin.GET("/:id", h.get)
	admin.POST("", h.save)
	admin.POST("/:id", h.save)
	admin.POST("/:id/password", h.resetPassword)
	admin.POST("/:id/delete", h.delete)
}

func (h *Handler) login(context *gin.Context) {
	var req identitydto.LoginRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	result, err := h.service.Login(context.Request.Context(), req)
	httpx.JSON(context, result, err)
}

func (h *Handler) me(context *gin.Context) {
	principal, _ := httpx.CurrentUser(context)
	id, err := strconv.ParseInt(principal.ID, 10, 64)
	if err != nil {
		httpx.JSON(context, nil, err)
		return
	}
	view, err := h.service.CurrentUser(context.Request.Context(), id)
	httpx.JSON(context, view, err)
}

// members 是选人控件的数据源：任何登录用户都能列出在职同事的标识和显示名。
func (h *Handler) members(context *gin.Context) {
	var query identitydto.MemberQuery
	if err := context.ShouldBindQuery(&query); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	members, err := h.service.ListMembers(context.Request.Context(), query)
	httpx.JSON(context, members, err)
}

func (h *Handler) changeOwnPassword(context *gin.Context) {
	principal, _ := httpx.CurrentUser(context)
	id, err := strconv.ParseInt(principal.ID, 10, 64)
	if err != nil {
		httpx.Fail(context, "用户标识无效")
		return
	}
	var req identitydto.ChangeOwnPasswordRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	result, err := h.service.ChangeOwnPassword(context.Request.Context(), id, req)
	httpx.JSON(context, result, err)
}

func (h *Handler) list(context *gin.Context) {
	var query identitydto.UserQuery
	if err := context.ShouldBindQuery(&query); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	page, err := h.service.ListUsers(context.Request.Context(), query)
	httpx.JSON(context, page, err)
}

func (h *Handler) get(context *gin.Context) {
	id, err := strconv.ParseInt(context.Param("id"), 10, 64)
	if err != nil {
		httpx.Fail(context, "用户标识无效")
		return
	}
	view, err := h.service.GetUser(context.Request.Context(), id)
	httpx.JSON(context, view, err)
}

func (h *Handler) save(context *gin.Context) {
	var req identitydto.SaveUserRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if rawID := context.Param("id"); rawID != "" {
		id, err := strconv.ParseInt(rawID, 10, 64)
		if err != nil {
			httpx.Fail(context, "用户标识无效")
			return
		}
		req.ID = id
	}
	req.ActorID = httpx.CallerID(context)
	view, err := h.service.SaveUser(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) resetPassword(context *gin.Context) {
	id, err := strconv.ParseInt(context.Param("id"), 10, 64)
	if err != nil {
		httpx.Fail(context, "用户标识无效")
		return
	}
	var req identitydto.ResetPasswordRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	req.UserID = id
	req.ActorID = httpx.CallerID(context)
	httpx.JSON(context, nil, h.service.ResetPassword(context.Request.Context(), req))
}

func (h *Handler) delete(context *gin.Context) {
	id, err := strconv.ParseInt(context.Param("id"), 10, 64)
	if err != nil {
		httpx.Fail(context, "用户标识无效")
		return
	}
	httpx.JSON(context, nil, h.service.DeleteUser(context.Request.Context(), id, httpx.CallerID(context)))
}

var _ routers.Handler = (*Handler)(nil)
