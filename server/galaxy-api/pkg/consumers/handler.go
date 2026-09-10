// Package consumers 是消费者侧的平台原生接口：产物签名、用量明细、密钥自述，
// 以及控制台里的密钥签发与吊销。
//
// /v1/* 用 sk- 算力密钥鉴权，返回体不套 httpx.JSON 信封 —— 它和官方 SDK 共用一个
// base_url，信封会污染 SDK 的解析。控制台接口在 /api/galaxy/* 下，走统一信封。
package consumers

import (
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"common/middleware/httpx"
	corepkg "galaxy-api/adapters/core"
	"service/galaxy"
	"service/galaxy/dto"
)

type Handler struct {
	service galaxy.Service
}

func NewHandler(service galaxy.Service) *Handler {
	return &Handler{service: service}
}

// RegisterNative 挂在根路由下，与 relay 的 /v1/messages 同一鉴权。
func (h *Handler) RegisterNative(group *gin.RouterGroup) {
	group.POST("/artifacts", h.signUpload)
	group.GET("/artifacts/*objectKey", h.signDownload)
	group.GET("/usage", h.usage)
	group.GET("/keys/me", h.describeKey)
	// 用已有密钥给自己续费或续期。第一把密钥买不了 —— 那要走控制台。
	group.POST("/orders", h.createOrderWithKey)
	group.POST("/keys/:keyId/renew", h.renewKeyWithKey)
}

// RegisterConsole 挂在 /api/galaxy 下，用控制台用户令牌鉴权。
func (h *Handler) RegisterConsole(group *gin.RouterGroup) {
	console := group.Group("/consumer", httpx.RequireUser())
	// SDK 接入要的两样东西之一（另一样是密钥）。地址由服务端给，
	// 前端不该再配一遍 —— 配两处迟早对不上。
	console.GET("/endpoint", h.consumerEndpoint)
	console.GET("/notice", h.currentNotice)
	console.POST("/notice/accept", h.acceptNotice)
	console.GET("/keys", h.listKeys)
	console.POST("/keys/revoke", h.revokeKey)
	console.GET("/usage", h.consoleUsage)
	// 逐笔扣费与页头那排数字。汇总回答「这个月花了多少」，逐笔回答
	// 「那一次为什么扣了这么多」——申诉从后者进去。
	console.GET("/usage/records", h.consoleUsageRecords)
	console.GET("/dashboard", h.consoleDashboard)
	console.POST("/keys/renew", h.renewKey)
	// 会话与任务的只读视图。路径都带上 :sid / :jobId 这一段再接动作，
	// 避免 /jobs/cancel 这种静态段和 /jobs/:jobId 在同一层打架。
	console.GET("/sessions", h.consoleSessions)
	console.GET("/sessions/:sid/context", h.consoleSessionContext)
	console.POST("/sessions/:sid/close", h.consoleCloseSession)
	console.GET("/jobs", h.consoleJobs)
	console.GET("/jobs/:jobId", h.consoleJob)
	console.GET("/jobs/:jobId/events", h.consoleJobEvents)
	console.POST("/jobs/:jobId/cancel", h.consoleCancelJob)
	// 争议工单：消费者建单、看自己的、撤单。裁决在运营后台，不在这儿。
	console.GET("/disputes", h.consoleDisputes)
	console.POST("/disputes", h.consoleFileDispute)
	console.POST("/disputes/:disputeId/withdraw", h.consoleWithdrawDispute)
	console.GET("/packages", h.listPackages)
	console.GET("/payments/channels", h.paymentChannels)
	console.POST("/orders", h.createOrder)
	console.GET("/orders", h.listOrders)
	console.POST("/orders/cancel", h.cancelOrder)
	// 沙箱支付。它不是「管理员确认到账」的简写：认的是本人，且只对配置里
	// 显式标成沙箱的渠道生效，没配沙箱的部署调进来只会拿到错误。
	console.POST("/orders/pay/sandbox", h.paySandbox)
	// 签发是后台动作：P0 内测密钥由管理员发（C-10）。
	console.POST("/keys/issue", httpx.RequirePlatformAdmin(), h.issueKey)
	// 人工确认到账。渠道回调走 RegisterCallbacks 那条验签的路，这条是它的兜底：
	// 线下转账、渠道回调丢了要补单，都得有个人能按下去。所以它只认管理员。
	console.POST("/orders/pay", httpx.RequirePlatformAdmin(), h.payOrder)
	// 商品目录的维护挪去了 /api/galaxy/admin/packages*：它是运营动作，
	// 和池水位、封禁、裁决在同一组，不该挂在消费者路由组里靠一个中间件把门。
}

