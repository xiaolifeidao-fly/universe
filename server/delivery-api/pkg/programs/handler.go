// Package programs 交付项目 / 阶段 / 模块的维护接口。
package programs

import (
	"errors"
	"strconv"

	"common/middleware/httpx"
	"common/middleware/routers"

	"contract"
	"service/delivery"
	deliverydto "service/delivery/dto"
	"service/identity"
	identitydto "service/identity/dto"

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
	// 项目 / 阶段 / 模块都是配置，写一律 RequireUser。
	api := group.Group("/delivery", httpx.RequireUser())
	api.POST("/program/save", h.saveProgram)
	api.POST("/program/git-config", h.saveGitConfig)
	api.POST("/program/migrate", h.migrateProgram)
	api.POST("/stage/save", h.saveStage)
	api.POST("/stage/delete", h.deleteStage)
	api.POST("/module/save", h.saveModule)
	api.POST("/module/delete", h.deleteModule)
	api.POST("/import", h.importItems)
	api.GET("/program/assignment", h.assignment)
	api.GET("/program/members", h.members)
	api.POST("/program/assignment", h.saveAssignment)

	// 只读的配置，控制台和将来的定时快照作业都要看。
	group.GET("/delivery/programs", httpx.RequireUserOrService(), h.listPrograms)
	group.GET("/delivery/program", httpx.RequireUserOrService(), h.getProgram)
	group.GET("/delivery/stages", httpx.RequireUserOrService(), h.listStages)
	group.GET("/delivery/modules", httpx.RequireUserOrService(), h.listModules)
	group.GET("/delivery/modules/page", httpx.RequireUserOrService(), h.listModulesPage)
}

// listPrograms 逐条按项目可见性过滤，不在入口按空间一刀切：
// 只被拉进某个项目、不是空间成员的人，也该在这个空间下看到那一个项目。
// 完全没有权限的空间自然过滤成空列表。
func (h *Handler) listPrograms(context *gin.Context) {
	bizLine := bizLineOf(context)
	views, err := h.service.ListPrograms(context.Request.Context(), bizLine)
	if err == nil {
		filtered := views[:0]
		for _, view := range views {
			if httpx.AuthorizeProgramInBizLine(context, bizLine.String(), view.ProgramID) != nil {
				continue
			}
			view.CanAdminister = httpx.CanAdministerProgram(context, bizLine.String(), view.ProgramID)
			view.CanWrite = httpx.CanWriteProgram(context, bizLine.String(), view.ProgramID)
			filtered = append(filtered, view)
		}
		views = filtered
	}
	httpx.JSON(context, views, err)
}

func (h *Handler) getProgram(context *gin.Context) {
	programID, ok := programIDFromQuery(context)
	if !ok {
		return
	}
	var bizLine contract.BizLine
	if !h.resolveProgramBizLine(context, programID, &bizLine) {
		return
	}
	view, err := h.service.GetProgram(context.Request.Context(), bizLine, programID)
	if err == nil {
		view.CanAdminister = httpx.CanAdministerProgram(context, bizLine.String(), programID)
		view.CanWrite = httpx.CanWriteProgram(context, bizLine.String(), programID)
	}
	httpx.JSON(context, view, err)
}

func (h *Handler) saveProgram(context *gin.Context) {
	var req deliverydto.SaveProgramRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if req.ProgramID > 0 {
		if !h.resolveManagedProgramBizLine(context, req.ProgramID, &req.BizLine) {
			return
		}
	} else {
		req.BizLine = bizLineOf(context)
		// 只读成员进得来但建不了项目，写入成员和空间管理员才可以。
		if !httpx.CanWriteBizLine(context, req.BizLine.String()) {
			httpx.Fail(context, "无权新建该空间项目")
			return
		}
	}
	req.ActorID = httpx.CallerID(context)
	httpx.JSON(context, nil, h.service.SaveProgram(context.Request.Context(), req))
}

func (h *Handler) saveGitConfig(context *gin.Context) {
	var req deliverydto.SaveProgramGitConfigRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveManagedProgramBizLine(context, req.ProgramID, &req.BizLine) {
		return
	}
	req.ActorID = httpx.CallerID(context)
	view, err := h.service.SaveProgramGitConfig(context.Request.Context(), req)
	if err == nil {
		view.CanAdminister = true
		view.CanWrite = true
	}
	httpx.JSON(context, view, err)
}

