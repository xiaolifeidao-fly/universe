// Package requirements 需求的增删改查。
//
// 需求是项目与任务之间的那一层：一次拆解产出一批任务，这批任务共享同一个需求键。
package requirements

import (
	"errors"
	"strconv"
	"strings"

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
	// 需求是人维护的，写一律 RequireUser；读放开到服务凭证，拆解插件要拿需求上下文。
	api := group.Group("/delivery", httpx.RequireUser())
	api.POST("/requirement/save", h.save)
	api.POST("/requirement/members/assign", h.assignMembers)
	api.POST("/requirement/status/update", h.updateStatus)
	api.POST("/requirement/completion-notification/read", h.markCompletionNotificationRead)
	api.POST("/requirement/git-branch/bind", h.bindGitBranch)
	api.POST("/requirement/delete", h.delete)
	api.POST("/requirement/prototype/save", h.savePrototype)
	api.POST("/requirement/testing/save", h.saveTesting)
	// 拆解会话目录由桥接写入，和任务执行会话绑定同样走用户凭证。
	api.POST("/requirement/planning-session/bind", h.bindPlanningSession)
	api.POST("/requirement/testing-session/bind", h.bindTestingSession)
	api.GET("/requirement/completion-notifications", h.listCompletionNotifications)

	group.GET("/delivery/requirements", httpx.RequireUserOrService(), h.list)
	group.GET("/delivery/requirement", httpx.RequireUserOrService(), h.get)
	group.GET("/delivery/requirement/timeline", httpx.RequireUserOrService(), h.timeline)
	group.GET("/delivery/requirement/prototype", httpx.RequireUserOrService(), h.getPrototype)
	group.GET("/delivery/requirement/planning-sessions", httpx.RequireUserOrService(), h.listPlanningSessions)
	group.GET("/delivery/requirement/testing-sessions", httpx.RequireUserOrService(), h.listTestingSessions)
}

func (h *Handler) bindGitBranch(context *gin.Context) {
	var req deliverydto.BindRequirementGitBranchRequest
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
	view, err := h.service.BindRequirementGitBranch(context.Request.Context(), req)
	httpx.JSON(context, view, err)
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
	if !h.requireProgramManager(context, req.BizLine, req.ProgramID) {
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
	if !h.requireProgramManager(context, req.BizLine, req.ProgramID) {
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

// listCompletionNotifications 只按凭证中的当前用户取需求完成消息，不能由浏览器指定收件人。
func (h *Handler) listCompletionNotifications(context *gin.Context) {
	programID, ok := programIDFromQuery(context)
	if !ok {
		return
	}
	var bizLine contract.BizLine
	if !h.resolveProgramBizLine(context, programID, &bizLine) {
		return
	}
	views, err := h.service.ListRequirementCompletionNotifications(context.Request.Context(), deliverydto.RequirementCompletionNotificationQuery{
		BizLine: bizLine, ProgramID: programID, ActorID: httpx.CallerID(context),
	})
	httpx.JSON(context, views, err)
}

// markCompletionNotificationRead 的接收人一律由调用者凭证覆盖，避免代他人确认已读。
func (h *Handler) markCompletionNotificationRead(context *gin.Context) {
	var req deliverydto.MarkRequirementCompletionNotificationReadRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, req.ProgramID, &req.BizLine) {
		return
	}
	req.ActorID = httpx.CallerID(context)
	view, err := h.service.MarkRequirementCompletionNotificationRead(context.Request.Context(), req)
	httpx.JSON(context, view, err)
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
	if !h.requireProgramManager(context, req.BizLine, req.ProgramID) {
		return
	}
	if !h.normalizeRequirementMembers(context, req.ProgramID, req.Owners, req.Assistants) {
		return
	}
	req.ActorID = httpx.CallerID(context)
	view, err := h.service.SaveRequirement(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

// updateStatus 需求列表和工作台的快速改状态入口：只改状态，不整条覆盖。
func (h *Handler) updateStatus(context *gin.Context) {
	var req deliverydto.UpdateRequirementStatusRequest
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
	view, err := h.service.UpdateRequirementStatus(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

// assignMembers 需求列表和工作台的快速指派入口：只改负责人与协助人，
// 不走整条需求保存，免得快速指派把没带上的字段清空。
func (h *Handler) assignMembers(context *gin.Context) {
	var req deliverydto.AssignRequirementMembersRequest
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
	if !h.normalizeRequirementMembers(context, req.ProgramID, req.Owners, req.Assistants) {
		return
	}
	req.ActorID = httpx.CallerID(context)
	view, err := h.service.AssignRequirementMembers(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

// normalizeRequirementMembers 把人员显示名收敛到项目成员目录，并拒绝项目外的负责人、协助人。
// 选人限制不能只依赖浏览器下拉框，否则仍可通过旧客户端或直接请求绕过。
func (h *Handler) normalizeRequirementMembers(
	context *gin.Context,
	programID int64,
	groups ...[]deliverydto.RequirementMember,
) bool {
	needsValidation := false
	for _, group := range groups {
		for _, member := range group {
			if strings.TrimSpace(member.ID) != "" {
				needsValidation = true
				break
			}
		}
	}
	if !needsValidation {
		return true
	}
	members, err := h.identities.ListProgramMembers(context.Request.Context(), programID)
	if err != nil {
		httpx.JSON(context, nil, err)
		return false
	}
	allowed := make(map[string]string, len(members))
	for _, member := range members {
		name := strings.TrimSpace(member.DisplayName)
		if name == "" {
			name = strings.TrimSpace(member.Username)
		}
		if name == "" {
			name = member.ID
		}
		allowed[member.ID] = name
	}
	for _, group := range groups {
		for index := range group {
			id := strings.TrimSpace(group[index].ID)
			if id == "" {
				continue
			}
			name, ok := allowed[id]
			if !ok {
				httpx.Fail(context, "负责人和协助人只能从所属项目成员中选择")
				return false
			}
			group[index].ID = id
			group[index].Name = name
		}
	}
	return true
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
	if !h.requireProgramManager(context, req.BizLine, req.ProgramID) {
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
	if !h.requireProgramManager(context, req.BizLine, req.ProgramID) {
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
	if !h.requireProgramManager(context, req.BizLine, req.ProgramID) {
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

func (h *Handler) requireProgramManager(context *gin.Context, bizLine contract.BizLine, programID int64) bool {
	if httpx.CanWriteProgram(context, bizLine.String(), programID) {
		return true
	}
	httpx.Fail(context, "无权管理该项目")
	return false
}

var _ routers.Handler = (*Handler)(nil)
