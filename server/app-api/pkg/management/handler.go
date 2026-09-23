// Package management contains the mobile app's thin HTTP adapters for the
// existing identity, business-intake and delivery services.
package management

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"

	"common/middleware/httpx"
	"contract"
	"service/business"
	businessdto "service/business/dto"
	"service/delivery"
	deliverydto "service/delivery/dto"
	"service/identity"
	identitydto "service/identity/dto"

	"github.com/gin-gonic/gin"
)

const maxBusinessAttachmentBytes = 20 * 1024 * 1024

type Handler struct {
	delivery   delivery.Service
	identities identity.Service
	business   business.Service
	spaces     SpaceDirectory
}

// NewHandler 的 spaces 允许为 nil：没有空间注册表时列表退化成 token 里的授权编码。
func NewHandler(deliveryService delivery.Service, identityService identity.Service, businessService business.Service, spaces SpaceDirectory) *Handler {
	return &Handler{delivery: deliveryService, identities: identityService, business: businessService, spaces: spaces}
}

func (h *Handler) Register(api *gin.RouterGroup) {
	api.POST("/auth/login", h.login)
	auth := api.Group("/auth", httpx.RequireUser())
	auth.GET("/me", h.me)

	// 空间列表对所有登录身份开放：业务方和产研都要先选空间再看自己的工作台。
	api.GET("/spaces", httpx.RequireUser(), h.listSpaces)

	// Business intake remains distinct from product/research delivery
	// requirements. Both endpoints keep caller identity server-derived.
	businessAPI := api.Group("/business", httpx.RequireUser())
	businessAPI.GET("/programs", h.listBusinessPrograms)
	businessAPI.GET("/requirements", h.listBusinessRequirements)
	businessAPI.POST("/requirements", h.createBusinessRequirement)
	businessAPI.GET("/requirement", h.getBusinessConversation)
	businessAPI.POST("/requirement/messages", h.sendBusinessMessage)
	businessAPI.POST("/requirement/attachments", h.uploadBusinessAttachments)
	businessAPI.GET("/requirement/attachment", h.getBusinessAttachment)
	businessAPI.GET("/requirement/references", h.listBusinessDocumentReferences)

	businessResearchAPI := api.Group("/business/research", httpx.RequireProductResearch())
	businessResearchAPI.GET("/requirements", h.listCollectedBusinessRequirements)
	businessResearchAPI.GET("/requirement", h.getCollectedBusinessConversation)

	read := api.Group("/delivery", httpx.RequireProductResearch())
	read.GET("/programs", h.listPrograms)
	read.GET("/program", h.getProgram)
	read.GET("/board", h.board)
	read.GET("/requirements", h.listRequirements)
	read.GET("/requirement", h.getRequirement)
	read.GET("/items", h.listItems)
	read.GET("/item", h.getItem)
	// 工作台的任务进度、需求时间线和拆解会话目录都是只读视图，直接复用交付服务。
	read.GET("/requirement/progress", h.requirementProgress)
	read.GET("/requirement/timeline", h.requirementTimeline)
	read.GET("/requirement/planning-sessions", h.listPlanningSessions)
	// 消息中心的两类提醒：执行批次完成认启动者，需求完成认收件人（负责人/协助者）。
	// 「受阻 / 不做」的待关注任务不走这里 —— 它没有已读语义，前端用 items 的状态筛出来。
	read.GET("/execution-batch/notifications", h.listExecutionBatchNotifications)
	read.GET("/requirement/completion-notifications", h.listRequirementCompletionNotifications)

	write := api.Group("/delivery", httpx.RequireProductResearch())
	write.POST("/requirement/save", h.saveRequirement)
	// 手机端新建需求要先在执行电脑上建分支再落库：分支建成后回记关联，
	// 名称先用需求编号占位，等拆解会话按聊天内容起好标题再换掉。
	write.POST("/requirement/name/update", h.updateRequirementName)
	write.POST("/requirement/git-branch/bind", h.bindRequirementGitBranch)
	write.POST("/requirement/planning-batch/create", h.createPlanningBatch)
	write.POST("/item/create", h.createItem)
	write.POST("/item/patch", h.patchItem)
	// 确认已读只动调用者自己那条提醒，不改项目数据，所以按只读权限校验项目归属，
	// 不要求对项目有写权限 —— 只读成员同样收得到提醒，也该能把它标掉。
	write.POST("/execution-batch/notification/read", h.markExecutionBatchNotificationRead)
	write.POST("/requirement/completion-notification/read", h.markRequirementCompletionNotificationRead)
}

