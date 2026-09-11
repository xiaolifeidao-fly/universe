// Package galaxy 是管理端的共享算力池运营接口。
//
// 它**直接复用 service/galaxy**，不通过 HTTP 去调 galaxy-api：
//
//   - 管理端有自己的一套身份（zt_manager_* + Redis 会话里的不透明令牌），
//     galaxy-api 认的是 service/identity 的 JWT。两套令牌互不认识，
//     让浏览器拿管理端令牌直连 galaxy-api，每一个请求都会被判成 not login，
//     前端的拦截器一看到这四个字就清 token 跳登录页 —— 症状是「点进共享算力池
//     就被踢出来」。
//   - 换成「代理层换票」或者「manager-api 拿服务凭证转发」也能通，但那是在两个
//     进程之间搬一份本来就同库同表的数据。共享池的账在 MySQL、控制面在 Redis，
//     manager-api 两样都连得到，中间那一跳没有承载任何东西。
//
// 共享池的运营**只在这里**。galaxy-api 原来也有一组 /api/galaxy/admin/*，认的是任务宇宙
// 的管理员（service/identity 的 role=admin）；Galaxy 有了自己的账号体系之后，那边只剩
// 共享端和使用端的人，没有运营这种身份，那组接口连同「发内测密钥」「人工确认到账」一起挪到了这里。
//
// **鉴权不写在路由上** —— 管理端的权限是数据驱动的（角色 → 资源 → 读/写），由
// manager-api/auth 那道中间件在 /api 整组上统一判定，写方法还要再过一次角色的 writable 开关。
// 新加的路由要在 server/manager_galaxy_resources.sql 里登记，否则只有超级管理员进得来。
package galaxy

import (
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"common/middleware/httpx"

	galaxysvc "service/galaxy"
	"service/galaxy/account"
	"service/galaxy/dto"
)

type Handler struct {
	service  galaxysvc.Service
	accounts account.Service
}

// NewHandler accounts 只要数据库，service 还要 Redis 控制面 —— 没配 Redis 时
// 池子那几页不可用，账号管理照样能用。
func NewHandler(service galaxysvc.Service, accounts account.Service) *Handler {
	return &Handler{service: service, accounts: accounts}
}

// RegisterHandler 路径统一在 /api/galaxy/admin/* 下。
func (h *Handler) RegisterHandler(group *gin.RouterGroup) {
	admin := group.Group("/galaxy/admin")
	admin.GET("/pool", h.pool)
	admin.GET("/nodes", h.nodes)
	admin.GET("/probes", h.probes)
	admin.GET("/usage", h.usage)
	admin.POST("/node/ban", h.banNode)
	admin.POST("/provider/type", h.setProviderType)
	admin.GET("/disputes", h.disputes)
	admin.POST("/disputes/resolve", h.resolveDispute)
	admin.GET("/packages", h.packages)
	admin.POST("/packages/save", h.savePackage)

	// Galaxy 账号：两端各一批人。散户 / 工作室走上面那条 /provider/type。
	admin.GET("/users", h.users)
	admin.POST("/users/status", h.setUserStatus)
	admin.POST("/users/password", h.resetUserPassword)

	// 以下原来在 galaxy-api 上，认任务宇宙的管理员。
	// 给内测用户发密钥（C-10）。明文只在这一次响应里，运营要当场转交。
	admin.POST("/keys/issue", h.issueKey)
	// 人工确认到账：线下转账、渠道回调丢了要补单。渠道回调那条验签的路仍在 galaxy-api。
	admin.POST("/orders/pay", h.payOrder)
	// 门户的模型目录。列全部（含下架的），保存是整行覆盖。
	admin.GET("/portal/models", h.portalModels)
	admin.POST("/portal/models/save", h.savePortalModel)
	admin.POST("/portal/models/delete", h.deletePortalModel)
	// 门户「联系我们」收到的线索，里面是陌生人留下的联系方式 —— 资源表里别给只读角色。
	admin.GET("/portal/leads", h.portalLeads)
	admin.POST("/portal/leads/handle", h.handlePortalLead)
}