// RegisterCallbacks 挂支付渠道回调。
//
// 它不在 /api/galaxy 下，也不带任何用户鉴权 —— 打过来的是支付渠道的服务器，
// 手里没有、也不该有用户令牌。它的身份由**报文签名**证明，验签在
// service 那一层做（galaxy.PaymentVerifier）。
//
// 没接渠道时这组路由压根不注册：一个能被任何人 POST 的支付回调，
// 等于把「发额度」这件事挂在公网上。
func (h *Handler) RegisterCallbacks(group *gin.RouterGroup) {
	if !h.service.PaymentEnabled() {
		return
	}
	group.POST("/payments/:channel/callback", h.paymentCallback)
}

// callbackBodyLimit 回调报文的上限。渠道通知都是几百字节的小报文，
// 留 64KB 已经很宽松 —— 这道闸挡的是拿未鉴权入口灌内存。
const callbackBodyLimit = 64 << 10

func (h *Handler) paymentCallback(context *gin.Context) {
	body, err := io.ReadAll(io.LimitReader(context.Request.Body, callbackBodyLimit+1))
	if err != nil || len(body) > callbackBodyLimit {
		context.JSON(http.StatusBadRequest, gin.H{"code": "FAIL", "message": "报文过大或无法读取"})
		return
	}
	headers := make(map[string]string, len(context.Request.Header))
	for name := range context.Request.Header {
		headers[name] = context.GetHeader(name)
	}
	view, err := h.service.PayOrderByCallback(context.Request.Context(), galaxy.PaymentCallback{
		Channel: context.Param("channel"), Headers: headers, Body: body, ReceivedAt: time.Now(),
	})
	if err != nil {
		// 4xx 而不是 5xx：验签不过、金额对不上这类问题重推一百次也不会变好，
		// 让渠道停下来，人去查。日志里只留订单号与原因，不留报文。
		log.Printf("galaxy payment callback rejected: channel=%s err=%v", context.Param("channel"), err)
		context.JSON(http.StatusBadRequest, gin.H{"code": "FAIL", "message": err.Error()})
		return
	}
	// 渠道认 2xx 就停止重推。回的是它自己的形态，不套控制台信封。
	//
	// 只回订单号和状态，**不能**把 view 整个丢出去：履约签发新密钥那一次，
	// view.IssuedSecret 里是 sk- 明文，而收这条响应的是支付渠道。
	context.JSON(http.StatusOK, gin.H{"code": "SUCCESS", "orderId": view.OrderID, "status": view.Status})
}

// ---------- 额度商品与订单 ----------

func (h *Handler) listPackages(context *gin.Context) {
	views, err := h.service.ListPackages(context.Request.Context(), true)
	httpx.JSON(context, views, err)
}