func (h *Handler) login(c *gin.Context) {
	var req identitydto.LoginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, err.Error())
		return
	}
	result, err := h.identities.Login(c.Request.Context(), req)
	httpx.JSON(c, result, err)
}

func (h *Handler) me(c *gin.Context) {
	principal, _ := httpx.CurrentUser(c)
	userID, err := strconv.ParseInt(principal.ID, 10, 64)
	if err != nil {
		httpx.Fail(c, "用户标识无效")
		return
	}
	view, err := h.identities.CurrentUser(c.Request.Context(), userID)
	httpx.JSON(c, view, err)
}

func (h *Handler) listBusinessPrograms(c *gin.Context) {
	principal, ok := businessPrincipal(c)
	if !ok {
		return
	}
	bizLine, ok := authorizeBizLine(c, strings.TrimSpace(httpx.BizLine(c)), principal)
	if !ok {
		return
	}
	views, err := h.business.ListPrograms(c.Request.Context(), bizLine)
	httpx.JSON(c, views, err)
}

func (h *Handler) listBusinessRequirements(c *gin.Context) {
	principal, ok := businessPrincipal(c)
	if !ok {
		return
	}
	bizLine, ok := authorizeBizLine(c, strings.TrimSpace(c.Query("bizLine")), principal)
	if !ok {
		return
	}
	pageIndex, _ := strconv.Atoi(c.Query("pageIndex"))
	pageSize, _ := strconv.Atoi(c.Query("pageSize"))
	page, err := h.business.ListRequirements(c.Request.Context(), businessdto.RequirementQuery{
		Page: businessdto.Page{PageIndex: pageIndex, PageSize: pageSize}, BizLine: bizLine, CreatorID: principal.ID,
	})
	httpx.JSON(c, page, err)
}

func (h *Handler) createBusinessRequirement(c *gin.Context) {
	principal, ok := businessPrincipal(c)
	if !ok {
		return
	}
	var req businessdto.CreateRequirementRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, err.Error())
		return
	}
	req.CreatorID = principal.ID
	req.CreatorUsername = principal.Username
	req.CreatorName = principal.DisplayName
	req.AccessibleBizLines = append(append([]string{}, principal.BizLines...), principal.ManagedBizLines...)
	view, err := h.business.CreateRequirement(c.Request.Context(), req)
	httpx.JSON(c, view, err)
}

func (h *Handler) getBusinessConversation(c *gin.Context) {
	principal, ok := businessPrincipal(c)
	if !ok {
		return
	}
	bizLine, ok := authorizeBizLine(c, strings.TrimSpace(c.Query("bizLine")), principal)
	if !ok {
		return
	}
	requirementID, _ := strconv.ParseInt(strings.TrimSpace(c.Query("requirementId")), 10, 64)
	view, err := h.business.GetConversation(c.Request.Context(), businessdto.ConversationQuery{
		BizLine: bizLine, RequirementID: requirementID, CreatorID: principal.ID,
	})
	httpx.JSON(c, view, err)
}

func (h *Handler) sendBusinessMessage(c *gin.Context) {
	principal, ok := businessPrincipal(c)
	if !ok {
		return
	}
	var req businessdto.SendMessageRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, err.Error())
		return
	}
	bizLine, ok := authorizeBizLine(c, strings.TrimSpace(c.Query("bizLine")), principal)
	if !ok {
		return
	}
	req.BizLine = bizLine
	req.CreatorID = principal.ID
	req.CreatorUsername = principal.Username
	result, err := h.business.SendMessage(c.Request.Context(), req)
	httpx.JSON(c, result, err)
}

