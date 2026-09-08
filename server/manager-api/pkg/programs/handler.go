// Package programs is manager-api's controller layer for delivery-project
// administration. It reuses service/delivery exactly like
// delivery-api/pkg/programs does, but every route requires
// the manager-api/auth middleware and skips the per-project ownership checks
// (CanAdministerProgram/CanWriteProgram) delivery-api applies for the
// collaborative web console — a system admin manages every project in
// every space. Stage/module/git-config/cloud-sync/migrate/import are not
// exposed here yet (see manager-api/README.md TODO); this covers the core
// list/get/create/update the task asked for.
package programs

import (
	"strconv"

	"common/middleware/httpx"
	"common/middleware/routers"

	"contract"
	"service/delivery"
	deliverydto "service/delivery/dto"

	"github.com/gin-gonic/gin"
)

type Handler struct {
	service delivery.Service
}

func NewHandler(service delivery.Service) *Handler {
	return &Handler{service: service}
}

func (h *Handler) RegisterHandler(group *gin.RouterGroup) {
	admin := group.Group("/programs")
	admin.GET("", h.list)
	admin.GET("/:id", h.get)
	admin.POST("", h.save)
	admin.POST("/:id", h.save)
}

func (h *Handler) list(context *gin.Context) {
	bizLine := contract.BizLine(context.Query("bizLine"))
	if !bizLine.Valid() {
		httpx.Fail(context, "缺少空间")
		return
	}
	views, err := h.service.ListPrograms(context.Request.Context(), bizLine)
	if err == nil {
		for index := range views {
			views[index].CanAdminister = true
			views[index].CanWrite = true
		}
	}
	httpx.JSON(context, views, err)
}

func (h *Handler) get(context *gin.Context) {
	programID, err := strconv.ParseInt(context.Param("id"), 10, 64)
	if err != nil || programID <= 0 {
		httpx.Fail(context, "项目标识无效")
		return
	}
	bizLine, err := h.service.ResolveProgramBizLine(context.Request.Context(), programID)
	if err != nil {
		httpx.JSON(context, nil, err)
		return
	}
	view, err := h.service.GetProgram(context.Request.Context(), bizLine, programID)
	if err == nil {
		view.CanAdminister = true
		view.CanWrite = true
	}
	httpx.JSON(context, view, err)
}

func (h *Handler) save(context *gin.Context) {
	var req deliverydto.SaveProgramRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	// URL 上的 :id 必须先落到 req.ProgramID，再判断走「新建」还是「改已有」分支——
	// 先判断后赋值的话，PATCH /programs/:id 只传了业务字段、没在 JSON body 里
	// 重复写 programId 时，会被误判成新建，去要求一个本不需要的 ?bizLine= 查询参数。
	if rawID := context.Param("id"); rawID != "" {
		id, err := strconv.ParseInt(rawID, 10, 64)
		if err != nil {
			httpx.Fail(context, "项目标识无效")
			return
		}
		req.ProgramID = id
	}
	if req.ProgramID > 0 {
		bizLine, err := h.service.ResolveProgramBizLine(context.Request.Context(), req.ProgramID)
		if err != nil {
			httpx.JSON(context, nil, err)
			return
		}
		req.BizLine = bizLine
	} else {
		req.BizLine = contract.BizLine(context.Query("bizLine"))
		if !req.BizLine.Valid() {
			httpx.Fail(context, "缺少空间")
			return
		}
	}
	req.ActorID = httpx.CallerID(context)
	req.ActorName = httpx.CallerName(context)
	httpx.JSON(context, nil, h.service.SaveProgram(context.Request.Context(), req))
}

var _ routers.Handler = (*Handler)(nil)
