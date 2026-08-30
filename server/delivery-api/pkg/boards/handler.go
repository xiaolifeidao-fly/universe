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
	api := group.Group("/delivery", httpx.RequireProductResearchOrService())
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

// ProgramIDFromQuery is shared by delivery read handlers that use the same program scope.
func ProgramIDFromQuery(context *gin.Context) (int64, bool) {
	programID, err := strconv.ParseInt(context.Query("programId"), 10, 64)
	if err != nil || programID <= 0 {
		httpx.JSON(context, nil, errors.New("缺少项目标识"))
		return 0, false
	}
	return programID, true
}

func programIDFromQuery(context *gin.Context) (int64, bool) { return ProgramIDFromQuery(context) }

func (h *Handler) resolveProgramBizLine(context *gin.Context, programID int64, target *contract.BizLine) bool {
	bizLine, err := h.service.ResolveProgramBizLine(context.Request.Context(), programID)
	if err != nil {
		httpx.JSON(context, nil, err)
		return false
	}
	// 只判 AuthorizeProgramInBizLine：它已经包含「空间成员放行，否则回落到项目级授权」的完整规则。
	// 前面再加一道空间闸门会把回落路径打死 —— 不是空间成员、但被单独拉进这个项目的人
	// 会拿到「无权访问该空间」，而项目级授权本来就是为这种人准备的。
	if err := httpx.AuthorizeProgramInBizLine(context, bizLine.String(), programID); err != nil {
		httpx.JSON(context, nil, err)
		return false
	}
	*target = bizLine
	return true
}

var _ routers.Handler = (*Handler)(nil)
