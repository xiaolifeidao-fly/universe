// Package bizlines 提供业务线选择与管理接口。
package bizlines

import (
	"common/middleware/httpx"
	"common/middleware/routers"

	"service/bizline"
	bizlinedto "service/bizline/dto"
	"service/identity"
	identitydto "service/identity/dto"

	"github.com/gin-gonic/gin"
)

type Handler struct {
	service    bizline.Service
	identities identity.Service
}

func NewHandler(service bizline.Service, identities identity.Service) *Handler {
	return &Handler{service: service, identities: identities}
}

func (h *Handler) RegisterHandler(group *gin.RouterGroup) {
	group.GET("/bizline/lines", httpx.RequireUserOrService(), h.list)
	api := group.Group("/bizline", httpx.RequireUser())
	api.GET("/lines/all", h.listAll)
	api.POST("/line/save", h.save)
	api.POST("/line/delete", h.delete)
	api.GET("/line/assignment", h.assignment)
	api.POST("/line/assignment", h.saveAssignment)
}

func (h *Handler) list(context *gin.Context) {
	views, err := h.service.List(context.Request.Context())
	if err == nil && !httpx.IsAdmin(context) {
		filtered := views[:0]
		for _, view := range views {
			if httpx.CanAccessBizLine(context, view.Code) {
				filtered = append(filtered, view)
			}
		}
		views = filtered
	}
	httpx.JSON(context, views, err)
}

func (h *Handler) listAll(context *gin.Context) {
	views, err := h.service.ListAll(context.Request.Context())
	if err == nil && !httpx.IsAdmin(context) {
		views = filterAccessible(context, views)
	}
	httpx.JSON(context, views, err)
}

func (h *Handler) save(context *gin.Context) {
	var req bizlinedto.SaveBizLineRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !httpx.IsAdmin(context) && !httpx.CanManageBizLine(context, req.Code) {
		httpx.Fail(context, "无权修改该业务线")
		return
	}
	httpx.JSON(context, nil, h.service.Save(context.Request.Context(), req))
}

func (h *Handler) delete(context *gin.Context) {
	var req bizlinedto.DeleteBizLineRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !httpx.IsAdmin(context) {
		httpx.Fail(context, "无权删除业务线")
		return
	}
	httpx.JSON(context, nil, h.service.Delete(context.Request.Context(), req))
}

func (h *Handler) assignment(context *gin.Context) {
	bizLine := context.Query("bizLine")
	if err := httpx.AuthorizeBizLine(context, bizLine); err != nil {
		httpx.JSON(context, nil, err)
		return
	}
	assignment, err := h.identities.ListBizLineAssignment(context.Request.Context(), bizLine)
	httpx.JSON(context, assignment, err)
}

func (h *Handler) saveAssignment(context *gin.Context) {
	var req struct {
		BizLine string `json:"bizLine"`
		identitydto.ScopeAssignment
	}
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !httpx.CanManageBizLine(context, req.BizLine) {
		httpx.Fail(context, "无权分配该业务线人员")
		return
	}
	if !httpx.IsAdmin(context) {
		current, err := h.identities.ListBizLineAssignment(context.Request.Context(), req.BizLine)
		if err != nil {
			httpx.JSON(context, nil, err)
			return
		}
		req.ManagerIDs = current.ManagerIDs
	}
	httpx.JSON(context, nil, h.identities.ReplaceBizLineAssignment(context.Request.Context(), req.BizLine, req.ScopeAssignment))
}

func filterAccessible(context *gin.Context, views []bizlinedto.BizLineView) []bizlinedto.BizLineView {
	filtered := views[:0]
	for _, view := range views {
		if httpx.CanAccessBizLine(context, view.Code) {
			filtered = append(filtered, view)
		}
	}
	return filtered
}

var _ routers.Handler = (*Handler)(nil)
