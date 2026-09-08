// Package admin 是给 manager-api 调的管理接口：池水位、能力注册表、节点、抽检、
// 结算汇总与争议工单。只读的双用（后台看 + manager-api 用服务凭证同步），
// 处置动作（封禁、裁决）只认管理员。
package admin

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
	// 只读双用：控制台管理员看，manager-api 用服务凭证同步。
	api := group.Group("/admin", httpx.RequireUserOrService())
	api.GET("/pool", h.pool)
	api.GET("/kinds", h.kinds)
	api.GET("/nodes", h.nodes)
	api.GET("/probes", h.probes)
	api.GET("/usage", h.usage)
	// 封禁是处置动作，只允许平台管理员；只读接口双用（后台看 + manager-api 同步）。
	// 用 RequirePlatformAdmin 而不是 RequireAdmin：后者还要求 product_research 身份，
	// 那是交付工作台的门；共享池的运营不在那个身份体系里。
	api.POST("/node/ban", httpx.RequirePlatformAdmin(), h.banNode)
	api.GET("/disputes", h.disputes)
	// 裁决要动三本账，和封禁一样是处置动作。
	api.POST("/disputes/resolve", httpx.RequirePlatformAdmin(), h.resolveDispute)
	// 商品目录。这里列的是**全部**商品，含已下架的 —— 消费者那条
	// （GET /api/galaxy/consumer/packages）固定只给上架的。
	api.GET("/packages", h.packages)
	api.POST("/packages/save", httpx.RequirePlatformAdmin(), h.savePackage)
}

// packages 商品目录。运营要看得见下架的：一个商品下架之后仍然被历史订单引用，
// 列表里看不到它，运营就只能靠记忆判断某个 packageCode 是不是自己下架的那个。
func (h *Handler) packages(context *gin.Context) {
	views, err := h.service.ListPackages(context.Request.Context(), false)
	httpx.JSON(context, views, err)
}

// savePackage 新建或整行覆盖一个商品。
//
// 语义是**整行覆盖**而不是打补丁：调用方必须把所有字段都带上，
// 少带一个就是把它清零。前端的编辑框因此要用当前值预填，不能只提交改动的那几项。
func (h *Handler) savePackage(context *gin.Context) {
	var req dto.SavePackageRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	httpx.JSON(context, req.PackageCode, h.service.SavePackage(context.Request.Context(), req))
}

func (h *Handler) disputes(context *gin.Context) {
	limit, _ := strconv.Atoi(context.DefaultQuery("limit", "100"))
	views, err := h.service.AdminDisputes(context.Request.Context(), dto.DisputeQuery{
		Status: context.Query("status"), CID: context.Query("cid"), Limit: limit,
	})
	httpx.JSON(context, views, err)
}

func (h *Handler) resolveDispute(context *gin.Context) {
	var req dto.ResolveDisputeRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	// 谁裁的要留痕，且只能取自凭证 —— 请求体里报个名字不算数。
	req.HandledBy = httpx.CallerID(context)
	view, err := h.service.ResolveDispute(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

func (h *Handler) nodes(context *gin.Context) {
	limit, _ := strconv.Atoi(context.DefaultQuery("limit", "200"))
	views, err := h.service.AdminNodes(context.Request.Context(), limit)
	httpx.JSON(context, views, err)
}

func (h *Handler) probes(context *gin.Context) {
	limit, _ := strconv.Atoi(context.DefaultQuery("limit", "50"))
	views, err := h.service.AdminProbes(context.Request.Context(), context.Query("cid"), limit)
	httpx.JSON(context, views, err)
}

func (h *Handler) usage(context *gin.Context) {
	report, err := h.service.AdminUsage(context.Request.Context(), dto.UsageQuery{
		ConsumerKey: context.Query("keyId"), CID: context.Query("cid"), Kind: context.Query("kind"),
		From: parseTime(context.Query("from")), To: parseTime(context.Query("to")),
	})
	httpx.JSON(context, report, err)
}

func (h *Handler) banNode(context *gin.Context) {
	var req dto.BanNodeRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	httpx.JSON(context, req.NodeID, h.service.BanNode(context.Request.Context(), req))
}

// parseTime 接受 RFC3339；解析不了返回零值，由 service 套默认区间。
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

func (h *Handler) pool(context *gin.Context) {
	status, err := h.service.PoolStatus(context.Request.Context())
	httpx.JSON(context, status, err)
}

func (h *Handler) kinds(context *gin.Context) {
	httpx.JSON(context, h.service.Kinds(), nil)
}
