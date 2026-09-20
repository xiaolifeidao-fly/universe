// Package providers 是提供者控制台：同意条款、拿配对码、看贡献与用量、随时停。
// 全部走共享端账号的令牌（auth.Gate.Provider），返回统一信封。
package providers

import (
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"common/middleware/httpx"
	"galaxy-common/auth"
	"service/galaxy"
	"service/galaxy/dto"
)

type Handler struct {
	service galaxy.Service
	gate    *auth.Gate
}

func NewHandler(service galaxy.Service, gate *auth.Gate) *Handler {
	return &Handler{service: service, gate: gate}
}

// RegisterHandler 整组只认共享端账号：使用端的令牌打进来是 not login。
// 登录、注册那几条不在这里，在 auth 包 —— 它们要在门外面。
func (h *Handler) RegisterHandler(group *gin.RouterGroup) {
	api := group.Group("/provider", h.gate.Provider())
	api.POST("/terms/accept", h.acceptTerms)
	api.GET("/terms", h.currentTerms)
	api.POST("/pairing-code", h.issuePairingCode)
	// 接入密钥：给单独部署的 rust bridge 用，代替配对码。
	api.GET("/access-keys", h.listProviderKeys)
	api.POST("/access-keys", h.issueProviderKey)
	api.POST("/access-keys/revoke", h.revokeProviderKey)
	api.GET("/nodes", h.listNodes)
	// 解绑掉的机器单独一个接口：/nodes 的调用方（今天、共享设置）都靠它不含解绑的行。
	api.GET("/nodes/retired", h.listRetiredNodes)
	api.POST("/node/revoke", h.revokeNode)
	api.POST("/contribution/status", h.setContributionStatus)
	api.POST("/contribution/limits", h.saveContributionLimits)
	// 模型页：跑哪个模型能记多少积分。只给结算价 —— 对外价不经这条接口。
	api.GET("/models", h.models)
	api.GET("/records", h.listRecords)
	api.GET("/credits", h.credits)
	api.GET("/endpoint", h.providerEndpoint)
	// 「今天」那一页：一个请求拿全。
	api.GET("/dashboard", h.dashboard)
	api.GET("/ledger", h.ledger)
	api.GET("/payouts", h.listPayouts)
	api.POST("/payouts", h.createPayout)
	// 机器上的 ai-bridge：装哪儿下载、把远端那台升上去。
	// 清单本身是公开的（/agent/v1/bridge/releases/latest），这条只是让控制台
	// 和别的接口走同一套鉴权与信封，顺带把平台地址一起给前端。
	api.GET("/bridge/releases", h.bridgeReleases)
	api.POST("/node/upgrade", h.upgradeNode)
	// 邀请返现。
	api.GET("/referral", h.referral)
	api.GET("/referral/invitees", h.referralInvitees)
}

// models 共享端的模型页。一个请求拿全：模型说明、四档结算单价、
// 自己的名单允不允许、机器上有没有、最近 7 天它赚了多少。
func (h *Handler) models(context *gin.Context) {
	views, err := h.service.ProviderModels(context.Request.Context(), auth.UserID(context))
	httpx.JSON(context, views, err)
}

// bridgeReleases 下载清单：每个平台最新的那一版，加上安装脚本地址。
func (h *Handler) bridgeReleases(context *gin.Context) {
	manifest, err := h.service.BridgeManifest(context.Request.Context())
	httpx.JSON(context, manifest, err)
}

// upgradeNode 把这台机器上的 ai-bridge 升到最新版。
//
// 这里只是记下「该升到哪一版」：指令搭在下一次心跳上下发，装不装得成由节点说了算。
// 所以它返回得很快，界面上的进度要靠轮询机器列表看。
func (h *Handler) upgradeNode(context *gin.Context) {
	var req struct {
		NodeID string `json:"nodeId" binding:"required"`
	}
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	view, err := h.service.RequestNodeUpgrade(context.Request.Context(), auth.UserID(context), req.NodeID)
	httpx.JSON(context, view, err)
}

// referral 邀请页顶上那一块：邀请码、链接、比例与几个数。
func (h *Handler) referral(context *gin.Context) {
	view, err := h.service.ProviderReferral(context.Request.Context(), auth.UserID(context))
	httpx.JSON(context, view, err)
}

// referralInvitees 邀请来的人，分页。
func (h *Handler) referralInvitees(context *gin.Context) {
	offset, _ := strconv.Atoi(context.Query("offset"))
	limit, _ := strconv.Atoi(context.DefaultQuery("limit", "20"))
	page, err := h.service.ListProviderInvitees(context.Request.Context(), auth.UserID(context), offset, limit)
	httpx.JSON(context, page, err)
}

// dashboard 「今天」那一页的全部数字。
func (h *Handler) dashboard(context *gin.Context) {
	view, err := h.service.ProviderDashboard(context.Request.Context(), auth.UserID(context))
	httpx.JSON(context, view, err)
}

