// Package requirements 需求的增删改查。
//
// 需求是项目与任务之间的那一层：一次拆解产出一批任务，这批任务共享同一个需求键。
package requirements

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
	// 需求是人维护的，写一律 RequireUser；读放开到服务凭证，拆解插件要拿需求上下文。
	api := group.Group("/delivery", httpx.RequireUser())
	api.POST("/requirement/save", h.save)
	api.POST("/requirement/delete", h.delete)
	api.POST("/requirement/prototype/save", h.savePrototype)
	api.POST("/requirement/testing/save", h.saveTesting)
	// 拆解会话目录由桥接写入，和任务执行会话绑定同样走用户凭证。
	api.POST("/requirement/planning-session/bind", h.bindPlanningSession)
	api.POST("/requirement/testing-session/bind", h.bindTestingSession)

	group.GET("/delivery/requirements", httpx.RequireUserOrService(), h.list)
	group.GET("/delivery/requirement", httpx.RequireUserOrService(), h.get)
	group.GET("/delivery/requirement/timeline", httpx.RequireUserOrService(), h.timeline)
	group.GET("/delivery/requirement/prototype", httpx.RequireUserOrService(), h.getPrototype)
	group.GET("/delivery/requirement/planning-sessions", httpx.RequireUserOrService(), h.listPlanningSessions)
	group.GET("/delivery/requirement/testing-sessions", httpx.RequireUserOrService(), h.listTestingSessions)
}

func (h *Handler) timeline(context *gin.Context) {
	var query deliverydto.RequirementTimelineQuery
	if err := context.ShouldBindQuery(&query); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, query.ProgramID, &query.BizLine) {
		return
	}
	page, err := h.service.ListRequirementTimeline(context.Request.Context(), query)
	httpx.JSON(context, page, err)
}

func (h *Handler) listPlanningSessions(context *gin.Context) {
	var query deliverydto.PlanningSessionQuery
	if err := context.ShouldBindQuery(&query); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, query.ProgramID, &query.BizLine) {
		return
	}
	views, err := h.service.ListPlanningSessions(context.Request.Context(), query)
	httpx.JSON(context, views, err)
}

func (h *Handler) bindPlanningSession(context *gin.Context) {
	var req deliverydto.BindPlanningSessionRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, req.ProgramID, &req.BizLine) {
		return
	}
	req.ActorID = httpx.CallerID(context)
	view, err := h.service.BindPlanningSession(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) listTestingSessions(context *gin.Context) {
	var query deliverydto.RequirementTestingSessionQuery
	if err := context.ShouldBindQuery(&query); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, query.ProgramID, &query.BizLine) {
		return
	}
	views, err := h.service.ListRequirementTestingSessions(context.Request.Context(), query)
	httpx.JSON(context, views, err)
}

func (h *Handler) bindTestingSession(context *gin.Context) {
	var req deliverydto.BindRequirementTestingSessionRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, req.ProgramID, &req.BizLine) {
		return
	}
	req.ActorID = httpx.CallerID(context)
	view, err := h.service.BindRequirementTestingSession(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) list(context *gin.Context) {
	var query deliverydto.RequirementQuery
	if err := context.ShouldBindQuery(&query); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, query.ProgramID, &query.BizLine) {
		return
	}
	// 「和我有关」取的是凭证里的调用者，不信任请求参数里的用户标识。
	query.ActorID = httpx.CallerID(context)
	page, err := h.service.ListRequirements(context.Request.Context(), query)
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
	view, err := h.service.GetRequirement(context.Request.Context(), bizLine, programID, context.Query("requirementKey"))
	httpx.JSON(context, view, err)
}

func (h *Handler) save(context *gin.Context) {
	var req deliverydto.SaveRequirementRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, req.ProgramID, &req.BizLine) {
		return
	}
	req.ActorID = httpx.CallerID(context)
	view, err := h.service.SaveRequirement(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) getPrototype(context *gin.Context) {
	programID, ok := programIDFromQuery(context)
	if !ok {
		return
	}
	var bizLine contract.BizLine
	if !h.resolveProgramBizLine(context, programID, &bizLine) {
		return
	}
	view, err := h.service.GetRequirementPrototype(context.Request.Context(), bizLine, programID, context.Query("requirementKey"))
	httpx.JSON(context, view, err)
}

func (h *Handler) savePrototype(context *gin.Context) {
	var req deliverydto.SaveRequirementPrototypeRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, req.ProgramID, &req.BizLine) {
		return
	}
	req.ActorID = httpx.CallerID(context)
	view, err := h.service.SaveRequirementPrototype(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) saveTesting(context *gin.Context) {
	var req deliverydto.UpdateRequirementTestingRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, req.ProgramID, &req.BizLine) {
		return
	}
	req.ActorID = httpx.CallerID(context)
	view, err := h.service.UpdateRequirementTesting(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) delete(context *gin.Context) {
	var req deliverydto.DeleteRequirementRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, req.ProgramID, &req.BizLine) {
		return
	}
	req.ActorID = httpx.CallerID(context)
	httpx.JSON(context, nil, h.service.DeleteRequirement(context.Request.Context(), req))
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