func (h *Handler) createOrder(context *gin.Context) {
	var req dto.CreateOrderRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	req.UserID = httpx.CallerID(context)
	view, err := h.service.CreateOrder(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) listOrders(context *gin.Context) {
	limit, _ := strconv.Atoi(context.DefaultQuery("limit", "50"))
	views, err := h.service.ListOrders(context.Request.Context(), httpx.CallerID(context), limit)
	httpx.JSON(context, views, err)
}

func (h *Handler) cancelOrder(context *gin.Context) {
	var req struct {
		OrderID string `json:"orderId" binding:"required"`
	}
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	httpx.JSON(context, req.OrderID, h.service.CancelOrder(context.Request.Context(), httpx.CallerID(context), req.OrderID))
}

// paymentChannels 收银台上能选哪几个渠道。沙箱渠道也在这个列表里，
// 但带着 sandbox 标记 —— 界面必须把它标出来。
func (h *Handler) paymentChannels(context *gin.Context) {
	channels := h.service.PaymentChannels()
	views := make([]dto.PaymentChannelView, 0, len(channels))
	for _, channel := range channels {
		views = append(views, dto.PaymentChannelView{
			Code: channel.Code, Title: channel.Title, Sandbox: channel.Sandbox,
		})
	}
	httpx.JSON(context, views, nil)
}

func (h *Handler) paySandbox(context *gin.Context) {
	var req dto.PaySandboxRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	// 归属校验的依据只能是令牌里的人。请求体里的 UserID 有 json:"-"，绑不进来。
	req.UserID = httpx.CallerID(context)
	view, err := h.service.PaySandbox(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) payOrder(context *gin.Context) {
	var req dto.PayOrderRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	view, err := h.service.PayOrder(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) renewKey(context *gin.Context) {
	var req dto.RenewKeyRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	req.OwnerUserID = httpx.CallerID(context)
	view, err := h.service.RenewKey(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

// ---------- /v1 原生 ----------

type signUploadRequest struct {
	Name        string `json:"name" binding:"required"`
	Size        int64  `json:"size" binding:"required"`
	ContentType string `json:"contentType"`
	Kind        string `json:"kind" binding:"required"`
}

func (h *Handler) signUpload(context *gin.Context) {
	var req signUploadRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		context.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"type": "invalid_body", "message": err.Error()}})
		return
	}
	caller := corepkg.CallerFrom(context)
	ref, err := h.service.SignUpload(context.Request.Context(), req.Kind, req.Name, req.ContentType, req.Size, caller.KeyID)
	if err != nil {
		context.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"type": "artifact_error", "message": err.Error()}})
		return
	}
	context.JSON(http.StatusOK, ref)
}

func (h *Handler) signDownload(context *gin.Context) {
	objectKey := strings.TrimPrefix(context.Param("objectKey"), "/")
	ref, err := h.service.SignDownload(context.Request.Context(), objectKey)
	if err != nil {
		context.JSON(http.StatusNotFound, gin.H{"error": gin.H{"type": "artifact_missing", "message": err.Error()}})
		return
	}
	context.JSON(http.StatusOK, ref)
}

// createOrderWithKey 是 /v1 上的续费入口：用当前密钥的身份下单，
// 不填 targetKeyId 就默认充给自己这把密钥。
func (h *Handler) createOrderWithKey(context *gin.Context) {
	var req dto.CreateOrderRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		context.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"type": "invalid_body", "message": err.Error()}})
		return
	}
	caller := corepkg.CallerFrom(context)
	req.UserID = caller.OwnerUserID
	if req.TargetKeyID == "" {
		req.TargetKeyID = caller.KeyID
	}
	view, err := h.service.CreateOrder(context.Request.Context(), req)
	if err != nil {
		context.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"type": "order_failed", "message": err.Error()}})
		return
	}
	context.JSON(http.StatusOK, view)
}

// renewKeyWithKey 换发当前这把密钥。路径里的 id 必须与调用方一致 ——
// 拿着 A 的密钥去换发 B 的密钥等于把 B 的余额搬走。
func (h *Handler) renewKeyWithKey(context *gin.Context) {
	caller := corepkg.CallerFrom(context)
	keyID := context.Param("keyId")
	if keyID != caller.KeyID {
		context.JSON(http.StatusForbidden, gin.H{"error": gin.H{"type": "scope_denied", "message": "只能换发当前密钥"}})
		return
	}
	var req dto.RenewKeyRequest
	_ = context.ShouldBindJSON(&req)
	req.KeyID = keyID
	req.OwnerUserID = caller.OwnerUserID
	view, err := h.service.RenewKey(context.Request.Context(), req)
	if err != nil {
		context.JSON(http.StatusBadRequest, gin.H{"error": gin.H{"type": "renew_failed", "message": err.Error()}})
		return
	}
	context.JSON(http.StatusOK, view)
}