// listBusinessDocumentReferences powers the @ picker in the composer, the same
// way the console does: the intake documents this project's earlier interviews
// already produced. Candidates carry no content; the body is resolved
// server-side when the message is actually sent.
func (h *Handler) listBusinessDocumentReferences(c *gin.Context) {
	principal, ok := businessPrincipal(c)
	if !ok {
		return
	}
	bizLine, ok := authorizeBizLine(c, strings.TrimSpace(c.Query("bizLine")), principal)
	if !ok {
		return
	}
	requirementID, _ := strconv.ParseInt(strings.TrimSpace(c.Query("requirementId")), 10, 64)
	views, err := h.business.ListDocumentReferences(c.Request.Context(), businessdto.DocumentReferenceQuery{
		BizLine: bizLine, RequirementID: requirementID, CreatorID: principal.ID,
		Keyword: strings.TrimSpace(c.Query("keyword")),
	})
	httpx.JSON(c, views, err)
}

func (h *Handler) uploadBusinessAttachments(c *gin.Context) {
	principal, ok := businessPrincipal(c)
	if !ok {
		return
	}
	bizLine, ok := authorizeBizLine(c, strings.TrimSpace(c.Query("bizLine")), principal)
	if !ok {
		return
	}
	requirementID, err := strconv.ParseInt(strings.TrimSpace(c.PostForm("requirementId")), 10, 64)
	if err != nil || requirementID <= 0 {
		httpx.Fail(c, "业务需求标识无效")
		return
	}
	form, err := c.MultipartForm()
	if err != nil {
		httpx.Fail(c, err.Error())
		return
	}
	headers := form.File["files"]
	if len(headers) == 0 {
		httpx.Fail(c, "请选择要上传的文件")
		return
	}
	files := make([]businessdto.AttachmentUpload, 0, len(headers))
	for _, header := range headers {
		opened, openErr := header.Open()
		if openErr != nil {
			httpx.Fail(c, openErr.Error())
			return
		}
		data, readErr := io.ReadAll(io.LimitReader(opened, maxBusinessAttachmentBytes+1))
		_ = opened.Close()
		if readErr != nil {
			httpx.Fail(c, readErr.Error())
			return
		}
		if int64(len(data)) > maxBusinessAttachmentBytes {
			httpx.Fail(c, "附件 "+header.Filename+" 超过 20 MB")
			return
		}
		files = append(files, businessdto.AttachmentUpload{Name: header.Filename, ContentType: header.Header.Get("Content-Type"), Data: data})
	}
	views, err := h.business.UploadAttachments(c.Request.Context(), businessdto.UploadAttachmentsRequest{
		RequirementID: requirementID, Files: files, BizLine: bizLine,
		CreatorID: principal.ID, CreatorUsername: principal.Username,
	})
	httpx.JSON(c, views, err)
}

func (h *Handler) getBusinessAttachment(c *gin.Context) {
	principal, ok := businessPrincipal(c)
	if !ok {
		return
	}
	bizLine, ok := authorizeBizLine(c, strings.TrimSpace(c.Query("bizLine")), principal)
	if !ok {
		return
	}
	requirementID, _ := strconv.ParseInt(strings.TrimSpace(c.Query("requirementId")), 10, 64)
	content, err := h.business.GetAttachment(c.Request.Context(), businessdto.AttachmentQuery{
		RequirementID: requirementID, AttachmentID: strings.TrimSpace(c.Query("attachmentId")),
		BizLine: bizLine, CreatorID: principal.ID,
	})
	if err != nil {
		httpx.JSON(c, nil, err)
		return
	}
	contentType := strings.TrimSpace(content.ContentType)
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": content.Name}))
	c.Data(http.StatusOK, contentType, content.Data)
}

