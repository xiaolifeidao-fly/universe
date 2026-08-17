// Package bizlines 提供业务线选择与管理接口。
package bizlines

import (
	"common/middleware/httpx"
	"common/middleware/routers"

	"service/bizline"
	bizlinedto "service/bizline/dto"

	"github.com/gin-gonic/gin"
)

type Handler struct{ service bizline.Service }

func NewHandler(service bizline.Service) *Handler { return &Handler{service: service} }

func (h *Handler) RegisterHandler(group *gin.RouterGroup) {
	group.GET("/bizline/lines", httpx.RequireUserOrService(), h.list)
	api := group.Group("/bizline", httpx.RequireAdmin())
	api.GET("/lines/all", h.listAll)
	api.POST("/line/save", h.save)
	api.POST("/line/delete", h.delete)
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
	httpx.JSON(context, views, err)
}

func (h *Handler) save(context *gin.Context) {
	var req bizlinedto.SaveBizLineRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
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
	httpx.JSON(context, nil, h.service.Delete(context.Request.Context(), req))
}

var _ routers.Handler = (*Handler)(nil)
