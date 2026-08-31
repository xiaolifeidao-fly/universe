// Package businessrequirements exposes the business-side requirement intake API.
package businessrequirements

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"

	"common/middleware/httpx"
	"common/middleware/routers"
	"contract"
	"service/business"
	"service/business/dto"
	"service/identity"

	"github.com/gin-gonic/gin"
)

// 与远端桥一致的单个附件上限，超出的请求在读取时就截断，不占内存也不转发。
const maxUploadBytes = 20 * 1024 * 1024

type Handler struct{ service business.Service }

func NewHandler(service business.Service) *Handler { return &Handler{service: service} }

func (h *Handler) RegisterHandler(group *gin.RouterGroup) {
	api := group.Group("/business", httpx.RequireUser())
	api.GET("/programs", h.listPrograms)
	api.GET("/requirements", h.list)
	api.POST("/requirements", h.create)
	api.GET("/requirement", h.getConversation)
	api.POST("/requirement/messages", h.sendMessage)
	api.POST("/requirement/attachments", h.uploadAttachments)
	api.GET("/requirement/attachment", h.getAttachment)
	api.GET("/requirement/references", h.listDocumentReferences)

	collection := group.Group("/business/research", httpx.RequireProductResearch())
	collection.GET("/requirements", h.listCollectedRequirements)
	collection.GET("/requirement", h.getCollectedConversation)
}

func (h *Handler) listPrograms(context *gin.Context) {
	if _, ok := requireBusinessUser(context); !ok {
		return
	}
	bizLine := strings.TrimSpace(httpx.BizLine(context))
	if err := httpx.AuthorizeBizLine(context, bizLine); err != nil {
		httpx.JSON(context, nil, err)
		return
	}
	programs, err := h.service.ListPrograms(context.Request.Context(), contract.BizLine(bizLine))
	httpx.JSON(context, programs, err)
}

func (h *Handler) list(context *gin.Context) {
	principal, ok := requireBusinessUser(context)
	if !ok {
		return
	}
	var query struct {
		PageIndex int    `form:"pageIndex"`
		PageSize  int    `form:"pageSize"`
		BizLine   string `form:"bizLine"`
	}
	if err := context.ShouldBindQuery(&query); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	bizLine := strings.TrimSpace(query.BizLine)
	if err := httpx.AuthorizeBizLine(context, bizLine); err != nil {
		httpx.JSON(context, nil, err)
		return
	}
	page, err := h.service.ListRequirements(context.Request.Context(), dto.RequirementQuery{
		Page: dto.Page{PageIndex: query.PageIndex, PageSize: query.PageSize}, BizLine: contract.BizLine(bizLine), CreatorID: principal.ID,
	})
	httpx.JSON(context, page, err)
}

