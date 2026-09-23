// Package portal 是门户面：**未登录**就能看到的模型目录、定价与「联系我们」。
//
// 和 consumers / providers 那两个包的区别只有一条，但很要命：这里没有调用者身份。
// 于是三件事必须在这一层守住：
//
//   - 返回体里不能有任何用户维度的东西（余额、订单、节点、密钥一个都不能沾）；
//   - 读接口要有缓存，否则一个公开地址就是一条直通数据库的压测通道；
//   - 来访者自己填写内容的写接口（留资）要限流，而且不能只信 X-Forwarded-For；
//     官网打开只累加服务端固定的日桶，不接受来访者内容。
package portal

import (
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"common/middleware/httpx"
	"service/galaxy"
	"service/galaxy/dto"
)

// Options 部署方声明的东西。
type Options struct {
	// Models 是 galaxy.models 里声明的模型清单（relay 的 /v1/models 用的同一份）。
	// 门户的模型目录表为空时用它兜底。
	Models []string
	// CacheTTL 只读接口的缓存时长。0 走默认 30s。
	CacheTTL time.Duration
	// LeadsPerHour 整套部署每小时最多收多少条留资。
	//
	// 它和按 IP 的那道限流是两回事：IP 那道拦的是「同一个人反复提交」，取值来自
	// X-Forwarded-For，伪造成本约等于零；这一道拦的是「有人换着 IP 刷」，
	// 代价是被刷满之后真实来访者也会被挡一小时 —— 那时候本来也需要人来看一眼。
	LeadsPerHour int
}

const (
	defaultCacheTTL     = 30 * time.Second
	defaultLeadsPerHour = 60
)

type Handler struct {
	service galaxy.Service
	options Options

	// 只读缓存。门户的数据只随运营改动而变，秒级过期已经足够新，
	// 而它挡掉的是「公开地址 → 数据库」这条没有任何闸门的路。
	cache struct {
		sync.Mutex
		view    dto.PortalOverview
		freshAt time.Time
	}

	// 整站留资限流。进程内计数：多实例部署时每个实例各算各的，
	// 等于把额度乘以实例数 —— 对一道兜底闸来说可以接受，
	// 按 IP 的那道才是主力，而它在库里，跨实例一致。
	leads struct {
		sync.Mutex
		windowFrom time.Time
		count      int
	}
}

func NewHandler(service galaxy.Service, options Options) *Handler {
	if options.CacheTTL <= 0 {
		options.CacheTTL = defaultCacheTTL
	}
	if options.LeadsPerHour <= 0 {
		options.LeadsPerHour = defaultLeadsPerHour
	}
	return &Handler{service: service, options: options}
}

// RegisterHandler 挂在 /api/galaxy 下，**不带任何鉴权**。
//
// 路径统一收在 /portal 这一段里，就是为了让「哪些接口是公开的」在路由表上
// 一眼看得见 —— 公开接口散落在各个业务前缀下面，迟早有人在某条上顺手
// 加一个带用户维度的字段。
func (h *Handler) RegisterHandler(group *gin.RouterGroup) {
	api := group.Group("/portal")
	api.GET("/overview", h.overview)
	api.GET("/models", h.models)
	api.GET("/pricing", h.pricing)
	// 官网打开。事件键在服务端固定，公开入口不能替别的位置伪造事件。
	api.POST("/events/open", h.recordOpen)
	api.POST("/leads", h.submitLead)
}

func (h *Handler) recordOpen(context *gin.Context) {
	httpx.JSON(context, nil, h.service.RecordTrackingEvent(
		context.Request.Context(), dto.TrackingEventPortalOpen, "",
	))
}

// overview 门户整站的数据。一次给全，前端不用为了首页拼四条请求。
func (h *Handler) overview(context *gin.Context) {
	view, err := h.catalog(context)
	httpx.JSON(context, view, err)
}

// models / pricing 是 overview 的两个切片。
//
// 单独挂出来不是为了省流量（整份也就几 KB），是为了让模型页和定价页各自
// 只声明自己要的东西 —— 门户改版时谁在用哪份数据能从路由上看出来。
func (h *Handler) models(context *gin.Context) {
	view, err := h.catalog(context)
	if err != nil {
		httpx.JSON(context, nil, err)
		return
	}
	httpx.JSON(context, gin.H{
		"endpoint": view.Endpoint, "families": view.Families,
		"models": view.Models, "stats": view.Stats, "updatedAt": view.UpdatedAt,
	}, nil)
}

