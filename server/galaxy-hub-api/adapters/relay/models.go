package relay

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	corepkg "galaxy-hub-api/adapters/core"
)

// 模型清单：GET /v1/models。
//
// 第三方客户端接一个 base_url 时的第一步是「模型发现」—— 打这条路由要清单，拿不到
// 就不让人往下配（连接测试至少要有一个模型）。Hub 以前只挂了会派单的那几条 POST
// 路径，客户端卡在第一步，用户只能自己一个个手敲模型名。
//
// 清单是**部署方声明**的，不从节点汇总：
//   - 节点报上来的 availableModels 是那台机器的上游有什么，union 起来会随着谁在线
//     而抖动 —— 客户端刚存好的模型名过一会儿就从清单里消失了；
//   - 那也等于把每个提供者的上游情况摊给了所有消费者。
//
// 所以它只是一份对外声明，和派单无关：真能不能派出去仍由每条贡献自己的允许/拒绝
// 规则决定（placement 的 ModelMatch）。清单里多写一个没人提供的模型，代价是一次
// no_capacity，而不是一条被悄悄改写的请求。

// DefaultModels 没配 galaxy.models 时的兜底清单。
//
// 兜底是为了「配漏了也别让客户端卡在第一步」，不是要在代码里维护一份模型表 ——
// 上游出新模型时改 galaxy.models，不必动这里。
var DefaultModels = []string{
	"claude-opus-5",
	"claude-sonnet-5",
	"claude-fable-5-1",
	"claude-haiku-4-5-20251001",
	"gpt-5.6-terra",
}

// catalogCreated 清单条目的时间戳。
//
// 两族的官方响应都有这个字段，客户端拿它排序、也拿它比对缓存，所以不能填 time.Now()
// —— 同一份清单每次请求都长得不一样会被当成模型换了。真实发布时间我们并不知道，
// 于是给一个固定值：字段在、形状对、值不抖。
var catalogCreated = time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)

// modelEntry 一个条目同时喂饱两族的解析器。
//
// 同一个 base_url 上既有 Anthropic 客户端也有 OpenAI 客户端，两家的 /v1/models 形状
// 不一样：OpenAI 认 object / created / owned_by，Anthropic 认 type / display_name /
// created_at。两套字段并存互不冲突，各自解析器会忽略掉不认识的那几个。
type modelEntry struct {
	ID          string `json:"id"`
	Object      string `json:"object"`
	Type        string `json:"type"`
	DisplayName string `json:"display_name"`
	Created     int64  `json:"created"`
	CreatedAt   string `json:"created_at"`
	OwnedBy     string `json:"owned_by"`
}

// RegisterExtra 挂不派单的辅助路由。模型清单只读配置，一次共享池都不问。
func (a *Adapter) RegisterExtra(group *gin.RouterGroup, _ corepkg.Deps) {
	group.GET("/models", a.listModels)
	// 发现之后逐个 retrieve 一遍确认模型还在的客户端也不少，一并挂上。
	group.GET("/models/:model", a.getModel)
}

func (a *Adapter) listModels(ginContext *gin.Context) {
	entries := a.modelCatalog()
	// first_id / last_id 是 Anthropic 的翻页字段。清单一次给全，has_more 恒为 false。
	body := gin.H{"object": "list", "data": entries, "has_more": false, "first_id": nil, "last_id": nil}
	if len(entries) > 0 {
		body["first_id"] = entries[0].ID
		body["last_id"] = entries[len(entries)-1].ID
	}
	ginContext.JSON(http.StatusOK, body)
}

func (a *Adapter) getModel(ginContext *gin.Context) {
	id := strings.TrimSpace(ginContext.Param("model"))
	for _, entry := range a.modelCatalog() {
		if entry.ID == id {
			ginContext.JSON(http.StatusOK, entry)
			return
		}
	}
	// not_found_error 是 Anthropic 这条路径的官方错误类型，OpenAI 客户端读的是
	// error.message，两边都能看懂。
	ginContext.JSON(http.StatusNotFound,
		a.ToError(nil, http.StatusNotFound, "not_found_error", "模型不在平台提供的清单里："+id))
}

func (a *Adapter) modelCatalog() []modelEntry {
	entries := make([]modelEntry, 0, len(a.options.Models))
	for _, id := range a.options.Models {
		entries = append(entries, modelEntry{
			ID: id, Object: "model", Type: "model", DisplayName: id,
			Created: catalogCreated.Unix(), CreatedAt: catalogCreated.Format(time.RFC3339),
			OwnedBy: "galaxy",
		})
	}
	return entries
}

// normalizeModels 去空白、去重，但**保持配置里的书写顺序** —— 客户端的下拉就按这个
// 顺序显示，部署方把常用的写在前面是有意的，替他排序等于把这个决定抹掉。
func normalizeModels(raw []string) []string {
	seen := make(map[string]bool, len(raw))
	models := make([]string, 0, len(raw))
	for _, item := range raw {
		id := strings.TrimSpace(item)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		models = append(models, id)
	}
	return models
}

var _ corepkg.SelfRegistering = (*Adapter)(nil)