func (h *Handler) listCollectedBusinessRequirements(c *gin.Context) {
	bizLine, ok := h.authorizeRequestBizLine(c)
	if !ok {
		return
	}
	pageIndex, _ := strconv.Atoi(c.Query("pageIndex"))
	pageSize, _ := strconv.Atoi(c.Query("pageSize"))
	page, err := h.business.ListCollectedRequirements(c.Request.Context(), businessdto.CollectedRequirementQuery{
		Page: businessdto.Page{PageIndex: pageIndex, PageSize: pageSize}, BizLine: bizLine,
	})
	httpx.JSON(c, page, err)
}

func (h *Handler) getCollectedBusinessConversation(c *gin.Context) {
	bizLine, ok := h.authorizeRequestBizLine(c)
	if !ok {
		return
	}
	requirementID, _ := strconv.ParseInt(strings.TrimSpace(c.Query("requirementId")), 10, 64)
	view, err := h.business.GetCollectedConversation(c.Request.Context(), businessdto.CollectedConversationQuery{
		BizLine: bizLine, RequirementID: requirementID,
	})
	httpx.JSON(c, view, err)
}

func (h *Handler) listPrograms(c *gin.Context) {
	bizLine, ok := h.authorizeRequestBizLine(c)
	if !ok {
		return
	}
	views, err := h.delivery.ListPrograms(c.Request.Context(), bizLine)
	if err == nil {
		filtered := views[:0]
		for _, view := range views {
			if httpx.AuthorizeProgramInBizLine(c, bizLine.String(), view.ProgramID) != nil {
				continue
			}
			view.CanAdminister = httpx.CanAdministerProgram(c, bizLine.String(), view.ProgramID)
			view.CanWrite = httpx.CanWriteProgram(c, bizLine.String(), view.ProgramID)
			filtered = append(filtered, view)
		}
		views = filtered
	}
	httpx.JSON(c, views, err)
}

func (h *Handler) getProgram(c *gin.Context) {
	programID, bizLine, ok := h.authorizeProgram(c)
	if !ok {
		return
	}
	view, err := h.delivery.GetProgram(c.Request.Context(), bizLine, programID)
	if err == nil {
		view.CanAdminister = httpx.CanAdministerProgram(c, bizLine.String(), programID)
		view.CanWrite = httpx.CanWriteProgram(c, bizLine.String(), programID)
	}
	httpx.JSON(c, view, err)
}

func (h *Handler) board(c *gin.Context) {
	var query deliverydto.BoardQuery
	if err := c.ShouldBindQuery(&query); err != nil {
		httpx.Fail(c, err.Error())
		return
	}
	_, bizLine, ok := h.authorizeProgramID(c, query.ProgramID)
	if !ok {
		return
	}
	query.BizLine = bizLine
	view, err := h.delivery.Board(c.Request.Context(), query)
	httpx.JSON(c, view, err)
}

func (h *Handler) listRequirements(c *gin.Context) {
	var query deliverydto.RequirementQuery
	if err := c.ShouldBindQuery(&query); err != nil {
		httpx.Fail(c, err.Error())
		return
	}
	_, bizLine, ok := h.authorizeProgramID(c, query.ProgramID)
	if !ok {
		return
	}
	query.BizLine = bizLine
	query.ActorID = httpx.CallerID(c)
	page, err := h.delivery.ListRequirements(c.Request.Context(), query)
	httpx.JSON(c, page, err)
}

func (h *Handler) getRequirement(c *gin.Context) {
	programID, bizLine, ok := h.authorizeProgram(c)
	if !ok {
		return
	}
	view, err := h.delivery.GetRequirement(c.Request.Context(), bizLine, programID, c.Query("requirementKey"))
	httpx.JSON(c, view, err)
}

func (h *Handler) requirementProgress(c *gin.Context) {
	var query deliverydto.RequirementProgressQuery
	if err := c.ShouldBindQuery(&query); err != nil {
		httpx.Fail(c, err.Error())
		return
	}
	_, bizLine, ok := h.authorizeProgramID(c, query.ProgramID)
	if !ok {
		return
	}
	query.BizLine = bizLine
	view, err := h.delivery.GetRequirementProgress(c.Request.Context(), query)
	httpx.JSON(c, view, err)
}

