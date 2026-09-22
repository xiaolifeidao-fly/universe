// Package console 是管理端自己的身份与权限接口：登录、当前用户、菜单、
// 账号与角色资源的后台维护。
//
// 它和 pkg/users 不是一回事：那个管的是**业务用户**（zt_identity_user，
// web 控制台和 App 的账号），这个管的是**登录管理端的人**。两套账号刻意分开。
package console

import (
	"strconv"

	"github.com/gin-gonic/gin"

	"common/middleware/httpx"
	"manager-api/auth"
	"service/manager"
	managerdto "service/manager/dto"
)

type Handler struct {
	service manager.Service
}

func NewHandler(service manager.Service) *Handler {
	return &Handler{service: service}
}

func (h *Handler) RegisterHandler(group *gin.RouterGroup) {
	// 登录是唯一的公开接口。用 PublicPOST 注册，白名单和路由同时登记 ——
	// 两处分开写的话，改了路径就会出现「登录接口自己要求登录」。
	auth.PublicPOST(group, "/auth/login", h.login)

	group.POST("/auth/logout", h.logout)
	group.GET("/auth/me", h.me)
	group.POST("/auth/password", h.changePassword)
	group.GET("/current-user-menus", h.currentMenus)

	accounts := group.Group("/manager/accounts")
	accounts.GET("", h.listAccounts)
	accounts.GET("/:userId", h.getAccount)
	accounts.POST("", h.saveAccount)
	accounts.POST("/:userId/password", h.resetPassword)
	accounts.POST("/:userId/status", h.setStatus)
	accounts.POST("/:userId/delete", h.deleteAccount)
	accounts.GET("/:userId/logins", h.loginRecords)

	roles := group.Group("/manager/roles")
	roles.GET("", h.listRoles)
	roles.POST("", h.saveRole)
	roles.POST("/:id/delete", h.deleteRole)
	roles.GET("/:id/resources", h.roleResources)
	roles.POST("/:id/resources", h.saveRoleResources)

	resources := group.Group("/manager/resources")
	resources.GET("", h.listResources)
	resources.POST("", h.saveResource)
	resources.POST("/:id/delete", h.deleteResource)
}

// ---------- 认证 ----------

func (h *Handler) login(context *gin.Context) {
	var req managerdto.LoginRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	// IP 与 UA 取自请求本身，不接受请求体传入 —— 让调用方自报等于没记，
	// 而且按来源计数的那道闸每次换一个值就绕过去了。
	//
	// 用 httpx.ClientIP 而不是 gin 的 ClientIP()：引擎 SetTrustedProxies(nil)，
	// 后者只认 RemoteAddr，而管理端前面站着 nginx —— 记下来的会永远是 nginx
	// 自己的地址，那样这一列一点线索都提供不了。
	req.IP = httpx.ClientIP(context)
	req.UserAgent = context.GetHeader("User-Agent")
	result, err := h.service.Login(context.Request.Context(), req)
	httpx.JSON(context, result, err)
}

func (h *Handler) logout(context *gin.Context) {
	err := h.service.Logout(context.Request.Context(), auth.TokenFrom(context))
	httpx.JSON(context, "ok", err)
}

func (h *Handler) me(context *gin.Context) {
	session, ok := auth.SessionFrom(context)
	if !ok {
		httpx.Fail(context, manager.ErrNotLogin.Error())
		return
	}
	view, err := h.service.CurrentUser(context.Request.Context(), session.UserID)
	httpx.JSON(context, view, err)
}

func (h *Handler) changePassword(context *gin.Context) {
	session, ok := auth.SessionFrom(context)
	if !ok {
		httpx.Fail(context, manager.ErrNotLogin.Error())
		return
	}
	var req managerdto.ChangePasswordRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	err := h.service.ChangeOwnPassword(context.Request.Context(), session.UserID, req)
	httpx.JSON(context, "ok", err)
}