// enabled 挡住「路由在、服务没装配」这一种情况。
//
// 路由**总是**注册：接口资源表是按路由表生成的，少注册一组，那组接口就永远
// 不在资源表里，登录用户一律访问不到。所以缺服务这件事在这里说清楚，
// 而不是让一个 nil 接口在第一次调用时空指针崩掉整个进程。
func (h *Handler) enabled(context *gin.Context) bool {
	if h.service == nil {
		httpx.Fail(context, "共享算力池未启用：manager-api 缺少 Redis 控制面（redis.addr）")
		context.Abort()
		return false
	}
	return true
}

func (h *Handler) pool(context *gin.Context) {
	if !h.enabled(context) {
		return
	}
	view, err := h.service.PoolStatus(context.Request.Context())
	httpx.JSON(context, view, err)
}

func (h *Handler) nodes(context *gin.Context) {
	if !h.enabled(context) {
		return
	}
	limit, _ := strconv.Atoi(context.DefaultQuery("limit", "200"))
	views, err := h.service.AdminNodes(context.Request.Context(), limit)
	httpx.JSON(context, views, err)
}

func (h *Handler) probes(context *gin.Context) {
	if !h.enabled(context) {
		return
	}
	limit, _ := strconv.Atoi(context.DefaultQuery("limit", "50"))
	views, err := h.service.AdminProbes(context.Request.Context(), context.Query("cid"), limit)
	httpx.JSON(context, views, err)
}

func (h *Handler) usage(context *gin.Context) {
	if !h.enabled(context) {
		return
	}
	report, err := h.service.AdminUsage(context.Request.Context(), dto.UsageQuery{
		ConsumerKey: context.Query("keyId"), CID: context.Query("cid"), Kind: context.Query("kind"),
		From: parseTime(context.Query("from")), To: parseTime(context.Query("to")),
	})
	httpx.JSON(context, report, err)
}

// parseTime 解析不出来就当没传：区间是个过滤条件，一个写错的时间不该让整张报表 500。
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

func (h *Handler) banNode(context *gin.Context) {
	if !h.enabled(context) {
		return
	}
	var req dto.BanNodeRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	// 谁封的只取自凭证，同 resolveDispute。
	req.UpdatedBy = httpx.CallerID(context)
	httpx.JSON(context, req.NodeID, h.service.BanNode(context.Request.Context(), req))
}

// setProviderType 把账号设成工作室 / 改回散户。谁改的只取自凭证，同 resolveDispute。
func (h *Handler) setProviderType(context *gin.Context) {
	if !h.enabled(context) {
		return
	}
	var req dto.SetProviderTypeRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	req.UpdatedBy = httpx.CallerID(context)
	httpx.JSON(context, req.OwnerUserID, h.service.SetProviderType(context.Request.Context(), req))
}

func (h *Handler) disputes(context *gin.Context) {
	if !h.enabled(context) {
		return
	}
	limit, _ := strconv.Atoi(context.DefaultQuery("limit", "100"))
	views, err := h.service.AdminDisputes(context.Request.Context(), dto.DisputeQuery{
		Status: context.Query("status"), CID: context.Query("cid"), Limit: limit,
	})
	httpx.JSON(context, views, err)
}