func (h *Handler) requirementTimeline(c *gin.Context) {
	var query deliverydto.RequirementTimelineQuery
	if err := c.ShouldBindQuery(&query); err != nil {
		httpx.Fail(c, err.Error())
		return
	}
	_, bizLine, ok := h.authorizeProgramID(c, query.ProgramID)
	if !ok {
		return
	}
	query.BizLine = bizLine
	page, err := h.delivery.ListRequirementTimeline(c.Request.Context(), query)
	httpx.JSON(c, page, err)
}

// listPlanningSessions 让工作台在 Worker 回话之前就能把聊天列表铺出来。
func (h *Handler) listPlanningSessions(c *gin.Context) {
	var query deliverydto.PlanningSessionQuery
	if err := c.ShouldBindQuery(&query); err != nil {
		httpx.Fail(c, err.Error())
		return
	}
	_, bizLine, ok := h.authorizeProgramID(c, query.ProgramID)
	if !ok {
		return
	}
	query.BizLine = bizLine
	views, err := h.delivery.ListPlanningSessions(c.Request.Context(), query)
	httpx.JSON(c, views, err)
}

func (h *Handler) saveRequirement(c *gin.Context) {
	var req deliverydto.SaveRequirementRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, err.Error())
		return
	}
	_, bizLine, ok := h.authorizeWritableProgram(c, req.ProgramID)
	if !ok {
		return
	}
	req.BizLine = bizLine
	if !h.normalizeRequirementMembers(c, req.ProgramID, req.Owners, req.Assistants) {
		return
	}
	req.ActorID = httpx.CallerID(c)
	view, err := h.delivery.SaveRequirement(c.Request.Context(), req)
	httpx.JSON(c, view, err)
}

// updateRequirementName 只写名称：新建需求允许不填标题，手机端先写需求编号占位，
// 拆解会话按聊天内容生成标题后再替换。服务端只在名称仍是预期旧值时落库，
// 不会盖掉用户自己改过的名字。
func (h *Handler) updateRequirementName(c *gin.Context) {
	var req deliverydto.UpdateRequirementNameRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, err.Error())
		return
	}
	_, bizLine, ok := h.authorizeWritableProgram(c, req.ProgramID)
	if !ok {
		return
	}
	req.BizLine = bizLine
	req.ActorID = httpx.CallerID(c)
	view, err := h.delivery.UpdateRequirementName(c.Request.Context(), req)
	httpx.JSON(c, view, err)
}

// bindRequirementGitBranch 记录分支关联结果：分支由执行电脑上的 Worker 建好，
// 服务端只在确认之后写关联，不参与本机的 Git 操作。
func (h *Handler) bindRequirementGitBranch(c *gin.Context) {
	var req deliverydto.BindRequirementGitBranchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, err.Error())
		return
	}
	_, bizLine, ok := h.authorizeWritableProgram(c, req.ProgramID)
	if !ok {
		return
	}
	req.BizLine = bizLine
	req.ActorID = httpx.CallerID(c)
	view, err := h.delivery.BindRequirementGitBranch(c.Request.Context(), req)
	httpx.JSON(c, view, err)
}

func (h *Handler) createPlanningBatch(c *gin.Context) {
	var req deliverydto.CreatePlanningBatchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, err.Error())
		return
	}
	_, bizLine, ok := h.authorizeWritableProgram(c, req.ProgramID)
	if !ok {
		return
	}
	req.BizLine = bizLine
	req.ActorID = httpx.CallerID(c)
	view, err := h.delivery.CreatePlanningBatch(c.Request.Context(), req)
	httpx.JSON(c, view, err)
}

// 收件人身份一律取凭证里的 CallerID，不接受请求体里的用户标识 ——
// 否则任何人都能替别人把提醒标成已读。
func (h *Handler) listExecutionBatchNotifications(c *gin.Context) {
	programID, bizLine, ok := h.authorizeProgram(c)
	if !ok {
		return
	}
	views, err := h.delivery.ListExecutionBatchNotifications(c.Request.Context(), deliverydto.ExecutionBatchNotificationQuery{
		BizLine: bizLine, ProgramID: programID, ActorID: httpx.CallerID(c),
	})
	httpx.JSON(c, views, err)
}

