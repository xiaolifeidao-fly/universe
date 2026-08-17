// Package items 推进任务的增删改查与时间线。
package items

import (
	"errors"
	"strconv"

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
	// 推进任务是人维护的配置，写一律 RequireUser —— 机器不该改路线图。
	api := group.Group("/delivery", httpx.RequireUser())
	api.POST("/item/create", h.create)
	api.POST("/item/patch", h.patch)
	api.POST("/item/phase/advance", h.advancePhase)
	api.POST("/item/delete", h.delete)
	api.POST("/item/comment", h.comment)
	api.POST("/item/execution-session/bind", h.bindExecutionSession)
	api.POST("/item/execution-session/status", h.updateExecutionSessionStatus)
	api.POST("/item/testing-cases/save", h.updateTestingCases)

	group.GET("/delivery/items", httpx.RequireUserOrService(), h.list)
	group.GET("/delivery/item", httpx.RequireUserOrService(), h.get)
	group.GET("/delivery/item/events", httpx.RequireUserOrService(), h.events)
	group.GET("/delivery/item/execution-session", httpx.RequireUserOrService(), h.listExecutionSessions)
}

func (h *Handler) advancePhase(context *gin.Context) {
	var req deliverydto.AdvancePhaseRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, req.ProgramID, &req.BizLine) {
		return
	}
	req.ActorID = httpx.CallerID(context)
	views, err := h.service.AdvancePhase(context.Request.Context(), req)
	httpx.JSON(context, views, err)
}

func (h *Handler) list(context *gin.Context) {
	var query deliverydto.ItemQuery
	if err := context.ShouldBindQuery(&query); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, query.ProgramID, &query.BizLine) {
		return
	}
	page, err := h.service.ListItems(context.Request.Context(), query)
	httpx.JSON(context, page, err)
}

func (h *Handler) get(context *gin.Context) {
	programID, ok := programIDFromQuery(context)
	if !ok {
		return
	}
	var bizLine contract.BizLine
	if !h.resolveProgramBizLine(context, programID, &bizLine) {
		return
	}
	view, err := h.service.GetItem(context.Request.Context(), bizLine, programID, context.Query("itemKey"))
	httpx.JSON(context, view, err)
}

func (h *Handler) create(context *gin.Context) {
	var req deliverydto.SaveItemRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, req.ProgramID, &req.BizLine) {
		return
	}
	req.ActorID = httpx.CallerID(context)
	view, err := h.service.CreateItem(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

// patch 单条局部更新，请求体必须带 version —— 拖一张卡片只发 status + version。
func (h *Handler) patch(context *gin.Context) {
	var req deliverydto.PatchItemRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, req.ProgramID, &req.BizLine) {
		return
	}
	req.ActorID = httpx.CallerID(context)
	view, err := h.service.PatchItem(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) delete(context *gin.Context) {
	var req deliverydto.DeleteItemRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, req.ProgramID, &req.BizLine) {
		return
	}
	req.ActorID = httpx.CallerID(context)
	httpx.JSON(context, nil, h.service.DeleteItem(context.Request.Context(), req))
}

func (h *Handler) comment(context *gin.Context) {
	var req deliverydto.CommentRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, req.ProgramID, &req.BizLine) {
		return
	}
	req.ActorID = httpx.CallerID(context)
	httpx.JSON(context, nil, h.service.Comment(context.Request.Context(), req))
}

func (h *Handler) events(context *gin.Context) {
	var query deliverydto.EventQuery
	if err := context.ShouldBindQuery(&query); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, query.ProgramID, &query.BizLine) {
		return
	}
	page, err := h.service.ListEvents(context.Request.Context(), query)
	httpx.JSON(context, page, err)
}

func (h *Handler) bindExecutionSession(context *gin.Context) {
	var req deliverydto.BindExecutionSessionRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, req.ProgramID, &req.BizLine) {
		return
	}
	req.ActorID = httpx.CallerID(context)
	view, err := h.service.BindExecutionSession(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) listExecutionSessions(context *gin.Context) {
	var query deliverydto.ExecutionSessionQuery
	if err := context.ShouldBindQuery(&query); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, query.ProgramID, &query.BizLine) {
		return
	}
	views, err := h.service.ListExecutionSessions(context.Request.Context(), query)
	httpx.JSON(context, views, err)
}

func (h *Handler) updateExecutionSessionStatus(context *gin.Context) {
	var req deliverydto.UpdateExecutionSessionStatusRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, req.ProgramID, &req.BizLine) {
		return
	}
	req.ActorID = httpx.CallerID(context)
	view, err := h.service.UpdateExecutionSessionStatus(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) updateTestingCases(context *gin.Context) {
	var req deliverydto.UpdateItemTestingCasesRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, req.ProgramID, &req.BizLine) {
		return
	}
	req.ActorID = httpx.CallerID(context)
	view, err := h.service.UpdateItemTestingCases(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func programIDFromQuery(context *gin.Context) (int64, bool) {
	programID, err := strconv.ParseInt(context.Query("programId"), 10, 64)
	if err != nil || programID <= 0 {
		httpx.JSON(context, nil, errors.New("缺少项目标识"))
		return 0, false
	}
	return programID, true
}

// 项目是全局唯一的业务键，项目范围操作始终以项目归属为准，不信任客户端携带的业务线。
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
	if err := httpx.AuthorizeProgram(context, programID); err != nil {
		httpx.JSON(context, nil, err)
		return false
	}
	*target = bizLine
	return true
}

var _ routers.Handler = (*Handler)(nil)