func (h *Handler) currentMenus(context *gin.Context) {
	session, ok := auth.SessionFrom(context)
	if !ok {
		httpx.Fail(context, manager.ErrNotLogin.Error())
		return
	}
	views, err := h.service.CurrentMenus(context.Request.Context(), session.UserID)
	httpx.JSON(context, views, err)
}

// ---------- 账号 ----------

func (h *Handler) listAccounts(context *gin.Context) {
	var query managerdto.AccountQuery
	if err := context.ShouldBindQuery(&query); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	page, err := h.service.ListAccounts(context.Request.Context(), query)
	httpx.JSON(context, page, err)
}

func (h *Handler) getAccount(context *gin.Context) {
	view, err := h.service.GetAccount(context.Request.Context(), context.Param("userId"))
	httpx.JSON(context, view, err)
}

func (h *Handler) saveAccount(context *gin.Context) {
	var req managerdto.SaveAccountRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	view, err := h.service.SaveAccount(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) resetPassword(context *gin.Context) {
	var req managerdto.ResetPasswordRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	// 以路径上的 id 为准，不信请求体：两者不一致时按请求体走等于允许改任意账号的密码。
	req.UserID = context.Param("userId")
	err := h.service.ResetPassword(context.Request.Context(), req)
	httpx.JSON(context, req.UserID, err)
}

func (h *Handler) setStatus(context *gin.Context) {
	var req struct {
		Status string `json:"status" binding:"required"`
	}
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	userID := context.Param("userId")
	err := h.service.SetAccountStatus(context.Request.Context(), userID, req.Status)
	httpx.JSON(context, userID, err)
}

func (h *Handler) deleteAccount(context *gin.Context) {
	userID := context.Param("userId")
	// 不许删自己：删完之后这个人还握着一个指向不存在账号的会话，
	// 而且如果他是最后一个超级管理员，谁也进不来了。
	if session, ok := auth.SessionFrom(context); ok && session.UserID == userID {
		httpx.Fail(context, "不能删除当前登录的账号")
		return
	}
	err := h.service.DeleteAccount(context.Request.Context(), userID)
	httpx.JSON(context, userID, err)
}

func (h *Handler) loginRecords(context *gin.Context) {
	limit, _ := strconv.Atoi(context.DefaultQuery("limit", "50"))
	views, err := h.service.ListLoginRecords(context.Request.Context(), context.Param("userId"), limit)
	httpx.JSON(context, views, err)
}

// ---------- 角色与资源 ----------

func (h *Handler) listRoles(context *gin.Context) {
	views, err := h.service.ListRoles(context.Request.Context())
	httpx.JSON(context, views, err)
}

func (h *Handler) saveRole(context *gin.Context) {
	var req managerdto.SaveRoleRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	view, err := h.service.SaveRole(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) deleteRole(context *gin.Context) {
	id, ok := pathID(context)
	if !ok {
		return
	}
	httpx.JSON(context, id, h.service.DeleteRole(context.Request.Context(), id))
}

func (h *Handler) roleResources(context *gin.Context) {
	id, ok := pathID(context)
	if !ok {
		return
	}
	ids, err := h.service.ListRoleResourceIDs(context.Request.Context(), id)
	httpx.JSON(context, ids, err)
}

func (h *Handler) saveRoleResources(context *gin.Context) {
	id, ok := pathID(context)
	if !ok {
		return
	}
	var req managerdto.SaveRoleResourceRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	req.RoleID = id
	httpx.JSON(context, id, h.service.SaveRoleResources(context.Request.Context(), req))
}

func (h *Handler) listResources(context *gin.Context) {
	views, err := h.service.ListResources(context.Request.Context(), context.Query("resourceType"))
	httpx.JSON(context, views, err)
}

func (h *Handler) saveResource(context *gin.Context) {
	var req managerdto.SaveResourceRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	view, err := h.service.SaveResource(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) deleteResource(context *gin.Context) {
	id, ok := pathID(context)
	if !ok {
		return
	}
	httpx.JSON(context, id, h.service.DeleteResource(context.Request.Context(), id))
}

func pathID(context *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(context.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		httpx.Fail(context, "id 必须是正整数")
		return 0, false
	}
	return id, true
}