func (h *Handler) migrateProgram(context *gin.Context) {
	var req deliverydto.MigrateProgramRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveManagedProgramBizLine(context, req.ProgramID, &req.SourceBizLine) {
		return
	}
	if !req.TargetBizLine.Valid() {
		req.TargetBizLine = req.SourceBizLine
	}
	if req.TargetBizLine != req.SourceBizLine && !httpx.CanWriteBizLine(context, req.TargetBizLine.String()) {
		httpx.Fail(context, "无权迁移到目标空间")
		return
	}
	req.ActorID = httpx.CallerID(context)
	httpx.JSON(context, nil, h.service.MigrateProgram(context.Request.Context(), req))
}

func (h *Handler) listStages(context *gin.Context) {
	programID, ok := programIDFromQuery(context)
	if !ok {
		return
	}
	var bizLine contract.BizLine
	if !h.resolveProgramBizLine(context, programID, &bizLine) {
		return
	}
	views, err := h.service.ListStages(context.Request.Context(), bizLine, programID)
	httpx.JSON(context, views, err)
}

func (h *Handler) saveStage(context *gin.Context) {
	var req deliverydto.SaveStageRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, req.ProgramID, &req.BizLine) {
		return
	}
	if !h.canSaveStage(context, req.BizLine, req.ProgramID, req.StageKey) {
		return
	}
	httpx.JSON(context, nil, h.service.SaveStage(context.Request.Context(), req))
}

func (h *Handler) deleteStage(context *gin.Context) {
	var req deliverydto.DeleteStageRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, req.ProgramID, &req.BizLine) {
		return
	}
	if !h.requireProgramWriter(context, req.BizLine, req.ProgramID) {
		return
	}
	httpx.JSON(context, nil, h.service.DeleteStage(context.Request.Context(), req))
}

func (h *Handler) listModules(context *gin.Context) {
	programID, ok := programIDFromQuery(context)
	if !ok {
		return
	}
	var bizLine contract.BizLine
	if !h.resolveProgramBizLine(context, programID, &bizLine) {
		return
	}
	views, err := h.service.ListModules(context.Request.Context(), bizLine, programID)
	httpx.JSON(context, views, err)
}

func (h *Handler) listModulesPage(context *gin.Context) {
	var query deliverydto.ModuleQuery
	if err := context.ShouldBindQuery(&query); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, query.ProgramID, &query.BizLine) {
		return
	}
	page, err := h.service.ListModulesPage(context.Request.Context(), query)
	httpx.JSON(context, page, err)
}

func (h *Handler) saveModule(context *gin.Context) {
	var req deliverydto.SaveModuleRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, req.ProgramID, &req.BizLine) {
		return
	}
	if !h.canSaveModule(context, req.BizLine, req.ProgramID, req.ModuleKey) {
		return
	}
	httpx.JSON(context, nil, h.service.SaveModule(context.Request.Context(), req))
}

func (h *Handler) deleteModule(context *gin.Context) {
	var req deliverydto.DeleteModuleRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !h.resolveProgramBizLine(context, req.ProgramID, &req.BizLine) {
		return
	}
	if !h.requireProgramWriter(context, req.BizLine, req.ProgramID) {
		return
	}
	httpx.JSON(context, nil, h.service.DeleteModule(context.Request.Context(), req))
}

func (h *Handler) assignment(context *gin.Context) {
	programID, ok := programIDFromQuery(context)
	if !ok {
		return
	}
	var bizLine contract.BizLine
	if !h.resolveProgramBizLine(context, programID, &bizLine) {
		return
	}
	assignment, err := h.identities.ListProgramAssignment(context.Request.Context(), programID)
	httpx.JSON(context, assignment, err)
}

// members 只返回当前项目已分配的在职成员，供负责人和协助人下拉框使用。
func (h *Handler) members(context *gin.Context) {
	programID, ok := programIDFromQuery(context)
	if !ok {
		return
	}
	var bizLine contract.BizLine
	if !h.resolveProgramBizLine(context, programID, &bizLine) {
		return
	}
	members, err := h.identities.ListProgramMembers(context.Request.Context(), programID)
	httpx.JSON(context, members, err)
}