func (h *Handler) markExecutionBatchNotificationRead(c *gin.Context) {
	var req deliverydto.MarkExecutionBatchNotificationReadRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, err.Error())
		return
	}
	_, bizLine, ok := h.authorizeProgramID(c, req.ProgramID)
	if !ok {
		return
	}
	req.BizLine = bizLine
	req.ActorID = httpx.CallerID(c)
	view, err := h.delivery.MarkExecutionBatchNotificationRead(c.Request.Context(), req)
	httpx.JSON(c, view, err)
}

func (h *Handler) listRequirementCompletionNotifications(c *gin.Context) {
	programID, bizLine, ok := h.authorizeProgram(c)
	if !ok {
		return
	}
	views, err := h.delivery.ListRequirementCompletionNotifications(c.Request.Context(), deliverydto.RequirementCompletionNotificationQuery{
		BizLine: bizLine, ProgramID: programID, ActorID: httpx.CallerID(c),
	})
	httpx.JSON(c, views, err)
}

func (h *Handler) markRequirementCompletionNotificationRead(c *gin.Context) {
	var req deliverydto.MarkRequirementCompletionNotificationReadRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, err.Error())
		return
	}
	_, bizLine, ok := h.authorizeProgramID(c, req.ProgramID)
	if !ok {
		return
	}
	req.BizLine = bizLine
	req.ActorID = httpx.CallerID(c)
	view, err := h.delivery.MarkRequirementCompletionNotificationRead(c.Request.Context(), req)
	httpx.JSON(c, view, err)
}

func (h *Handler) listItems(c *gin.Context) {
	var query deliverydto.ItemQuery
	if err := c.ShouldBindQuery(&query); err != nil {
		httpx.Fail(c, err.Error())
		return
	}
	_, bizLine, ok := h.authorizeProgramID(c, query.ProgramID)
	if !ok {
		return
	}
	query.BizLine = bizLine
	page, err := h.delivery.ListItems(c.Request.Context(), query)
	httpx.JSON(c, page, err)
}

func (h *Handler) getItem(c *gin.Context) {
	programID, bizLine, ok := h.authorizeProgram(c)
	if !ok {
		return
	}
	view, err := h.delivery.GetItem(c.Request.Context(), bizLine, programID, c.Query("itemKey"))
	httpx.JSON(c, view, err)
}

func (h *Handler) createItem(c *gin.Context) {
	var req deliverydto.SaveItemRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, err.Error())
		return
	}
	_, bizLine, ok := h.authorizeWritableProgram(c, req.ProgramID)
	if !ok {
		return
	}
	req.BizLine = bizLine
	if !h.normalizeItemOwner(c, req.ProgramID, &req.OwnerID, &req.OwnerName) {
		return
	}
	req.ActorID = httpx.CallerID(c)
	view, err := h.delivery.CreateItem(c.Request.Context(), req)
	httpx.JSON(c, view, err)
}

func (h *Handler) patchItem(c *gin.Context) {
	var req deliverydto.PatchItemRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, err.Error())
		return
	}
	_, bizLine, ok := h.authorizeWritableProgram(c, req.ProgramID)
	if !ok {
		return
	}
	req.BizLine = bizLine
	if req.OwnerID != nil {
		ownerName := ""
		if req.OwnerName != nil {
			ownerName = *req.OwnerName
		}
		if !h.normalizeItemOwner(c, req.ProgramID, req.OwnerID, &ownerName) {
			return
		}
		req.OwnerName = &ownerName
	}
	req.ActorID = httpx.CallerID(c)
	view, err := h.delivery.PatchItem(c.Request.Context(), req)
	httpx.JSON(c, view, err)
}

func (h *Handler) authorizeRequestBizLine(c *gin.Context) (contract.BizLine, bool) {
	bizLine := contract.BizLine(strings.TrimSpace(httpx.BizLine(c)))
	if !bizLine.Valid() {
		httpx.Fail(c, "缺少业务线")
		return "", false
	}
	if err := httpx.AuthorizeBizLine(c, bizLine.String()); err != nil {
		httpx.JSON(c, nil, err)
		return "", false
	}
	return bizLine, true
}