// ledger 积分账本。分页，按类型筛。
func (h *Handler) ledger(context *gin.Context) {
	offset, _ := strconv.Atoi(context.Query("offset"))
	limit, _ := strconv.Atoi(context.Query("limit"))
	page, err := h.service.ProviderLedger(context.Request.Context(), dto.LedgerQuery{
		OwnerUserID: auth.UserID(context), Type: context.Query("type"),
		Offset: offset, Limit: limit,
	})
	httpx.JSON(context, page, err)
}

func (h *Handler) listPayouts(context *gin.Context) {
	limit, _ := strconv.Atoi(context.DefaultQuery("limit", "20"))
	views, err := h.service.ListPayouts(context.Request.Context(), auth.UserID(context), limit)
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
	req.OwnerUserID = auth.UserID(context)
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
		UserID:       auth.UserID(context),
		TermsVersion: version,
		IP:           context.ClientIP(),
		UserAgent:    context.GetHeader("User-Agent"),
	})
	httpx.JSON(context, version, err)
}

func (h *Handler) currentTerms(context *gin.Context) {
	version := h.service.Config().ProviderTermsVersion
	accepted, err := h.service.HasConsent(context.Request.Context(), "provider", auth.UserID(context), version)
	httpx.JSON(context, gin.H{"version": version, "accepted": accepted}, err)
}

func (h *Handler) issuePairingCode(context *gin.Context) {
	view, err := h.service.IssuePairingCode(context.Request.Context(), dto.IssuePairingCodeRequest{
		OwnerUserID:  auth.UserID(context),
		TermsVersion: h.service.Config().ProviderTermsVersion,
	})
	httpx.JSON(context, view, err)
}

// issueProviderKey 签发一把接入密钥。**明文只在这一次响应里出现**，
// 之后任何接口都取不回来 —— 界面必须当场让主人复制走。
func (h *Handler) issueProviderKey(context *gin.Context) {
	var req dto.IssueProviderKeyRequest
	// 别名和有效期都是可选的，请求体允许为空。绑定失败不当错误处理 ——
	// 一个不带 body 的 POST 是这个接口最常见的用法。
	_ = context.ShouldBindJSON(&req)
	req.OwnerUserID = auth.UserID(context)
	view, err := h.service.IssueProviderKey(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) listProviderKeys(context *gin.Context) {
	views, err := h.service.ListProviderKeys(context.Request.Context(), auth.UserID(context))
	httpx.JSON(context, views, err)
}

// revokeProviderKey 吊销。已经用它注册出来的机器不受影响 ——
// 那些机器手里是各自的 node token，要停哪一台去机器列表里撤销那一台。
func (h *Handler) revokeProviderKey(context *gin.Context) {
	var req struct {
		KeyID string `json:"keyId" binding:"required"`
	}
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	err := h.service.RevokeProviderKey(context.Request.Context(), auth.UserID(context), req.KeyID)
	httpx.JSON(context, req.KeyID, err)
}

func (h *Handler) listNodes(context *gin.Context) {
	views, err := h.service.ListNodes(context.Request.Context(), auth.UserID(context))
	httpx.JSON(context, views, err)
}

func (h *Handler) listRetiredNodes(context *gin.Context) {
	views, err := h.service.ListRetiredNodes(context.Request.Context(), auth.UserID(context))
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
	err := h.service.RevokeNode(context.Request.Context(), auth.UserID(context), req.NodeID)
	httpx.JSON(context, req.NodeID, err)
}

// setContributionStatus 是紧急闸（P-09）与运行时调整（P-08）的入口。
//
// 关闭时手上还有在跑的请求，默认是**排队**：停止接新单，在途跑完自动落地，
// 主人点一次就行。带 force 才会当场掐断在跑的请求，代价是扣信誉分。
//
// 返回的是结果对象而不是回声那个 status：立即生效还是在排队、还剩几条在跑、
// 扣没扣分，界面只看 HTTP 200 分不出来。
func (h *Handler) setContributionStatus(context *gin.Context) {
	// NodeID 不能省：cid 在这里是**去掉节点前缀**的短名（relay_codex），
	// 主人有两台机器时就重名了。不带节点，服务端只能猜一个，而它猜的是
	// 排序第一个（node_id 是 ULID，等于最老那台）—— 改到的是别的机器。
	var req dto.SetContributionStatusRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	result, err := h.service.SetContributionStatus(context.Request.Context(), auth.UserID(context), req)
	httpx.JSON(context, result, err)
}

// saveContributionLimits 改授权：模型白名单、座位、三维额度、挂机时段（P-04~P-07）。
func (h *Handler) saveContributionLimits(context *gin.Context) {
	var req dto.SaveContributionLimitsRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	req.OwnerUserID = auth.UserID(context)
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
		records, err := h.service.ListExecutionRecords(context.Request.Context(), auth.UserID(context), context.Query("cid"), limit)
		httpx.JSON(context, records, err)
		return
	}
	offset, _ := strconv.Atoi(context.Query("offset"))
	limit, _ := strconv.Atoi(context.DefaultQuery("limit", "20"))
	query := dto.ProviderRecordQuery{
		OwnerUserID: auth.UserID(context), CID: context.Query("cid"),
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
	balance, err := h.service.CreditBalance(context.Request.Context(), auth.UserID(context))
	httpx.JSON(context, gin.H{"balance": balance}, err)
}
