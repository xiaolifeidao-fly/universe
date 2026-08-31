// Package timeplans 时间计划的增删改查与分支关联。
//
// 时间计划是项目的交付时间窗口，在 Git 上对应一条从基准分支切出的发布分支。
// 三个合并方向（基线→计划、需求分支→计划、计划→基线）全部由本机桥接执行，
// 这里只提供元数据读写，并在浏览器回报成功后记录一次合并事实。
package timeplans

import (
	"errors"
	"strconv"

	"common/middleware/httpx"
	"common/middleware/routers"

	"contract"
	"service/delivery"
	deliverydto "service/delivery/dto"
	"service/identity"

	"github.com/gin-gonic/gin"
)

type Handler struct {
	service    delivery.Service
	identities identity.Service
}

func NewHandler(service delivery.Service, identities identity.Service) *Handler {
	return &Handler{service: service, identities: identities}
}

func (h *Handler) RegisterHandler(group *gin.RouterGroup) {
	// 计划是人维护的，写一律要求项目管理权限；读放开到服务凭证，桥接合并前要取计划下的需求分支。
	api := group.Group("/delivery", httpx.RequireProductResearch())
	api.POST("/time-plan/save", h.save)
	api.POST("/time-plan/branch/bind", h.bindBranch)
	api.POST("/time-plan/merge/record", h.recordMerge)
	api.POST("/time-plan/delete", h.delete)
	api.POST("/requirement/time-plan/bind", h.bindRequirement)

	group.GET("/delivery/time-plans", httpx.RequireProductResearchOrService(), h.list)
	group.GET("/delivery/time-plan", httpx.RequireProductResearchOrService(), h.get)
	group.GET("/delivery/time-plan/requirements", httpx.RequireProductResearchOrService(), h.listRequirements)
}

func (h *Handler) list(context *gin.Context) {
	var query deliverydto.TimePlanQuery
	if err := context.ShouldBindQuery(&query); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, query.ProgramID, &query.BizLine) {
		return
	}
	page, err := h.service.ListTimePlans(context.Request.Context(), query)
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
	view, err := h.service.GetTimePlan(context.Request.Context(), bizLine, programID, context.Query("planKey"))
	httpx.JSON(context, view, err)
}

// listRequirements 是合并需求分支弹窗的数据源：只带需求的分支字段，不带需求正文。
func (h *Handler) listRequirements(context *gin.Context) {
	var query deliverydto.TimePlanRequirementQuery
	if err := context.ShouldBindQuery(&query); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, query.ProgramID, &query.BizLine) {
		return
	}
	views, err := h.service.ListTimePlanRequirements(context.Request.Context(), query)
	httpx.JSON(context, views, err)
}

func (h *Handler) save(context *gin.Context) {
	var req deliverydto.SaveTimePlanRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, req.ProgramID, &req.BizLine) {
		return
	}
	if !h.requireProgramManager(context, req.BizLine, req.ProgramID) {
		return
	}
	req.ActorID = httpx.CallerID(context)
	view, err := h.service.SaveTimePlan(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

// bindBranch 由浏览器在本机桥接确认建出计划分支后调用，服务端只记录关联结果。
func (h *Handler) bindBranch(context *gin.Context) {
	var req deliverydto.BindTimePlanBranchRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, req.ProgramID, &req.BizLine) {
		return
	}
	if !h.requireProgramManager(context, req.BizLine, req.ProgramID) {
		return
	}
	req.ActorID = httpx.CallerID(context)
	view, err := h.service.BindTimePlanBranch(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

// recordMerge 记录一次本机合并成功的事实；合并本身在桥接执行，服务端不复核结果。
func (h *Handler) recordMerge(context *gin.Context) {
	var req deliverydto.RecordTimePlanMergeRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, req.ProgramID, &req.BizLine) {
		return
	}
	if !h.requireProgramManager(context, req.BizLine, req.ProgramID) {
		return
	}
	req.ActorID = httpx.CallerID(context)
	view, err := h.service.RecordTimePlanMerge(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) delete(context *gin.Context) {
	var req deliverydto.DeleteTimePlanRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, req.ProgramID, &req.BizLine) {
		return
	}
	if !h.requireProgramManager(context, req.BizLine, req.ProgramID) {
		return
	}
	req.ActorID = httpx.CallerID(context)
	err := h.service.DeleteTimePlan(context.Request.Context(), req)
	httpx.JSON(context, nil, err)
}

// bindRequirement 是工作台与任务面板需求列表上「关联时间计划」按钮的入口。
// planKey 传空串表示解除关联。
func (h *Handler) bindRequirement(context *gin.Context) {
	var req deliverydto.BindRequirementTimePlanRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, req.ProgramID, &req.BizLine) {
		return
	}
	if !h.requireProgramManager(context, req.BizLine, req.ProgramID) {
		return
	}
	req.ActorID = httpx.CallerID(context)
	view, err := h.service.BindRequirementTimePlan(context.Request.Context(), req)
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
	if err := httpx.AuthorizeProgramInBizLine(context, bizLine.String(), programID); err != nil {
		httpx.JSON(context, nil, err)
		return false
	}
	*target = bizLine
	return true
}

func (h *Handler) requireProgramManager(context *gin.Context, bizLine contract.BizLine, programID int64) bool {
	if httpx.CanWriteProgram(context, bizLine.String(), programID) {
		return true
	}
	httpx.Fail(context, "无权管理该项目")
	return false
}

var _ routers.Handler = (*Handler)(nil)