func (h *Handler) usage(context *gin.Context) {
	caller := corepkg.CallerFrom(context)
	report, err := h.service.Usage(context.Request.Context(), dto.UsageQuery{
		ConsumerKey: caller.KeyID, Kind: context.Query("kind"),
		From: parseTime(context.Query("from")), To: parseTime(context.Query("to")),
	})
	if err != nil {
		context.JSON(http.StatusInternalServerError, gin.H{"error": gin.H{"type": "internal_error", "message": err.Error()}})
		return
	}
	context.JSON(http.StatusOK, report)
}

func (h *Handler) describeKey(context *gin.Context) {
	caller := corepkg.CallerFrom(context)
	view, err := h.service.DescribeKey(context.Request.Context(), caller.KeyID)
	if err != nil {
		context.JSON(http.StatusNotFound, gin.H{"error": gin.H{"type": "key_invalid", "message": err.Error()}})
		return
	}
	context.JSON(http.StatusOK, view)
}

// ---------- 控制台 ----------

// currentNotice 当前的数据告知版本与本人是否已确认。
// 和提供者那边的 /terms 对称：前端要能在下单之前就知道拦不拦得住。
// consumerEndpoint 消费者 SDK 要填的 base_url。
func (h *Handler) consumerEndpoint(context *gin.Context) {
	httpx.JSON(context, gin.H{"baseUrl": h.service.Config().ConsumerBaseURL}, nil)
}

func (h *Handler) currentNotice(context *gin.Context) {
	version := h.service.Config().ConsumerNoticeVersion
	accepted, err := h.service.HasConsent(context.Request.Context(), "consumer", httpx.CallerID(context), version)
	httpx.JSON(context, gin.H{"version": version, "accepted": accepted}, err)
}

func (h *Handler) acceptNotice(context *gin.Context) {
	err := h.service.AcceptTerms(context.Request.Context(), dto.AcceptTermsRequest{
		SubjectType:  "consumer",
		UserID:       httpx.CallerID(context),
		TermsVersion: h.service.Config().ConsumerNoticeVersion,
		IP:           context.ClientIP(),
		UserAgent:    context.GetHeader("User-Agent"),
	})
	httpx.JSON(context, h.service.Config().ConsumerNoticeVersion, err)
}

