// Package businessrequirements exposes the business-side requirement intake API.
package businessrequirements

import (
	"errors"
	"strings"

	"common/middleware/httpx"
	"common/middleware/routers"
	"contract"
	"service/business"
	"service/business/dto"
	"service/identity"

	"github.com/gin-gonic/gin"
)

type Handler struct{ service business.Service }

func NewHandler(service business.Service) *Handler { return &Handler{service: service} }

func (h *Handler) RegisterHandler(group *gin.RouterGroup) {
	api := group.Group("/business", httpx.RequireUser())
	api.GET("/programs", h.listPrograms)
	api.GET("/requirements", h.list)
	api.POST("/requirements", h.create)
	api.GET("/requirement", h.getConversation)
	api.POST("/requirement/messages", h.sendMessage)

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
	result, err := h.service.SendMessage(context.Request.Context(), req)
	httpx.JSON(context, result, err)
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
