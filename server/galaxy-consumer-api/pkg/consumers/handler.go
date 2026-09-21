// Package consumers 提供使用端控制台接口。
package consumers

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
	options Options
}

// Options 部署方声明的东西。
type Options struct {
	// Models 是 galaxy.models 里声明的模型清单。模型目录表为空时，模型广场用它兜底 ——
	// 和门户同一份，否则广场上写着有的模型，客户端填进去却用不了。
	Models []string
}

func NewHandler(service galaxy.Service, gate *auth.Gate, options Options) *Handler {
	return &Handler{service: service, gate: gate, options: options}
}

// RegisterConsole 挂在 /api/galaxy 下，整组只认使用端账号：共享端的令牌打进来是 not login。
func (h *Handler) RegisterConsole(group *gin.RouterGroup) {
	console := group.Group("/consumer", h.gate.Consumer())
	// SDK 接入要的两样东西之一（另一样是密钥），顺带桌面客户端的下载地址。
	// 两条都由服务端给，前端不该再配一遍 —— 配两处迟早对不上。
	console.GET("/endpoint", h.consumerEndpoint)
	console.GET("/notice", h.currentNotice)
	console.POST("/notice/accept", h.acceptNotice)
	console.GET("/keys", h.listKeys)
	// 自助签发：不用买、不用运营代发，最多 5 把有效的。额度在账户余额上，
	// 几把密钥花的是同一份钱，所以新建一把只是多一串凭证。
	console.POST("/keys", h.createKey)
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
	// 模型广场与余额。**这一端不卖任何东西**：积分只能由运营在 manager-api 里充进来，
	// 调模型时按单价逐笔从余额里扣。所以没有商品、没有下单、没有支付。
	console.GET("/catalog", h.catalog)
	console.GET("/points", h.pointsSummary)
	console.GET("/points/ledger", h.pointsLedger)
	// 分享：自己的邀请码、邀请来的人。返现不用调接口，被邀请人充值到账时服务端自己记。
	console.GET("/referral", h.referral)
	console.GET("/referral/invitees", h.invitees)
	// 取回密钥明文：「使用」按钮写本机配置、复制带密钥的接入命令都要它。
	// 用 POST 而不是 GET：keyId 放在请求体里，明文所在的这次请求不会被当成可缓存的资源。
	console.POST("/keys/secret", h.revealKey)
	// 充积分和运营代签密钥不在这里，在 manager-api 的 /api/galaxy/admin/*：
	// 它们原来靠 httpx.RequirePlatformAdmin 认任务宇宙的管理员，而 Galaxy 的账号体系里
	// 只有共享端和使用端的人，没有运营。运营身份在管理端（zt_manager_*）。
}

// ---------- 模型广场、积分与分享 ----------

func (h *Handler) catalog(context *gin.Context) {
	view, err := h.service.ConsumerCatalog(context.Request.Context(), h.options.Models)
	httpx.JSON(context, view, err)
}

func (h *Handler) pointsSummary(context *gin.Context) {
	view, err := h.service.PointsSummary(context.Request.Context(), auth.UserID(context))
	httpx.JSON(context, view, err)
}

func (h *Handler) pointsLedger(context *gin.Context) {
	var query dto.PointsLedgerQuery
	if err := context.ShouldBindQuery(&query); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	// 范围只由令牌决定：OwnerUserID 不从请求里绑，按人找的关键字也只有运营那边认。
	query.Operator, query.OwnerUserID, query.OwnerKeyword = false, auth.UserID(context), ""
	page, err := h.service.PointsLedger(context.Request.Context(), query)
	httpx.JSON(context, page, err)
}

func (h *Handler) referral(context *gin.Context) {
	view, err := h.service.ReferralOverview(context.Request.Context(), auth.UserID(context))
	httpx.JSON(context, view, err)
}

func (h *Handler) invitees(context *gin.Context) {
	page, err := h.service.ListInvitees(context.Request.Context(), auth.UserID(context),
		atoiOr(context.Query("offset"), 0), atoiOr(context.Query("limit"), 20))
	httpx.JSON(context, page, err)
}

func (h *Handler) revealKey(context *gin.Context) {
	var req struct {
		KeyID string `json:"keyId" binding:"required"`
	}
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	view, err := h.service.RevealKey(context.Request.Context(), auth.UserID(context), req.KeyID)
	noStore(context)
	httpx.JSON(context, view, err)
}

// noStore 响应里带着密钥明文时用：任何一层代理、浏览器缓存都不该留一份。
func noStore(context *gin.Context) {
	context.Header("Cache-Control", "no-store")
}

// createKey 自助新建一把密钥。明文只在这一次响应里出现 —— 前端拿到就存进
// 本机保险箱；之后再要，走 /keys/secret 单独取。
func (h *Handler) createKey(context *gin.Context) {
	var req dto.CreateConsumerKeyRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	req.UserID = auth.UserID(context)
	view, err := h.service.CreateConsumerKey(context.Request.Context(), req)
	noStore(context)
	httpx.JSON(context, view, err)
}

