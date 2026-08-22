// Package executionbatches exposes persisted grouped execution lifecycle APIs.
package executionbatches

import (
	"common/middleware/httpx"
	"common/middleware/routers"
	"strings"

	"contract"
	"delivery-api/pkg/boards"
	"service/delivery"
	deliverydto "service/delivery/dto"

	"github.com/gin-gonic/gin"
)

type Handler struct{ service delivery.Service }

func NewHandler(service delivery.Service) *Handler { return &Handler{service: service} }

func (h *Handler) RegisterHandler(group *gin.RouterGroup) {
	api := group.Group("/delivery", httpx.RequireUser())
	api.POST("/execution-batch/create", h.create)
	api.POST("/execution-batch/item/status", h.updateItem)
	api.POST("/execution-batch/finalize", h.finalize)
	api.POST("/execution-batch/notification/read", h.markNotificationRead)
	api.GET("/execution-batch", h.get)
	api.GET("/execution-batch/notifications", h.listNotifications)
}

func (h *Handler) get(context *gin.Context) {
	programID, ok := boards.ProgramIDFromQuery(context)
	if !ok {
		return
	}
	var bizLine contract.BizLine
	if !h.resolveProgramBizLine(context, programID, &bizLine) {
		return
	}
	batchID := strings.TrimSpace(context.Query("batchId"))
	view, err := h.service.GetExecutionBatch(context.Request.Context(), bizLine, programID, batchID)
	httpx.JSON(context, view, err)
}

func (h *Handler) create(context *gin.Context) {
	var req deliverydto.CreateExecutionBatchRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveManagedProgramBizLine(context, req.ProgramID, &req.BizLine) {
		return
	}
	req.ActorID = httpx.CallerID(context)
	view, err := h.service.CreateExecutionBatch(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) updateItem(context *gin.Context) {
	var req deliverydto.UpdateExecutionBatchItemRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveManagedProgramBizLine(context, req.ProgramID, &req.BizLine) {
		return
	}
	req.ActorID = httpx.CallerID(context)
	view, err := h.service.UpdateExecutionBatchItem(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) finalize(context *gin.Context) {
	var req deliverydto.FinalizeExecutionBatchRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveManagedProgramBizLine(context, req.ProgramID, &req.BizLine) {
		return
	}
	req.ActorID = httpx.CallerID(context)
	view, err := h.service.FinalizeExecutionBatch(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) listNotifications(context *gin.Context) {
	programID, ok := boards.ProgramIDFromQuery(context)
	if !ok {
		return
	}
	var bizLine contract.BizLine
	if !h.resolveProgramBizLine(context, programID, &bizLine) {
		return
	}
	views, err := h.service.ListExecutionBatchNotifications(context.Request.Context(), deliverydto.ExecutionBatchNotificationQuery{
		BizLine: bizLine, ProgramID: programID, ActorID: httpx.CallerID(context),
	})
	httpx.JSON(context, views, err)
}

func (h *Handler) markNotificationRead(context *gin.Context) {
	var req deliverydto.MarkExecutionBatchNotificationReadRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, req.ProgramID, &req.BizLine) {
		return
	}
	req.ActorID = httpx.CallerID(context)
	view, err := h.service.MarkExecutionBatchNotificationRead(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) resolveProgramBizLine(context *gin.Context, programID int64, target *contract.BizLine) bool {
	bizLine, err := h.service.ResolveProgramBizLine(context.Request.Context(), programID)
	if err != nil {
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

func (h *Handler) resolveManagedProgramBizLine(context *gin.Context, programID int64, target *contract.BizLine) bool {
	if !h.resolveProgramBizLine(context, programID, target) {
		return false
	}
	if !httpx.CanAdministerProgram(context, target.String(), programID) {
		httpx.Fail(context, "无权管理该项目")
		return false
	}
	return true
}

var _ routers.Handler = (*Handler)(nil)
