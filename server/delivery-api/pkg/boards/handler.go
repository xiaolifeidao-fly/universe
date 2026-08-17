// Package boards 看板视图与项目概览。
package boards

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
	// 纯只读：控制台要看，将来的周报作业也要看。
	api := group.Group("/delivery", httpx.RequireUserOrService())
	api.GET("/board", h.board)
	api.GET("/overview", h.overview)
}

func (h *Handler) board(context *gin.Context) {
	var query deliverydto.BoardQuery
	if err := context.ShouldBindQuery(&query); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	var bizLine contract.BizLine
	if !h.resolveProgramBizLine(context, query.ProgramID, &bizLine) {
		return
	}
	query.BizLine = bizLine
	view, err := h.service.Board(context.Request.Context(), query)
	httpx.JSON(context, view, err)
}

func (h *Handler) overview(context *gin.Context) {
	programID, ok := programIDFromQuery(context)
	if !ok {
		return
	}
	var bizLine contract.BizLine
	if !h.resolveProgramBizLine(context, programID, &bizLine) {
		return
	}
	view, err := h.service.Overview(context.Request.Context(), bizLine, programID)
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