func (h *Handler) create(context *gin.Context) {
	principal, ok := requireBusinessUser(context)
	if !ok {
		return
	}
	var req dto.CreateRequirementRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	req.CreatorID = principal.ID
	req.CreatorUsername = principal.Username
	req.CreatorName = principal.DisplayName
	req.AccessibleBizLines = append(append([]string{}, principal.BizLines...), principal.ManagedBizLines...)
	view, err := h.service.CreateRequirement(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) getConversation(context *gin.Context) {
	principal, ok := requireBusinessUser(context)
	if !ok {
		return
	}
	var query struct {
		BizLine       string `form:"bizLine"`
		RequirementID int64  `form:"requirementId"`
	}
	if err := context.ShouldBindQuery(&query); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	bizLine := strings.TrimSpace(query.BizLine)
	if err := httpx.AuthorizeBizLine(context, bizLine); err != nil {
		httpx.JSON(context, nil, err)
		return
	}
	conversation, err := h.service.GetConversation(context.Request.Context(), dto.ConversationQuery{
		BizLine: contract.BizLine(bizLine), RequirementID: query.RequirementID, CreatorID: principal.ID,
	})
	httpx.JSON(context, conversation, err)
}

// listDocumentReferences powers the @ picker in the intake composer: the
// documents this project's earlier interviews already produced.
func (h *Handler) listDocumentReferences(context *gin.Context) {
	principal, ok := requireBusinessUser(context)
	if !ok {
		return
	}
	var query struct {
		BizLine       string `form:"bizLine"`
		RequirementID int64  `form:"requirementId"`
		Keyword       string `form:"keyword"`
	}
	if err := context.ShouldBindQuery(&query); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	bizLine := strings.TrimSpace(query.BizLine)
	if err := httpx.AuthorizeBizLine(context, bizLine); err != nil {
		httpx.JSON(context, nil, err)
		return
	}
	references, err := h.service.ListDocumentReferences(context.Request.Context(), dto.DocumentReferenceQuery{
		BizLine: contract.BizLine(bizLine), RequirementID: query.RequirementID,
		CreatorID: principal.ID, Keyword: strings.TrimSpace(query.Keyword),
	})
	httpx.JSON(context, references, err)
}

func (h *Handler) sendMessage(context *gin.Context) {
	principal, ok := requireBusinessUser(context)
	if !ok {
		return
	}
	var req dto.SendMessageRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	bizLine := strings.TrimSpace(context.Query("bizLine"))
	if err := httpx.AuthorizeBizLine(context, bizLine); err != nil {
		httpx.JSON(context, nil, err)
		return
	}
	req.BizLine = contract.BizLine(bizLine)
	req.CreatorID = principal.ID
	req.CreatorUsername = principal.Username
	result, err := h.service.SendMessage(context.Request.Context(), req)
	httpx.JSON(context, result, err)
}

// uploadAttachments accepts the browser's files for one intake conversation.
// The bytes are forwarded to the requirement's remote business workspace; this
// service only keeps their manifest.
func (h *Handler) uploadAttachments(context *gin.Context) {
	principal, ok := requireBusinessUser(context)
	if !ok {
		return
	}
	bizLine := strings.TrimSpace(context.Query("bizLine"))
	if err := httpx.AuthorizeBizLine(context, bizLine); err != nil {
		httpx.JSON(context, nil, err)
		return
	}
	requirementID, err := strconv.ParseInt(strings.TrimSpace(context.PostForm("requirementId")), 10, 64)
	if err != nil || requirementID <= 0 {
		httpx.Fail(context, "业务需求标识无效")
		return
	}
	form, err := context.MultipartForm()
	if err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	files := form.File["files"]
	if len(files) == 0 {
		httpx.Fail(context, "请选择要上传的文件")
		return
	}
	uploads := make([]dto.AttachmentUpload, 0, len(files))
	for _, header := range files {
		opened, err := header.Open()
		if err != nil {
			httpx.Fail(context, err.Error())
			return
		}
		data, err := io.ReadAll(io.LimitReader(opened, maxUploadBytes+1))
		_ = opened.Close()
		if err != nil {
			httpx.Fail(context, err.Error())
			return
		}
		if int64(len(data)) > maxUploadBytes {
			httpx.Fail(context, "附件 "+header.Filename+" 超过 20 MB")
			return
		}
		uploads = append(uploads, dto.AttachmentUpload{
			Name: header.Filename, ContentType: header.Header.Get("Content-Type"), Data: data,
		})
	}
	attachments, err := h.service.UploadAttachments(context.Request.Context(), dto.UploadAttachmentsRequest{
		RequirementID: requirementID, Files: uploads,
		BizLine: contract.BizLine(bizLine), CreatorID: principal.ID, CreatorUsername: principal.Username,
	})
	httpx.JSON(context, attachments, err)
}

// getAttachment streams one stored file back to the console preview.
func (h *Handler) getAttachment(context *gin.Context) {
	principal, ok := requireBusinessUser(context)
	if !ok {
		return
	}
	var query struct {
		BizLine       string `form:"bizLine"`
		RequirementID int64  `form:"requirementId"`
		AttachmentID  string `form:"attachmentId"`
	}
	if err := context.ShouldBindQuery(&query); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	bizLine := strings.TrimSpace(query.BizLine)
	if err := httpx.AuthorizeBizLine(context, bizLine); err != nil {
		httpx.JSON(context, nil, err)
		return
	}
	content, err := h.service.GetAttachment(context.Request.Context(), dto.AttachmentQuery{
		RequirementID: query.RequirementID, AttachmentID: strings.TrimSpace(query.AttachmentID),
		BizLine: contract.BizLine(bizLine), CreatorID: principal.ID,
	})
	if err != nil {
		httpx.JSON(context, nil, err)
		return
	}
	contentType := strings.TrimSpace(content.ContentType)
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	// 附件是业务方自己上传的任意文件，浏览器不能按嗅探出来的类型执行它。
	context.Header("X-Content-Type-Options", "nosniff")
	context.Header("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": content.Name}))
	context.Data(http.StatusOK, contentType, content.Data)
}

func (h *Handler) listCollectedRequirements(context *gin.Context) {
	var query struct {
		PageIndex int    `form:"pageIndex"`
		PageSize  int    `form:"pageSize"`
		BizLine   string `form:"bizLine"`
	}
	if err := context.ShouldBindQuery(&query); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	bizLine := strings.TrimSpace(query.BizLine)
	if err := httpx.AuthorizeBizLine(context, bizLine); err != nil {
		httpx.JSON(context, nil, err)
		return
	}
	page, err := h.service.ListCollectedRequirements(context.Request.Context(), dto.CollectedRequirementQuery{
		Page: dto.Page{PageIndex: query.PageIndex, PageSize: query.PageSize}, BizLine: contract.BizLine(bizLine),
	})
	httpx.JSON(context, page, err)
}

func (h *Handler) getCollectedConversation(context *gin.Context) {
	var query struct {
		BizLine       string `form:"bizLine"`
		RequirementID int64  `form:"requirementId"`
	}
	if err := context.ShouldBindQuery(&query); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	bizLine := strings.TrimSpace(query.BizLine)
	if err := httpx.AuthorizeBizLine(context, bizLine); err != nil {
		httpx.JSON(context, nil, err)
		return
	}
	conversation, err := h.service.GetCollectedConversation(context.Request.Context(), dto.CollectedConversationQuery{
		BizLine: contract.BizLine(bizLine), RequirementID: query.RequirementID,
	})
	httpx.JSON(context, conversation, err)
}

func requireBusinessUser(context *gin.Context) (httpx.UserPrincipal, bool) {
	principal, ok := httpx.CurrentUser(context)
	if !ok || !principal.HasPersona(identity.PersonaBusiness) {
		httpx.JSON(context, nil, errors.New("当前登录身份不是业务方"))
		return httpx.UserPrincipal{}, false
	}
	return principal, true
}

var _ routers.Handler = (*Handler)(nil)