func (h *Handler) issueKey(context *gin.Context) {
	var req dto.IssueKeyRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	if req.NoticeVersion == "" {
		req.NoticeVersion = h.service.Config().ConsumerNoticeVersion
	}
	view, err := h.service.IssueKey(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) listKeys(context *gin.Context) {
	views, err := h.service.ListKeys(context.Request.Context(), httpx.CallerID(context))
	httpx.JSON(context, views, err)
}

func (h *Handler) revokeKey(context *gin.Context) {
	var req struct {
		KeyID string `json:"keyId" binding:"required"`
	}
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	err := h.service.RevokeKey(context.Request.Context(), httpx.CallerID(context), req.KeyID)
	httpx.JSON(context, req.KeyID, err)
}

// consoleUsage 走 OwnedUsage 而不是 Usage：请求里的 keyId 只能在「令牌名下的密钥」
// 里收窄，不能拿来指定别人的密钥，留空也不会变成全站合计。
func (h *Handler) consoleUsage(context *gin.Context) {
	report, err := h.service.OwnedUsage(context.Request.Context(), httpx.CallerID(context), dto.UsageQuery{
		ConsumerKey: context.Query("keyId"), Kind: context.Query("kind"),
		From: parseTime(context.Query("from")), To: parseTime(context.Query("to")),
	})
	httpx.JSON(context, report, err)
}

// consoleUsageRecords 逐笔扣费。范围同样由令牌决定，keyId 只能收窄。
func (h *Handler) consoleUsageRecords(context *gin.Context) {
	offset, _ := strconv.Atoi(context.Query("offset"))
	limit, _ := strconv.Atoi(context.DefaultQuery("limit", "20"))
	query := dto.UsageRecordQuery{
		OwnerUserID: httpx.CallerID(context), KeyID: context.Query("keyId"),
		Kind: context.Query("kind"), State: context.Query("state"),
		Offset: offset, Limit: limit,
	}
	// 时间窗和提供者那边同一套写法：day=today / 7d / 2026-09-10。
	query.From, query.To = dayRange(context.Query("day"))
	if from := parseTime(context.Query("from")); !from.IsZero() {
		query.From = from
	}
	if to := parseTime(context.Query("to")); !to.IsZero() {
		query.To = to
	}
	page, err := h.service.OwnedUsageRecords(context.Request.Context(), query)
	httpx.JSON(context, page, err)
}

// consoleDashboard 密钥页与使用记录页共用的那排数字。
func (h *Handler) consoleDashboard(context *gin.Context) {
	days, _ := strconv.Atoi(context.DefaultQuery("days", "10"))
	view, err := h.service.ConsumerDashboard(context.Request.Context(), httpx.CallerID(context), days)
	httpx.JSON(context, view, err)
}

// dayRange 把 day=today / 7d / 2026-09-10 翻成左闭右开区间。
//
// 和 providers 那份是同一套词汇：两个端的「今天」必须指同一段时间，
// 否则同一次请求在贡献者那边算今天、在使用者那边算昨天。
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

// ---------- 会话与任务（控制台只读） ----------

func (h *Handler) workloadQuery(context *gin.Context) dto.WorkloadQuery {
	return dto.WorkloadQuery{
		OwnerUserID: httpx.CallerID(context),
		KeyID:       context.Query("keyId"),
		Kind:        context.Query("kind"),
		State:       context.Query("state"),
		Limit:       atoiOr(context.Query("limit"), 50),
	}
}

func (h *Handler) consoleSessions(context *gin.Context) {
	views, err := h.service.OwnedSessions(context.Request.Context(), h.workloadQuery(context))
	httpx.JSON(context, views, err)
}

func (h *Handler) consoleSessionContext(context *gin.Context) {
	view, err := h.service.OwnedSessionContext(context.Request.Context(),
		httpx.CallerID(context), context.Param("sid"), atoiOr(context.Query("fromSeq"), 0))
	httpx.JSON(context, view, err)
}

func (h *Handler) consoleCloseSession(context *gin.Context) {
	sid := context.Param("sid")
	err := h.service.OwnedCloseSession(context.Request.Context(), httpx.CallerID(context), sid, context.Query("reason"))
	httpx.JSON(context, sid, err)
}

func (h *Handler) consoleJobs(context *gin.Context) {
	views, err := h.service.OwnedJobs(context.Request.Context(), h.workloadQuery(context))
	httpx.JSON(context, views, err)
}

func (h *Handler) consoleJob(context *gin.Context) {
	view, err := h.service.OwnedJob(context.Request.Context(), httpx.CallerID(context), context.Param("jobId"))
	httpx.JSON(context, view, err)
}

func (h *Handler) consoleJobEvents(context *gin.Context) {
	views, err := h.service.OwnedUnitEvents(context.Request.Context(),
		httpx.CallerID(context), context.Param("jobId"), atoiOr(context.Query("fromSeq"), 0))
	httpx.JSON(context, views, err)
}

func (h *Handler) consoleCancelJob(context *gin.Context) {
	jobID := context.Param("jobId")
	err := h.service.OwnedCancelJob(context.Request.Context(), httpx.CallerID(context), jobID)
	httpx.JSON(context, jobID, err)
}

// ---------- 争议工单 ----------

func (h *Handler) consoleDisputes(context *gin.Context) {
	views, err := h.service.OwnedDisputes(context.Request.Context(),
		httpx.CallerID(context), atoiOr(context.Query("limit"), 50))
	httpx.JSON(context, views, err)
}

func (h *Handler) consoleFileDispute(context *gin.Context) {
	var req dto.FileDisputeRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	req.OwnerUserID = httpx.CallerID(context)
	view, err := h.service.FileDispute(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) consoleWithdrawDispute(context *gin.Context) {
	disputeID := context.Param("disputeId")
	err := h.service.WithdrawDispute(context.Request.Context(), httpx.CallerID(context), disputeID)
	httpx.JSON(context, disputeID, err)
}

func atoiOr(value string, fallback int) int {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil {
		return fallback
	}
	return parsed
}

// parseTime 接受 RFC3339；解析不了就返回零值，由 service 套默认区间。
func parseTime(value string) time.Time {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Time{}
	}
	return parsed
}
