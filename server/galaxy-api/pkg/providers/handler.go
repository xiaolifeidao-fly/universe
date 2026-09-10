// Package providers 是提供者控制台：同意条款、拿配对码、看贡献与用量、随时停。
// 全部走控制台用户令牌，返回统一信封。
package providers

import (
	"strconv"
	"strings"
	"time"

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
	// 「今天」那一页：一个请求拿全。
	api.GET("/dashboard", h.dashboard)
	api.GET("/ledger", h.ledger)
	api.GET("/payouts", h.listPayouts)
	api.POST("/payouts", h.createPayout)
}

// dashboard 「今天」那一页的全部数字。
func (h *Handler) dashboard(context *gin.Context) {
	view, err := h.service.ProviderDashboard(context.Request.Context(), httpx.CallerID(context))
	httpx.JSON(context, view, err)
}

// ledger 积分账本。分页，按类型筛。
func (h *Handler) ledger(context *gin.Context) {
	offset, _ := strconv.Atoi(context.Query("offset"))
	limit, _ := strconv.Atoi(context.Query("limit"))
	page, err := h.service.ProviderLedger(context.Request.Context(), dto.LedgerQuery{
		OwnerUserID: httpx.CallerID(context), Type: context.Query("type"),
		Offset: offset, Limit: limit,
	})
	httpx.JSON(context, page, err)
}

func (h *Handler) listPayouts(context *gin.Context) {
	limit, _ := strconv.Atoi(context.DefaultQuery("limit", "20"))
	views, err := h.service.ListPayouts(context.Request.Context(), httpx.CallerID(context), limit)
	httpx.JSON(context, views, err)
}

// createPayout 提现。金额与手续费一律由服务端按积分算，请求里只带积分数 ——
// 让前端把「到账多少」传上来，等于把兑换比交给了客户端。
func (h *Handler) createPayout(context *gin.Context) {
	var req dto.CreatePayoutRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	req.OwnerUserID = httpx.CallerID(context)
	view, err := h.service.CreatePayout(context.Request.Context(), req)
	httpx.JSON(context, view, err)
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
//
// 带 offset / model / state / day 的请求走分页版本，返回 {records, total, stats}；
// 不带的沿用老形状（一个数组），让还没改的调用方不至于突然拿到一个对象。
func (h *Handler) listRecords(context *gin.Context) {
	paged := context.Query("offset") != "" || context.Query("model") != "" ||
		context.Query("state") != "" || context.Query("day") != "" || context.Query("paged") == "1"
	if !paged {
		limit, _ := strconv.Atoi(context.DefaultQuery("limit", "100"))
		records, err := h.service.ListExecutionRecords(context.Request.Context(), httpx.CallerID(context), context.Query("cid"), limit)
		httpx.JSON(context, records, err)
		return
	}
	offset, _ := strconv.Atoi(context.Query("offset"))
	limit, _ := strconv.Atoi(context.DefaultQuery("limit", "20"))
	query := dto.ProviderRecordQuery{
		OwnerUserID: httpx.CallerID(context), CID: context.Query("cid"),
		Model: context.Query("model"), State: context.Query("state"),
		Offset: offset, Limit: limit,
	}
	query.From, query.To = dayRange(context.Query("day"))
	page, err := h.service.ProviderRecords(context.Request.Context(), query)
	httpx.JSON(context, page, err)
}

// dayRange 把 day=today / yesterday / 2026-09-10 翻成一个左闭右开区间。
//
// 区间在服务端算，不接受前端传来的 from/to：跨零点那一刻两边的「今天」会差一天，
// 而这一页上「今日调用 316」和列表里的行数必须是同一个口径。
func dayRange(day string) (time.Time, time.Time) {
	now := time.Now()
	start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	switch strings.TrimSpace(day) {
	case "", "all":
		return time.Time{}, time.Time{}
	case "today":
		return start, start.AddDate(0, 0, 1)
	case "yesterday":
		return start.AddDate(0, 0, -1), start
	case "7d":
		return start.AddDate(0, 0, -6), start.AddDate(0, 0, 1)
	case "30d":
		return start.AddDate(0, 0, -29), start.AddDate(0, 0, 1)
	}
	parsed, err := time.ParseInLocation("2006-01-02", day, now.Location())
	if err != nil {
		return time.Time{}, time.Time{}
	}
	return parsed, parsed.AddDate(0, 0, 1)
}

func (h *Handler) credits(context *gin.Context) {
	balance, err := h.service.CreditBalance(context.Request.Context(), httpx.CallerID(context))
	httpx.JSON(context, gin.H{"balance": balance}, err)
}
