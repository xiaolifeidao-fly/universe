package relay

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
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
	if manifest, ok := a.codexCatalog(ginContext); ok {
		ginContext.JSON(http.StatusOK, gin.H{"models": manifest})
		return
	}
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

// Codex 那一路的清单：GET /v1/models?client_version=…
//
// 新版 Codex（app-server / Desktop）不读上面两族的形状，它要自己那份 model manifest：
// 外层键是 models，每条至少要有 slug、display_name、supported_reasoning_levels、
// shell_type、visibility、supported_in_api、priority、support_verbosity、
// truncation_policy、experimental_supported_tools，**而且必须带 base_instructions
// 或 model_messages.instructions_template** —— 那是 Codex 的系统提示词，客户端会拿
// 它替换内置的那份。
//
// 所以这条路默认不开：解析不了的时候 Codex 会回落到内置清单和内置提示词，除了每隔
// 几分钟往日志里记一次 refresh 失败，功能是好的；而我们要是随手编一份提示词塞过去，
// 换来的是所有经 galaxy 的 Codex 都被这份提示词接管，能力怎么变没人说得清。要开就
// 由部署方拿一份真清单来（galaxy.codex_manifest），我们只负责从里面挑出
// galaxy.models 声明过的那几条 —— 清单的语义仍归 galaxy.models 管。
//
// 分流看 client_version：两族官方 SDK 打 /v1/models 都不带这个参数，Codex 每次都带。
func (a *Adapter) codexCatalog(ginContext *gin.Context) ([]json.RawMessage, bool) {
	if len(a.codexManifest) == 0 || ginContext.Query("client_version") == "" {
		return nil, false
	}
	entries := make([]json.RawMessage, 0, len(a.options.Models))
	for _, id := range a.options.Models {
		if entry, ok := a.codexManifest[id]; ok {
			entries = append(entries, entry)
		}
	}
	// 一条都对不上，说明清单和 galaxy.models 配岔了。这时候回一个空的 models 等于
	// 告诉 Codex「这儿一个模型都没有」，比让它回落到内置清单更糟 —— 退回经典形状。
	if len(entries) == 0 {
		return nil, false
	}
	return entries, true
}

// loadCodexManifest 读清单文件，按 slug 索引。
//
// 条目原样保留（json.RawMessage）：那三十来个字段是 Codex 自己的协议，我们既不解读
// 也不替它补默认值 —— 客户端一升级，少了哪个字段是它和清单提供方之间的事，中间插一层
// 我们的结构体只会把新字段吃掉。
//
// 读不出来不拦启动：这份清单只影响 Codex 的模型发现，派单、计费、鉴权都不看它。
func loadCodexManifest(path string) map[string]json.RawMessage {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		log.Printf("galaxy relay 读不到 Codex 模型清单 %s：%v（Codex 会回落到它的内置清单）", path, err)
		return nil
	}
	// 只取 models：Codex 自己缓存下来的那份在外面还包了 fetched_at / etag / identity，
	// 多出来的键忽略就是了，让部署方把缓存文件直接拿来用。
	var document struct {
		Models []json.RawMessage `json:"models"`
	}
	if err := json.Unmarshal(raw, &document); err != nil {
		log.Printf("galaxy relay 解不开 Codex 模型清单 %s：%v", path, err)
		return nil
	}
	catalog := make(map[string]json.RawMessage, len(document.Models))
	for _, item := range document.Models {
		var head struct {
			Slug string `json:"slug"`
		}
		if err := json.Unmarshal(item, &head); err != nil || strings.TrimSpace(head.Slug) == "" {
			continue
		}
		catalog[head.Slug] = item
	}
	if len(catalog) == 0 {
		log.Printf("galaxy relay 的 Codex 模型清单 %s 里没有一条带 slug 的记录", path)
		return nil
	}
	log.Printf("galaxy relay 载入 Codex 模型清单 %s：%d 条", path, len(catalog))
	return catalog
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