func (h *Handler) renewKey(context *gin.Context) {
	var req dto.RenewKeyRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	req.OwnerUserID = auth.UserID(context)
	view, err := h.service.RenewKey(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

// ---------- 控制台 ----------

// consumerEndpoint 接入这一页要的两条部署事实：消费者 SDK 要填的 base_url，
// 和桌面客户端的下载地址。两条都可能是空的，控制台各自少显示一块。
//
// 下载地址跟着它一起下发而不是单开一个接口：密钥页本来就要取一次 base_url，
// 而这两条是同一类事实——「这套部署把东西摆在哪儿」，合在一起少一次往返。
//
// 下载地址给的是一组（通用页 + Windows / mac Intel / mac Apple 芯片）：浏览器认得出
// 是不是 Mac，但认不出是哪种芯片（navigator.platform 两种都报 MacIntel），
// 所以由界面把填过的那几条一起摆出来让人自己挑，而不是在这里替他猜一个 ——
// 猜错给出 arm64 的包，Intel 机器上装完直接起不来。
//
// clientDownloadUrl 是**给老界面的那一条**：灰度期间浏览器里可能还开着上一版控制台，
// 它只认这个字段。给通用那条而不是随便挑一个平台的 —— 老界面把它当成一个按钮
// 摆给所有人，塞一个 mac 的包进去，Windows 用户点下去拿到的是一个装不上的文件。
func (h *Handler) consumerEndpoint(context *gin.Context) {
	config := h.service.Config()
	httpx.JSON(context, gin.H{
		"baseUrl":           config.ConsumerBaseURL,
		"clientDownloadUrl": config.ConsumerClientDownload.Default,
		"clientDownloads":   config.ConsumerClientDownload,
	}, nil)
}

// currentNotice 当前的数据告知版本与本人是否已确认。
// 和提供者那边的 /terms 对称：前端要能在下单之前就知道拦不拦得住。
func (h *Handler) currentNotice(context *gin.Context) {
	version := h.service.Config().ConsumerNoticeVersion
	accepted, err := h.service.HasConsent(context.Request.Context(), "consumer", auth.UserID(context), version)
	httpx.JSON(context, gin.H{"version": version, "accepted": accepted}, err)
}

func (h *Handler) acceptNotice(context *gin.Context) {
	err := h.service.AcceptTerms(context.Request.Context(), dto.AcceptTermsRequest{
		SubjectType:  "consumer",
		UserID:       auth.UserID(context),
		TermsVersion: h.service.Config().ConsumerNoticeVersion,
		IP:           context.ClientIP(),
		UserAgent:    context.GetHeader("User-Agent"),
	})
	httpx.JSON(context, h.service.Config().ConsumerNoticeVersion, err)
}

func (h *Handler) listKeys(context *gin.Context) {
	views, err := h.service.ListKeys(context.Request.Context(), auth.UserID(context))
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
	err := h.service.RevokeKey(context.Request.Context(), auth.UserID(context), req.KeyID)
	httpx.JSON(context, req.KeyID, err)
}

// consoleUsage 走 OwnedUsage 而不是 Usage：请求里的 keyId 只能在「令牌名下的密钥」
// 里收窄，不能拿来指定别人的密钥，留空也不会变成全站合计。
func (h *Handler) consoleUsage(context *gin.Context) {
	report, err := h.service.OwnedUsage(context.Request.Context(), auth.UserID(context), dto.UsageQuery{
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
		OwnerUserID: auth.UserID(context), KeyID: context.Query("keyId"),
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
	view, err := h.service.ConsumerDashboard(context.Request.Context(), auth.UserID(context), days)
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
		OwnerUserID: auth.UserID(context),
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
		auth.UserID(context), context.Param("sid"), atoiOr(context.Query("fromSeq"), 0))
	httpx.JSON(context, view, err)
}

func (h *Handler) consoleCloseSession(context *gin.Context) {
	sid := context.Param("sid")
	err := h.service.OwnedCloseSession(context.Request.Context(), auth.UserID(context), sid, context.Query("reason"))
	httpx.JSON(context, sid, err)
}

func (h *Handler) consoleJobs(context *gin.Context) {
	views, err := h.service.OwnedJobs(context.Request.Context(), h.workloadQuery(context))
	httpx.JSON(context, views, err)
}

func (h *Handler) consoleJob(context *gin.Context) {
	view, err := h.service.OwnedJob(context.Request.Context(), auth.UserID(context), context.Param("jobId"))
	httpx.JSON(context, view, err)
}

func (h *Handler) consoleJobEvents(context *gin.Context) {
	views, err := h.service.OwnedUnitEvents(context.Request.Context(),
		auth.UserID(context), context.Param("jobId"), atoiOr(context.Query("fromSeq"), 0))
	httpx.JSON(context, views, err)
}

func (h *Handler) consoleCancelJob(context *gin.Context) {
	jobID := context.Param("jobId")
	err := h.service.OwnedCancelJob(context.Request.Context(), auth.UserID(context), jobID)
	httpx.JSON(context, jobID, err)
}

// ---------- 争议工单 ----------

func (h *Handler) consoleDisputes(context *gin.Context) {
	views, err := h.service.OwnedDisputes(context.Request.Context(),
		auth.UserID(context), atoiOr(context.Query("limit"), 50))
	httpx.JSON(context, views, err)
}

func (h *Handler) consoleFileDispute(context *gin.Context) {
	var req dto.FileDisputeRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	req.OwnerUserID = auth.UserID(context)
	view, err := h.service.FileDispute(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) consoleWithdrawDispute(context *gin.Context) {
	disputeID := context.Param("disputeId")
	err := h.service.WithdrawDispute(context.Request.Context(), auth.UserID(context), disputeID)
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