func (h *Handler) resolveDispute(context *gin.Context) {
	if !h.enabled(context) {
		return
	}
	var req dto.ResolveDisputeRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	// 谁裁的要留痕，且只能取自凭证 —— 请求体里报个名字不算数。
	// manager-api/auth 的中间件会把会话同时塞进 httpx.user，所以这里取到的是管理端账号（mu_…）。
	req.HandledBy = httpx.CallerID(context)
	view, err := h.service.ResolveDispute(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

// packages 商品目录。列的是**全部**商品，含已下架的：一个商品下架之后仍然被历史
// 订单引用，列表里看不到它，运营就只能靠记忆判断某个 packageCode 是不是自己下架的那个。
func (h *Handler) packages(context *gin.Context) {
	if !h.enabled(context) {
		return
	}
	views, err := h.service.ListPackages(context.Request.Context(), false)
	httpx.JSON(context, views, err)
}

// savePackage 新建或整行覆盖一个商品。
//
// 语义是**整行覆盖**而不是打补丁：调用方必须把所有字段都带上，
// 少带一个就是把它清零。前端的编辑框因此要用当前值预填，不能只提交改动的那几项。
func (h *Handler) savePackage(context *gin.Context) {
	if !h.enabled(context) {
		return
	}
	var req dto.SavePackageRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	httpx.JSON(context, req.PackageCode, h.service.SavePackage(context.Request.Context(), req))
}

// ---------- Galaxy 账号 ----------

func (h *Handler) accountsEnabled(context *gin.Context) bool {
	if h.accounts == nil {
		httpx.Fail(context, "Galaxy 账号服务未装配")
		context.Abort()
		return false
	}
	return true
}

// users 按端翻账号。side 必填：两端是两批人。
func (h *Handler) users(context *gin.Context) {
	if !h.accountsEnabled(context) {
		return
	}
	var query dto.AccountQuery
	if err := context.ShouldBindQuery(&query); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	page, err := h.accounts.List(context.Request.Context(), query)
	httpx.JSON(context, page, err)
}

// setUserStatus 停用 / 启用。停用只挡登录控制台，名下在跑的机器和发出去的密钥各有各的开关。
func (h *Handler) setUserStatus(context *gin.Context) {
	if !h.accountsEnabled(context) {
		return
	}
	var req dto.SetAccountStatusRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	req.UpdatedBy = httpx.CallerID(context)
	httpx.JSON(context, req.UserID, h.accounts.SetStatus(context.Request.Context(), req))
}

// resetUserPassword 替忘了密码的人设临时密码，本人下次登录要先改掉。
func (h *Handler) resetUserPassword(context *gin.Context) {
	if !h.accountsEnabled(context) {
		return
	}
	var req dto.ResetAccountPasswordRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	req.UpdatedBy = httpx.CallerID(context)
	httpx.JSON(context, req.UserID, h.accounts.ResetPassword(context.Request.Context(), req))
}

// ---------- 密钥与订单 ----------

// issueKey 给使用端账号发一把内测密钥。ownerUserId 是 cu_… ——
// 这个人得先在 Orbit 里确认过数据告知，否则领域层直接拒。
func (h *Handler) issueKey(context *gin.Context) {
	if !h.enabled(context) {
		return
	}
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

func (h *Handler) payOrder(context *gin.Context) {
	if !h.enabled(context) {
		return
	}
	var req dto.PayOrderRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	view, err := h.service.PayOrder(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

// ---------- 门户 ----------

// portalModels 列全部：下架的那几行仍然要看得见，否则运营只能靠记忆判断某个模型是不是自己下架的那个。
func (h *Handler) portalModels(context *gin.Context) {
	if !h.enabled(context) {
		return
	}
	views, err := h.service.ListPortalModels(context.Request.Context(), false)
	httpx.JSON(context, views, err)
}

func (h *Handler) savePortalModel(context *gin.Context) {
	if !h.enabled(context) {
		return
	}
	var req dto.SaveModelRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	httpx.JSON(context, nil, h.service.SavePortalModel(context.Request.Context(), req))
}

func (h *Handler) deletePortalModel(context *gin.Context) {
	if !h.enabled(context) {
		return
	}
	var req struct {
		ModelID string `json:"modelId" binding:"required"`
	}
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	httpx.JSON(context, nil, h.service.DeletePortalModel(context.Request.Context(), req.ModelID))
}

func (h *Handler) portalLeads(context *gin.Context) {
	if !h.enabled(context) {
		return
	}
	offset, _ := strconv.Atoi(context.DefaultQuery("offset", "0"))
	limit, _ := strconv.Atoi(context.DefaultQuery("limit", "50"))
	page, err := h.service.ListLeads(context.Request.Context(), context.Query("status"), offset, limit)
	httpx.JSON(context, page, err)
}

func (h *Handler) handlePortalLead(context *gin.Context) {
	if !h.enabled(context) {
		return
	}
	var req dto.HandleLeadRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	// 谁处理的只取自凭证，同 resolveDispute。
	req.HandledBy = httpx.CallerID(context)
	httpx.JSON(context, nil, h.service.HandleLead(context.Request.Context(), req))
}
