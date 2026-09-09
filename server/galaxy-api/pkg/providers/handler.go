// Package providers 是提供者控制台：同意条款、拿配对码、看贡献与用量、随时停。
// 全部走控制台用户令牌，返回统一信封。
package providers

import (
	"strconv"

	"github.com/gin-gonic/gin"

	"common/middleware/httpx"
	"service/galaxy"
	"service/galaxy/dto"
)

type Handler struct {
	service galaxy.Service
}

func NewHandler(service galaxy.Service) *Handler {
	return &Handler{service: service}
}

func (h *Handler) RegisterHandler(group *gin.RouterGroup) {
	api := group.Group("/provider", httpx.RequireUser())
	api.POST("/terms/accept", h.acceptTerms)
	api.GET("/terms", h.currentTerms)
	api.POST("/pairing-code", h.issuePairingCode)
	api.GET("/nodes", h.listNodes)
	api.POST("/node/revoke", h.revokeNode)
	api.POST("/contribution/status", h.setContributionStatus)
	api.POST("/contribution/limits", h.saveContributionLimits)
	api.GET("/records", h.listRecords)
	api.GET("/credits", h.credits)
	api.GET("/endpoint", h.providerEndpoint)
}

// providerEndpoint 提供者的 ai-bridge 要填的 pool.hubURL。
//
// 和消费者那边的 /consumer/endpoint 对称，理由也一样：这个地址只有部署方知道
// （反代端口、公网入口、是不是套了 TLS），前端拼不出来。节点连错地方时它连不上
// Hub，也就不会出现在任何列表里 —— 界面上除了一个空列表什么都看不见，
// 所以这个值必须由 Hub 主动报出来，而不是从「已连上的节点」里读。
func (h *Handler) providerEndpoint(context *gin.Context) {
	httpx.JSON(context, gin.H{"hubUrl": h.service.Config().ProviderHubURL}, nil)
}

// acceptTerms 加入共享池前必须明示同意（P-16）：订阅条款风险、数据经本机处理、
// 平台调度与结算规则。没有这条记录就拿不到配对码。
func (h *Handler) acceptTerms(context *gin.Context) {
	version := h.service.Config().ProviderTermsVersion
	err := h.service.AcceptTerms(context.Request.Context(), dto.AcceptTermsRequest{
		SubjectType:  "provider",
		UserID:       httpx.CallerID(context),
		TermsVersion: version,
		IP:           context.ClientIP(),
		UserAgent:    context.GetHeader("User-Agent"),
	})
	httpx.JSON(context, version, err)
}

func (h *Handler) currentTerms(context *gin.Context) {
	version := h.service.Config().ProviderTermsVersion
	accepted, err := h.service.HasConsent(context.Request.Context(), "provider", httpx.CallerID(context), version)
	httpx.JSON(context, gin.H{"version": version, "accepted": accepted}, err)
}

func (h *Handler) issuePairingCode(context *gin.Context) {
	view, err := h.service.IssuePairingCode(context.Request.Context(), dto.IssuePairingCodeRequest{
		OwnerUserID:  httpx.CallerID(context),
		TermsVersion: h.service.Config().ProviderTermsVersion,
	})
	httpx.JSON(context, view, err)
}

func (h *Handler) listNodes(context *gin.Context) {
	views, err := h.service.ListNodes(context.Request.Context(), httpx.CallerID(context))
	httpx.JSON(context, views, err)
}

func (h *Handler) revokeNode(context *gin.Context) {
	var req struct {
		NodeID string `json:"nodeId" binding:"required"`
	}
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	err := h.service.RevokeNode(context.Request.Context(), httpx.CallerID(context), req.NodeID)
	httpx.JSON(context, req.NodeID, err)
}

// setContributionStatus 是紧急闸（P-09）与运行时调整（P-08）的入口：
// 停掉的贡献排空在途后释放座位，不中断在跑的请求。
func (h *Handler) setContributionStatus(context *gin.Context) {
	var req struct {
		// NodeID 不能省：cid 在这里是**去掉节点前缀**的短名（relay_codex），
		// 主人有两台机器时就重名了。不带节点，服务端只能猜一个，而它猜的是
		// 排序第一个（node_id 是 ULID，等于最老那台）—— 改到的是别的机器。
		NodeID string `json:"nodeId"`
		CID    string `json:"cid" binding:"required"`
		Status string `json:"status" binding:"required"`
	}
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	err := h.service.SetContributionStatus(context.Request.Context(), httpx.CallerID(context), req.NodeID, req.CID, req.Status)
	httpx.JSON(context, req.Status, err)
}

// saveContributionLimits 改授权：模型白名单、座位、三维额度、挂机时段（P-04~P-07）。
func (h *Handler) saveContributionLimits(context *gin.Context) {
	var req dto.SaveContributionLimitsRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	req.OwnerUserID = httpx.CallerID(context)
	err := h.service.SaveContributionLimits(context.Request.Context(), req)
	httpx.JSON(context, req.CID, err)
}

// listRecords 「我的机器上跑过什么」（P-14）：匿名化，不含消费者内容与身份。
func (h *Handler) listRecords(context *gin.Context) {
	limit, _ := strconv.Atoi(context.DefaultQuery("limit", "100"))
	records, err := h.service.ListExecutionRecords(context.Request.Context(), httpx.CallerID(context), context.Query("cid"), limit)
	httpx.JSON(context, records, err)
}

func (h *Handler) credits(context *gin.Context) {
	balance, err := h.service.CreditBalance(context.Request.Context(), httpx.CallerID(context))
	httpx.JSON(context, gin.H{"balance": balance}, err)
}