func (h *Handler) saveAssignment(context *gin.Context) {
	var req struct {
		ProgramID int64 `json:"programId"`
		identitydto.ScopeAssignment
	}
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	var bizLine contract.BizLine
	if !h.resolveManagedProgramBizLine(context, req.ProgramID, &bizLine) {
		return
	}
	if !h.requireBizLineMembers(context, bizLine.String(), req.ScopeAssignment) {
		return
	}
	httpx.JSON(context, nil, h.identities.ReplaceProgramAssignment(context.Request.Context(), bizLine.String(), req.ProgramID, req.ScopeAssignment))
}

// importItems 吃原型 assets/tasks.json 的原始形状，首次上线用一次。
func (h *Handler) importItems(context *gin.Context) {
	var req deliverydto.ImportRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !httpx.IsAdmin(context) {
		httpx.JSON(context, nil, contract.ErrNotFound)
		return
	}
	req.BizLine = bizLineOf(context)
	req.ActorID = httpx.CallerID(context)
	result, err := h.service.ImportItems(context.Request.Context(), req)
	httpx.JSON(context, result, err)
}

// requireBizLineMembers 把项目成员的候选范围钉死在所属空间的成员名单上。
// 前端的候选下拉已经这么取数了，但授权不能只靠前端过滤。
func (h *Handler) requireBizLineMembers(context *gin.Context, bizLine string, assignment identitydto.ScopeAssignment) bool {
	members, err := h.identities.ListBizLineMembers(context.Request.Context(), bizLine)
	if err != nil {
		httpx.JSON(context, nil, err)
		return false
	}
	allowed := make(map[int64]struct{}, len(members))
	for _, member := range members {
		allowed[member.ID] = struct{}{}
	}
	for _, ids := range [][]int64{assignment.UserIDs, assignment.WriterIDs, assignment.ManagerIDs} {
		for _, id := range ids {
			if _, ok := allowed[id]; !ok {
				httpx.Fail(context, "项目成员只能从该空间的成员中选择")
				return false
			}
		}
	}
	return true
}

func bizLineOf(context *gin.Context) contract.BizLine {
	return contract.BizLine(httpx.BizLine(context))
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

func (h *Handler) resolveManagedProgramBizLine(context *gin.Context, programID int64, target *contract.BizLine) bool {
	if !h.resolveProgramBizLine(context, programID, target) {
		return false
	}
	return h.requireProgramAdmin(context, *target, programID)
}

// requireProgramAdmin 守着项目本身：改项目、迁移项目、分配人员。
// 空间的写入成员能在项目里干活，但动不了这些 —— 那是项目管理员和空间管理员的事。
func (h *Handler) requireProgramAdmin(context *gin.Context, bizLine contract.BizLine, programID int64) bool {
	if httpx.CanAdministerProgram(context, bizLine.String(), programID) {
		return true
	}
	httpx.Fail(context, "只有项目管理员或空间管理员能管理该项目")
	return false
}

// requireProgramWriter 守着项目里的内容：里程碑与模块跟任务、需求同级，
// 空间的写入成员要能维护，否则拆解需求这条链路就断了。
func (h *Handler) requireProgramWriter(context *gin.Context, bizLine contract.BizLine, programID int64) bool {
	if httpx.CanWriteProgram(context, bizLine.String(), programID) {
		return true
	}
	httpx.Fail(context, "无权修改该项目内容")
	return false
}

func (h *Handler) canSaveStage(context *gin.Context, bizLine contract.BizLine, programID int64, stageKey string) bool {
	if httpx.CanWriteProgram(context, bizLine.String(), programID) {
		return true
	}
	stages, err := h.service.ListStages(context.Request.Context(), bizLine, programID)
	if err != nil {
		httpx.JSON(context, nil, err)
		return false
	}
	for _, stage := range stages {
		if stage.StageKey == stageKey {
			httpx.Fail(context, "普通成员只能新增里程碑")
			return false
		}
	}
	return true
}

func (h *Handler) canSaveModule(context *gin.Context, bizLine contract.BizLine, programID int64, moduleKey string) bool {
	if httpx.CanWriteProgram(context, bizLine.String(), programID) {
		return true
	}
	modules, err := h.service.ListModules(context.Request.Context(), bizLine, programID)
	if err != nil {
		httpx.JSON(context, nil, err)
		return false
	}
	for _, module := range modules {
		if module.ModuleKey == moduleKey {
			httpx.Fail(context, "普通成员只能新增模块")
			return false
		}
	}
	return true
}

var _ routers.Handler = (*Handler)(nil)
