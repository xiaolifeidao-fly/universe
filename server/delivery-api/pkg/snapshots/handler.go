// Package snapshots 每日进度快照与趋势。
package snapshots

import (
	"common/middleware/httpx"
	"common/middleware/routers"

	"contract"
	"service/delivery"
	deliverydto "service/delivery/dto"

	"github.com/gin-gonic/gin"
)

type Handler struct{ service delivery.Service }

func NewHandler(service delivery.Service) *Handler { return &Handler{service: service} }

func (h *Handler) RegisterHandler(group *gin.RouterGroup) {
	// 落快照是同步链路里的内部动作（将来由定时作业调），不是人点的按钮 → RequireService。
	group.POST("/delivery/snapshot/rebuild", httpx.RequireService(), h.rebuild)
	group.GET("/delivery/snapshots", httpx.RequireUserOrService(), h.list)
}

func (h *Handler) rebuild(context *gin.Context) {
	var req deliverydto.RebuildSnapshotRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	var bizLine contract.BizLine
	if !h.resolveProgramBizLine(context, req.ProgramID, &bizLine) {
		return
	}
	req.BizLine = bizLine
	views, err := h.service.RebuildSnapshot(context.Request.Context(), req)
	httpx.JSON(context, views, err)
}

func (h *Handler) list(context *gin.Context) {
	var query deliverydto.SnapshotQuery
	if err := context.ShouldBindQuery(&query); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	var bizLine contract.BizLine
	if !h.resolveProgramBizLine(context, query.ProgramID, &bizLine) {
		return
	}
	query.BizLine = bizLine
	views, err := h.service.ListSnapshots(context.Request.Context(), query)
	httpx.JSON(context, views, err)
}

func (h *Handler) resolveProgramBizLine(context *gin.Context, programID int64, target *contract.BizLine) bool {
	bizLine, err := h.service.ResolveProgramBizLine(context.Request.Context(), programID)
	if err != nil {
		httpx.JSON(context, nil, err)
		return false
	}
	if err := httpx.AuthorizeBizLine(context, bizLine.String()); err != nil {
		httpx.JSON(context, nil, err)
		return false
	}
	if err := httpx.AuthorizeProgramInBizLine(context, bizLine.String(), programID); err != nil {
		httpx.JSON(context, nil, err)
		return false
	}
	*target = bizLine
	return true
}

var _ routers.Handler = (*Handler)(nil)
