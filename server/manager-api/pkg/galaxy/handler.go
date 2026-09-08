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
// 所以这里和 galaxy-api/pkg/admin 是同一个领域服务的两个装配方：那边给业务身份的
// 控制台管理员用，这边给管理端角色体系用。**鉴权不写在路由上** —— 管理端的权限是
// 数据驱动的（角色 → 资源 → 读/写），由 manager-api/auth 那道中间件在 /api 整组上
// 统一判定，写方法还要再过一次角色的 writable 开关。
package galaxy

import (
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"common/middleware/httpx"

	galaxysvc "service/galaxy"
	"service/galaxy/dto"
)

type Handler struct {
	service galaxysvc.Service
}

func NewHandler(service galaxysvc.Service) *Handler {
	return &Handler{service: service}
}

// RegisterHandler 路径保持 /api/galaxy/admin/*，和 galaxy-api 那边一致。
//
// 一致是有代价约束的：前端的 api 文件只认路径，服务端把哪一段挂在哪个进程上是
// 部署的事（和「六层独立部署后前端不改 api 文件」同一个原则）。将来共享池运营
// 真要拆出去，改的是代理的分流规则，不是 client/manager 的 galaxy.api.ts。
func (h *Handler) RegisterHandler(group *gin.RouterGroup) {
	admin := group.Group("/galaxy/admin")
	admin.GET("/pool", h.pool)
	admin.GET("/nodes", h.nodes)
	admin.GET("/probes", h.probes)
	admin.GET("/usage", h.usage)
	admin.POST("/node/ban", h.banNode)
	admin.GET("/disputes", h.disputes)
	admin.POST("/disputes/resolve", h.resolveDispute)
	admin.GET("/packages", h.packages)
	admin.POST("/packages/save", h.savePackage)
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
	httpx.JSON(context, req.NodeID, h.service.BanNode(context.Request.Context(), req))
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
	// manager-api/auth 的中间件会把会话同时塞进 httpx.user，所以这里取到的是
	// 管理端账号，和 galaxy-api 那边取到业务账号是同一个语义。
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