func (h *Handler) pricing(context *gin.Context) {
	view, err := h.catalog(context)
	if err != nil {
		httpx.JSON(context, nil, err)
		return
	}
	httpx.JSON(context, gin.H{
		"endpoint": view.Endpoint, "prices": view.Prices,
		"models": view.Models, "stats": view.Stats, "updatedAt": view.UpdatedAt,
	}, nil)
}

// catalog 取一次目录，秒级缓存。
//
// 缓存失败不落库：上一份还在有效期内就继续用它，不然一次数据库抖动会让
// 门户首页整页空白 —— 那是全站唯一一个陌生人会看到的页面。
func (h *Handler) catalog(context *gin.Context) (dto.PortalOverview, error) {
	h.cache.Lock()
	defer h.cache.Unlock()
	if time.Since(h.cache.freshAt) < h.options.CacheTTL && h.cache.freshAt.After(time.Time{}) {
		return h.cache.view, nil
	}
	view, err := h.service.PortalCatalog(context.Request.Context(), h.options.Models)
	if err != nil {
		if h.cache.freshAt.After(time.Time{}) {
			return h.cache.view, nil
		}
		return dto.PortalOverview{}, err
	}
	h.cache.view, h.cache.freshAt = view, time.Now()
	return view, nil
}

// submitLead 「联系我们」。公开面唯一一条会把来访者填写内容写进库的路径。
func (h *Handler) submitLead(context *gin.Context) {
	var req dto.SubmitLeadRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, "请把联系方式填完整")
		return
	}
	// 整站额度只由**会写库**的请求消耗。
	//
	// 之前是先扣额度再判蜜罐和空联系方式 —— 那两种请求一行都不写，却照样把额度
	// 花掉：60 个 {"contact":"","website":"x"} 就能把「联系我们」关掉一小时，
	// 而且因为没有留下任何行，库里那道按 IP 的闸压根看不见这个人。
	if willWriteLead(req) && !h.allowLead() {
		httpx.Fail(context, "今天的留言收得有点多，请稍后再试或直接发邮件给我们")
		return
	}
	req.IP = clientIP(context)
	req.UserAgent = context.GetHeader("User-Agent")
	view, err := h.service.SubmitLead(context.Request.Context(), req)
	httpx.JSON(context, view, err)
}

// willWriteLead 这条请求最后会不会真的落一行。
//
// 判据必须和 SubmitLead 里那两道前置检查一致（蜜罐、空联系方式），
// 那边改了这边要跟着改 —— 两处判得不一样，额度就又会被不写库的请求吃掉。
func willWriteLead(req dto.SubmitLeadRequest) bool {
	return strings.TrimSpace(req.Website) == "" && strings.TrimSpace(req.Contact) != ""
}

// allowLead 整站每小时的留资上限。窗口滚动到下一个小时就清零。
func (h *Handler) allowLead() bool {
	h.leads.Lock()
	defer h.leads.Unlock()
	now := time.Now()
	if now.Sub(h.leads.windowFrom) >= time.Hour {
		h.leads.windowFrom, h.leads.count = now, 0
	}
	if h.leads.count >= h.options.LeadsPerHour {
		return false
	}
	h.leads.count++
	return true
}

// clientIP 取一个**限流用**的来访者标识。
//
// 取值规则收在 httpx.ClientIP 里，三个服务的登录留痕、登录失败计数和这里的留资
// 限流用的是同一份 —— 各写一遍的话，改了其中一处的取值顺序，另外几处会安静地
// 按老规则继续跑。
//
// 对留资这条路要多记一句：这个值是可以伪造的（门户那层 Next.js 代理把浏览器的
// 请求头原样转发过来），换着 IP 刷的代价由整站每小时上限那道闸兜住 ——
// 而那道闸只由会写库的请求消耗。
func clientIP(context *gin.Context) string {
	return httpx.ClientIP(context)
}
