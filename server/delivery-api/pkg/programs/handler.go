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

	"github.com/gin-gonic/gin"
)

type Handler struct{ service delivery.Service }

func NewHandler(service delivery.Service) *Handler { return &Handler{service: service} }

func (h *Handler) RegisterHandler(group *gin.RouterGroup) {
	// 项目 / 阶段 / 模块都是配置，写一律 RequireUser。
	api := group.Group("/delivery", httpx.RequireUser())
	api.POST("/program/save", h.saveProgram)
	api.POST("/program/migrate", h.migrateProgram)
	api.POST("/stage/save", h.saveStage)
	api.POST("/stage/delete", h.deleteStage)
	api.POST("/module/save", h.saveModule)
	api.POST("/module/delete", h.deleteModule)
	api.POST("/import", h.importItems)

	// 只读的配置，控制台和将来的定时快照作业都要看。
	group.GET("/delivery/programs", httpx.RequireUserOrService(), h.listPrograms)
	group.GET("/delivery/program", httpx.RequireUserOrService(), h.getProgram)
	group.GET("/delivery/stages", httpx.RequireUserOrService(), h.listStages)
	group.GET("/delivery/modules", httpx.RequireUserOrService(), h.listModules)
	group.GET("/delivery/modules/page", httpx.RequireUserOrService(), h.listModulesPage)
}

func (h *Handler) listPrograms(context *gin.Context) {
	bizLine := bizLineOf(context)
	if err := httpx.AuthorizeBizLine(context, bizLine.String()); err != nil {
		httpx.JSON(context, nil, err)
		return
	}
	views, err := h.service.ListPrograms(context.Request.Context(), bizLine)
	if err == nil && !httpx.IsAdmin(context) {
		filtered := views[:0]
		for _, view := range views {
			if httpx.AuthorizeProgram(context, view.ProgramID) == nil {
				filtered = append(filtered, view)
			}
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
	httpx.JSON(context, view, err)
}

func (h *Handler) saveProgram(context *gin.Context) {
	var req deliverydto.SaveProgramRequest
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
	httpx.JSON(context, nil, h.service.SaveProgram(context.Request.Context(), req))
}

func (h *Handler) migrateProgram(context *gin.Context) {
	var req deliverydto.MigrateProgramRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if !httpx.IsAdmin(context) {
		httpx.JSON(context, nil, contract.ErrNotFound)
		return
	}
	req.SourceBizLine = bizLineOf(context)
	if !req.TargetBizLine.Valid() {
		req.TargetBizLine = req.SourceBizLine
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
	httpx.JSON(context, nil, h.service.DeleteModule(context.Request.Context(), req))
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