func (h *Handler) authorizeProgram(c *gin.Context) (int64, contract.BizLine, bool) {
	programID, err := strconv.ParseInt(c.Query("programId"), 10, 64)
	if err != nil || programID <= 0 {
		httpx.JSON(c, nil, errors.New("缺少项目标识"))
		return 0, "", false
	}
	return h.authorizeProgramID(c, programID)
}

func (h *Handler) authorizeProgramID(c *gin.Context, programID int64) (int64, contract.BizLine, bool) {
	if programID <= 0 {
		httpx.JSON(c, nil, errors.New("缺少项目标识"))
		return 0, "", false
	}
	bizLine, err := h.delivery.ResolveProgramBizLine(c.Request.Context(), programID)
	if err != nil {
		httpx.JSON(c, nil, err)
		return 0, "", false
	}
	if err := httpx.AuthorizeProgramInBizLine(c, bizLine.String(), programID); err != nil {
		httpx.JSON(c, nil, err)
		return 0, "", false
	}
	return programID, bizLine, true
}

func (h *Handler) authorizeWritableProgram(c *gin.Context, programID int64) (int64, contract.BizLine, bool) {
	programID, bizLine, ok := h.authorizeProgramID(c, programID)
	if !ok {
		return 0, "", false
	}
	if !httpx.CanWriteProgram(c, bizLine.String(), programID) {
		httpx.Fail(c, "无权管理该项目")
		return 0, "", false
	}
	return programID, bizLine, true
}

func (h *Handler) normalizeRequirementMembers(c *gin.Context, programID int64, groups ...[]deliverydto.RequirementMember) bool {
	needValidation := false
	for _, group := range groups {
		for _, member := range group {
			if strings.TrimSpace(member.ID) != "" {
				needValidation = true
				break
			}
		}
	}
	if !needValidation {
		return true
	}
	members, err := h.identities.ListProgramMembers(c.Request.Context(), programID)
	if err != nil {
		httpx.JSON(c, nil, err)
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
			name, exists := allowed[id]
			if !exists {
				httpx.Fail(c, "负责人和协助人只能从所属项目成员中选择")
				return false
			}
			group[index].ID = id
			group[index].Name = name
		}
	}
	return true
}

func (h *Handler) normalizeItemOwner(c *gin.Context, programID int64, ownerID, ownerName *string) bool {
	*ownerID = strings.TrimSpace(*ownerID)
	if *ownerID == "" {
		*ownerName = ""
		return true
	}
	members, err := h.identities.ListProgramMembers(c.Request.Context(), programID)
	if err != nil {
		httpx.JSON(c, nil, err)
		return false
	}
	for _, member := range members {
		if member.ID != *ownerID {
			continue
		}
		name := strings.TrimSpace(member.DisplayName)
		if name == "" {
			name = strings.TrimSpace(member.Username)
		}
		if name == "" {
			name = member.ID
		}
		*ownerName = name
		return true
	}
	httpx.Fail(c, "任务负责人只能从所属项目成员中选择")
	return false
}

func businessPrincipal(c *gin.Context) (httpx.UserPrincipal, bool) {
	principal, ok := httpx.CurrentUser(c)
	if !ok || !principal.HasPersona(identity.PersonaBusiness) {
		httpx.JSON(c, nil, errors.New("当前登录身份不是业务方"))
		return httpx.UserPrincipal{}, false
	}
	return principal, true
}

func authorizeBizLine(c *gin.Context, value string, _ httpx.UserPrincipal) (contract.BizLine, bool) {
	bizLine := contract.BizLine(strings.TrimSpace(value))
	if !bizLine.Valid() {
		httpx.Fail(c, "缺少业务线")
		return "", false
	}
	if err := httpx.AuthorizeBizLine(c, bizLine.String()); err != nil {
		httpx.JSON(c, nil, err)
		return "", false
	}
	return bizLine, true
}
