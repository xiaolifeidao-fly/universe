// Package users is manager-api's controller layer for system-wide account
// management. Like pkg/auth, it has no service/repository/dto of its own —
// service/identity already owns the user table and every operation this
// package exposes (ListUsers/GetUser/SaveUser/ResetPassword/DeleteUser).
// This mirrors delivery-api/pkg/identity/handler.go's admin routes, just
// under manager-api's own path scheme and gated by the manager-api/auth middleware
// for every route (this is a system-admin console, not the per-space
// self-service console web-api serves).
package users

import (
	"strconv"

	"common/middleware/httpx"
	"common/middleware/routers"
	"service/identity"
	identitydto "service/identity/dto"

	"github.com/gin-gonic/gin"
)

type Handler struct {
	identities identity.Service
}

func NewHandler(identityService identity.Service) *Handler {
	return &Handler{identities: identityService}
}

func (h *Handler) RegisterHandler(group *gin.RouterGroup) {
	// 鉴权在 /api 整组上的 manager-api/auth 中间件里做，按 (method, 路由模板)
	// 查资源授权。这里不再挂 httpx.Require* —— 那套认的是 service/identity 的
	// 业务账号令牌，留着它 web 控制台的账号照样进得来。
	admin := group.Group("/users")
	admin.GET("", h.list)
	admin.GET("/:id", h.get)
	admin.POST("", h.save)
	admin.POST("/:id", h.save)
	admin.POST("/:id/password", h.resetPassword)
	admin.POST("/:id/delete", h.delete)
}

func (h *Handler) list(context *gin.Context) {
	var query identitydto.UserQuery
	if err := context.ShouldBindQuery(&query); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	page, err := h.identities.ListUsers(context.Request.Context(), query)
	httpx.JSON(context, page, err)
}

func (h *Handler) get(context *gin.Context) {
	id, err := strconv.ParseInt(context.Param("id"), 10, 64)
	if err != nil {
		httpx.Fail(context, "用户标识无效")
		return
	}
	view, err := h.identities.GetUser(context.Request.Context(), id)
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
	view, err := h.identities.SaveUser(context.Request.Context(), req)
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
	httpx.JSON(context, nil, h.identities.ResetPassword(context.Request.Context(), req))
}

func (h *Handler) delete(context *gin.Context) {
	id, err := strconv.ParseInt(context.Param("id"), 10, 64)
	if err != nil {
		httpx.Fail(context, "用户标识无效")
		return
	}
	httpx.JSON(context, nil, h.identities.DeleteUser(context.Request.Context(), id, httpx.CallerID(context)))
}

var _ routers.Handler = (*Handler)(nil)
