// Package identity exposes login and administrator-only account management.
package identity

import (
	"errors"
	"strconv"
	"strings"

	"common/middleware/httpx"
	"common/middleware/routers"
	"service/bizline"
	bizlinedto "service/bizline/dto"
	"service/identity"
	identitydto "service/identity/dto"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type Handler struct {
	service  identity.Service
	bizLines bizline.Service
}

func NewHandler(service identity.Service, bizLines bizline.Service) *Handler {
	return &Handler{service: service, bizLines: bizLines}
}

func (h *Handler) RegisterHandler(group *gin.RouterGroup) {
	group.POST("/auth/login", h.login)
	group.POST("/auth/register", h.register)
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

// register 自助注册：先建账号；同名空间不存在时再建专属空间，并将注册人设为管理员。
// 已有同名空间不改变其成员或管理权限。创建空间或授权失败时回收刚建出来的账号。
func (h *Handler) register(context *gin.Context) {
	var req identitydto.RegisterRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	result, err := h.service.Register(context.Request.Context(), req)
	if err != nil {
		httpx.JSON(context, nil, err)
		return
	}
	code := result.User.Username
	if _, err := h.bizLines.Get(context.Request.Context(), code); err == nil {
		httpx.JSON(context, result, nil)
		return
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		_ = h.service.DeleteUser(context.Request.Context(), result.User.ID, "")
		httpx.JSON(context, nil, err)
		return
	}
	spaceName := strings.TrimSpace(result.User.DisplayName)
	if spaceName == "" {
		spaceName = code
	}
	if err := h.bizLines.Register(context.Request.Context(), bizlinedto.RegisterRequest{Code: code, Name: spaceName}); err != nil {
		_ = h.service.DeleteUser(context.Request.Context(), result.User.ID, "")
		httpx.JSON(context, nil, err)
		return
	}
	assignment := identitydto.ScopeAssignment{UserIDs: []int64{result.User.ID}, ManagerIDs: []int64{result.User.ID}}
	if err := h.service.ReplaceBizLineAssignment(context.Request.Context(), code, assignment); err != nil {
		_ = h.service.DeleteUser(context.Request.Context(), result.User.ID, "")
		httpx.JSON(context, nil, err)
		return
	}
	view, err := h.service.CurrentUser(context.Request.Context(), result.User.ID)
	if err != nil {
		httpx.JSON(context, nil, err)
		return
	}
	result.User = view
	httpx.JSON(context, result, nil)
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
