// Package relay 是中转站适配器：把官方 SDK 的 LLM 请求原样转发到提供者机器上执行。
//
// kind 是 llm.chat，Anthropic Messages 与 OpenAI Responses / ChatCompletions 是它内部的
// 两个「协议族」而不是两个 kind —— 业务语义、计量单位、定价一致，拆开只会让额度与账单分家（架构第 10 节）。
package relay

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"contract"
	"galaxy-common/kinds"
	corepkg "galaxy-hub-api/adapters/core"
)

const (
	// Kind 能力注册名。
	Kind = "llm.chat"
	// Version 契约版本。上游协议不兼容变更时升版，节点与 Hub 在 hello 阶段对齐。
	Version = 1

	FamilyAnthropic = contract.FamilyAnthropic
	FamilyOpenAI    = contract.FamilyOpenAI

	// DefaultBodyLimit relay 原语的内联上限。请求体走内联而不是 OSS 引用（1.2 例外）。
	DefaultBodyLimit = 4 << 20
	// DefaultMaxTokens 消费者没写 max_tokens 时的预估值（设计文档 5.5）。
	DefaultMaxTokens = 4096
	// DefaultRunSeconds 一次 relay 请求的时长预估。
	DefaultRunSeconds = 120
)

type pathSpec struct {
	family string
	// countTokens 只算 token 不产出内容，预估要小得多。
	countTokens bool
}

// consumerPrefix 消费者路由组的前缀。paths 用完整路径作键，因为 Parse 拿到的
// gin FullPath 是带前缀的。
const consumerPrefix = "/v1"

// paths 消费者侧路径 → 协议族。与官方 SDK 的默认路径一致，改 base_url 即可接入（C-02）。
var paths = map[string]pathSpec{
	"/v1/messages":              {family: FamilyAnthropic},
	"/v1/messages/count_tokens": {family: FamilyAnthropic, countTokens: true},
	"/v1/responses":             {family: FamilyOpenAI},
	"/v1/chat/completions":      {family: FamilyOpenAI},
}

// Options 装配参数。
type Options struct {
	// Providers 协议族 → provider（路由键）。provider 决定节点侧加载哪个执行模块。
	Providers map[string]string
	BodyLimit int64
	// Models 对外声明的模型清单（GET /v1/models）。来自 galaxy.models，
	// 不配走 DefaultModels。见 models.go 开头关于「为什么不从节点汇总」的说明。
	Models []string
	// CodexManifest 是 Codex 那份模型清单文件的路径（galaxy.codex_manifest）。
	// 不配就不生效，/v1/models 仍只给两族的经典形状。为什么要它、为什么默认不开，
	// 见 models.go 里 codexCatalog 上面的说明。
	CodexManifest string
}

func (o Options) withDefaults() Options {
	if len(o.Providers) == 0 {
		o.Providers = map[string]string{
			FamilyAnthropic: "claude_oauth",
			FamilyOpenAI:    "codex_chatgpt",
		}
	}
	if o.BodyLimit <= 0 {
		o.BodyLimit = DefaultBodyLimit
	}
	o.Models = normalizeModels(o.Models)
	if len(o.Models) == 0 {
		o.Models = normalizeModels(DefaultModels)
	}
	return o
}

type Adapter struct {
	// deps 是指针：适配器要先被建出来才能交出 KindSpec，而共享池核心又要先有
	// KindSpec 才能建起来。装配层拿这个指针在环建好之后回填 Galaxy。
	deps    *corepkg.Deps
	options Options
	// codexManifest slug → 那一条的原始 JSON。启动时读一次：清单是部署方给的静态
	// 文件，改了跟着重启，不值得为它在请求路径上加一次磁盘读。没配或读不出就是 nil。
	codexManifest map[string]json.RawMessage
}

func New(deps *corepkg.Deps, options Options) *Adapter {
	adapter := &Adapter{deps: deps, options: options.withDefaults()}
	adapter.codexManifest = loadCodexManifest(adapter.options.CodexManifest)
	return adapter
}

// Kind 能力注册（对应设计文档 10.3 的 llm-chat/kind.yaml）。
func (a *Adapter) Kind() contract.KindSpec {
	return kinds.Relay(a.options.Providers, a.options.BodyLimit)
}

// Routes 返回相对于消费者路由组的路径。组本身就是 /v1，这里再带一次前缀会挂成
// /v1/v1/messages —— 官方 SDK 打过来就是 404。
func (a *Adapter) Routes() []corepkg.Route {
	routes := make([]corepkg.Route, 0, len(paths))
	for path := range paths {
		routes = append(routes, corepkg.Route{Method: http.MethodPost, Path: strings.TrimPrefix(path, consumerPrefix)})
	}
	return routes
}

// input 是这个适配器对一次请求的全部解读。
type input struct {
	path   string
	spec   pathSpec
	body   []byte
	model  string
	stream bool
	// effort 这次请求的推理强度，已按协议族收敛（见 parseEffort），
	// 并且在 applyPolicy 之后是**夹过分组档位表**的那一档。
	effort contract.Effort
	// effortFromBudget 这一档是从老式的 thinking.budget_tokens 折出来的，
	// 而不是 output_config.effort。夹档要改回请求体时得知道改哪个字段 ——
	// 给一个只认预算的老模型塞 output_config，它会原样忽略，于是上游照旧按深档跑。
	effortFromBudget bool
	// fast 客户端要的是不是「快速」。同样在 applyPolicy 之后是夹过分组开关的值：
	// 分组没开快速时恒为 false，而且请求体里那个标记已经被改写掉了。
	fast bool
	// maxTokens 预估输出用；countTokens 路径没有它。
	maxTokens int64
	// previousResponseID 触发硬钉。
	previousResponseID string
	sessionHint        string
	// injectedUsage 表示 Hub 往请求体里加了 stream_options.include_usage，
	// 写回时要把多出来的那条 usage chunk 剥掉。
	injectedUsage bool
	// headers 是要转给上游的客户端头。凭据与 authorization 一律不在其中。
	headers map[string]string
}

// forwardedHeaders 转发给上游的客户端头白名单。
//
// 协议头（anthropic-version / anthropic-beta / x-codex-*）与 SDK 指纹（x-stainless-*）
// 会影响上游的行为与解析，丢掉它们响应就不再与直连一致；authorization、x-api-key、cookie
// 这类凭据一律不转发 —— 上游鉴权用的是提供者本机的订阅登录态。
//
// 会话那一组（x-claude-code-session-id / session-id / thread-id / x-codex-window-id）
// 还决定缓存命中：上游按会话把同一条对话的连续请求路由到同一台机器上，少了它，
// 能命中的就只剩所有请求共用的那段开头。Codex 这一组以前整个没在名单里 ——
// 于是 Anthropic 那边命中九成、OpenAI 这边一成多，两条路差在这儿。
var forwardedHeaders = []string{
	"anthropic-version", "anthropic-beta", "anthropic-dangerous-direct-browser-access",
	"openai-beta", "user-agent", "x-app", "x-claude-code-session-id",
	"originator", "session-id", "thread-id", "x-client-request-id",
	"x-codex-window-id", "x-codex-turn-metadata", "x-codex-beta-features",
	"x-openai-internal-codex-responses-lite",
	"x-stainless-arch", "x-stainless-lang", "x-stainless-os",
	"x-stainless-package-version", "x-stainless-retry-count",
	"x-stainless-runtime", "x-stainless-runtime-version", "x-stainless-timeout",
}

func collectHeaders(ginContext *gin.Context) map[string]string {
	headers := map[string]string{}
	for _, name := range forwardedHeaders {
		if value := ginContext.GetHeader(name); value != "" {
			headers[name] = value
		}
	}
	return headers
}

func (a *Adapter) Parse(ginContext *gin.Context) (corepkg.Input, error) {
	path := ginContext.FullPath()
	spec, ok := paths[path]
	if !ok {
		return nil, contract.NewUnitError(contract.ErrorClassInput, contract.CodeInvalidBody, false, "不支持的路径")
	}
	raw, err := io.ReadAll(io.LimitReader(ginContext.Request.Body, a.options.BodyLimit+1))
	if err != nil {
		return &input{path: path, spec: spec}, contract.NewUnitError(contract.ErrorClassInput, contract.CodeInvalidBody, false, "读取请求体失败")
	}
	if int64(len(raw)) > a.options.BodyLimit {
		return &input{path: path, spec: spec}, contract.NewUnitError(contract.ErrorClassInput, contract.CodeInvalidBody, false, "请求体超过上限")
	}

	var envelope struct {
		Model              string `json:"model"`
		Stream             *bool  `json:"stream"`
		MaxTokens          *int64 `json:"max_tokens"`
		MaxOutputTokens    *int64 `json:"max_output_tokens"`
		PreviousResponseID string `json:"previous_response_id"`
		StreamOptions      *struct {
			IncludeUsage *bool `json:"include_usage"`
		} `json:"stream_options"`
		// 推理强度的三个出处，两族各认各的。都是指针 —— 要分得清「填了 none」
		// 和「压根没填」：前者是消费者明确要的那一档，后者要按上游默认档补齐。
		//
		// thinking 这里只读 budget_tokens（老模型的深浅刻度）。type 不读：
		// 关不关思考和 effort 是两个正交的字段，见 anthropicEffort 的说明。
		Thinking *struct {
			BudgetTokens *int64 `json:"budget_tokens"`
		} `json:"thinking"`
		OutputConfig *struct {
			Effort string `json:"effort"`
		} `json:"output_config"`
		Reasoning *struct {
			Effort string `json:"effort"`
		} `json:"reasoning"`
		// ServiceTier 「快速」的出处，两族同名字段不同取值（见 policy.go）。
		ServiceTier string `json:"service_tier"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return &input{path: path, spec: spec}, contract.NewUnitError(contract.ErrorClassInput, contract.CodeInvalidBody, false, "请求体不是合法 JSON")
	}
	if envelope.Model == "" && !spec.countTokens {
		return &input{path: path, spec: spec}, contract.NewUnitError(contract.ErrorClassInput, contract.CodeInvalidBody, false, "缺少 model")
	}

	parsed := &input{
		path: path, spec: spec, body: raw, model: envelope.Model, headers: collectHeaders(ginContext),
		stream:             envelope.Stream != nil && *envelope.Stream,
		previousResponseID: envelope.PreviousResponseID,
		sessionHint:        strings.TrimSpace(ginContext.GetHeader("x-galaxy-session")),
	}
	switch spec.family {
	case FamilyAnthropic:
		var effort string
		var budget int64
		if envelope.Thinking != nil && envelope.Thinking.BudgetTokens != nil {
			budget = *envelope.Thinking.BudgetTokens
		}
		if envelope.OutputConfig != nil {
			effort = envelope.OutputConfig.Effort
		}
		parsed.effort = anthropicEffort(effort, budget)
		// 正主没写、只有老式预算时，这一档是折出来的 —— 夹档要改回预算那个字段。
		parsed.effortFromBudget = contract.NormalizeEffort(FamilyAnthropic, effort) == "" && budget > 0
	case FamilyOpenAI:
		effort := ""
		if envelope.Reasoning != nil {
			effort = envelope.Reasoning.Effort
		}
		parsed.effort = openaiEffort(effort)
	}
	parsed.fast = parseFast(envelope.ServiceTier)
	switch {
	case envelope.MaxTokens != nil:
		parsed.maxTokens = *envelope.MaxTokens
	case envelope.MaxOutputTokens != nil:
		parsed.maxTokens = *envelope.MaxOutputTokens
	default:
		parsed.maxTokens = DefaultMaxTokens
	}

	// chat/completions 的流式响应默认不带 usage。Hub 要按流计量就必须注入这个选项，
	// 再在写回时把多出来的那条 chunk 剥掉（设计文档 6.1）。
	if path == "/v1/chat/completions" && parsed.stream &&
		(envelope.StreamOptions == nil || envelope.StreamOptions.IncludeUsage == nil || !*envelope.StreamOptions.IncludeUsage) {
		if patched, ok := injectIncludeUsage(raw); ok {
			parsed.body = patched
			parsed.injectedUsage = true
		}
	}
	return parsed, nil
}

// anthropicEffort 从 Messages 请求体里读出这次的推理强度。
//
// 按出处的优先级取，取到就停：
//
//  1. output_config.effort —— 当前模型上的正主（low / medium / high / xhigh / max）。
//  2. thinking.budget_tokens —— 老模型（Haiku 4.5 及更早）唯一的深浅刻度，按预算折成档。
//  3. 都没有 —— 补上官方默认档 high。不补的话「没填」会变成一个查不到价的空档，
//     静默回落到不分强度价，而上游那一次是实打实按 high 跑的。
//
// **thinking.type=disabled 不参与判定。** 它和 effort 是两个正交的字段：关掉思考之后
// output_config.effort 照样生效（照样按它的单价收），只是那一次不会产生推理 token ——
// 而「少了一大桶 token」这件事已经由实际计量如实反映了，不该再在单价上折一次。
// 早先的实现把它记成一个 none 档，那是个 Claude 根本没有的档位名：价目表上给它定的价
// 永远匹配不上任何一次真实请求（真实请求的 effort 字段里不会出现 none）。
func anthropicEffort(effort string, budget int64) contract.Effort {
	if normalized := contract.NormalizeEffort(FamilyAnthropic, effort); normalized != "" {
		return normalized
	}
	if budget > 0 {
		return budgetEffort(budget)
	}
	return contract.DefaultEffort(FamilyAnthropic)
}

// budgetEffort 把老式的 thinking 预算折成档位。
//
// 分界取的是 Claude Code 那三档预设（think = 4000、think hard = 10000、
// ultrathink = 31999）之间的空档，而不是均分：真实流量几乎全部落在这三个值上，
// 界划在它们中间，任何一档写多写少几百 token 都不会掉到隔壁去。
// 超过 ultrathink 的一律 high —— 老口径里 high 就是最深的一档，没有 xhigh / max。
func budgetEffort(budget int64) contract.Effort {
	switch {
	case budget < 8000:
		return contract.EffortLow
	case budget < 24000:
		return contract.EffortMedium
	default:
		return contract.EffortHigh
	}
}

// openaiEffort 从 Responses / ChatCompletions 请求体里读出推理强度。
//
// 只有 reasoning.effort 一个出处。没写就补官方默认档 medium —— Codex 默认就是按它跑的，
// 而不写这个字段的客户端（老 SDK、非推理模型）在上游那边同样吃这个默认。
func openaiEffort(effort string) contract.Effort {
	if normalized := contract.NormalizeEffort(FamilyOpenAI, effort); normalized != "" {
		return normalized
	}
	return contract.DefaultEffort(FamilyOpenAI)
}

// injectIncludeUsage 只改 stream_options 这一个字段，其余字节原样保留。
func injectIncludeUsage(raw []byte) ([]byte, bool) {
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, false
	}
	options := map[string]any{"include_usage": true}
	if existing, ok := payload["stream_options"]; ok {
		var current map[string]any
		if err := json.Unmarshal(existing, &current); err == nil && current != nil {
			current["include_usage"] = true
			options = current
		}
	}
	encoded, err := json.Marshal(options)
	if err != nil {
		return nil, false
	}
	payload["stream_options"] = encoded
	out, err := json.Marshal(payload)
	if err != nil {
		return nil, false
	}
	return out, true
}

// ApplyPolicy 通用层解出这一次的分组之后调它，把强度与快速夹到分组卖的范围内，
// 并**同步改写请求体**。返回夹过之后的值，通用层拿它盖回路由键与单元行。
//
// 为什么是适配器的事：请求体的形状只有它认识（两族的强度字段名都不一样，
// 老模型还得改预算）。通用层只知道「这次落在哪个分组、那个分组卖哪几档」。
func (a *Adapter) ApplyPolicy(raw corepkg.Input, policy contract.GroupPolicy) (contract.Effort, bool) {
	in, ok := raw.(*input)
	if !ok {
		return "", false
	}
	a.applyPolicy(in, policy)
	return in.effort, in.fast
}

func (a *Adapter) Route(ctx context.Context, raw corepkg.Input) (contract.RouteKey, error) {
	in, ok := raw.(*input)
	if !ok {
		return contract.RouteKey{}, contract.NewUnitError(contract.ErrorClassInput, contract.CodeInvalidBody, false, "入参形状不正确")
	}
	route := contract.RouteKey{
		Kind: Kind, KindVersion: Version, Family: in.spec.family,
		Provider: a.options.Providers[in.spec.family], Model: in.model,
		Effort: in.effort, Fast: in.fast,
	}
	// Group 不在这里填：请求体里没有分组这个概念，它由密钥决定。
	// 通用层鉴权之后解出来，再调 ApplyPolicy 让这个适配器把请求体改到位。
	if in.previousResponseID != "" {
		cid, found := a.deps.Galaxy.LookupResponseContribution(ctx, in.previousResponseID)
		if !found {
			// 请求本身带着完整上下文，response id 只是优先回原贡献的加速线索。
			// 映射过期后摘掉它，按普通请求重新放置；直接 400 会让一条内容完整的
			// 旧会话仅仅因为路由缓存过期就永久不能继续。
			if detached, ok := detachPreviousResponseID(in.body); ok {
				in.body = detached
				in.previousResponseID = ""
				return route, nil
			}
			return route, contract.NewUnitError(contract.ErrorClassInput, contract.CodeInvalidBody, false,
				"previous_response_id 已过期，且请求上下文无法脱离旧响应")
		}
		route.HardPin = cid
	}
	return route, nil
}

func detachPreviousResponseID(raw []byte) ([]byte, bool) {
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, false
	}
	delete(payload, "previous_response_id")
	detached, err := json.Marshal(payload)
	if err != nil {
		return nil, false
	}
	return detached, true
}

// Estimate 预估（设计文档 5.5）。预估只用于预留，终态按实际回补。
func (a *Adapter) Estimate(raw corepkg.Input) contract.Metering {
	in, ok := raw.(*input)
	if !ok {
		return contract.Metering{}
	}
	// 合计要跟着一起预留。主人的上限设在合计上而这里不预留，额度就只在结算时
	// 一次性扣掉 —— 中间那段时间里放置算法看到的是「还剩满格」，会把远超上限的
	// 请求一股脑放进来。预估里没有缓存（还没打上游，不知道会不会命中），
	// 所以合计就是输入加输出；实际值在结算时按四个桶重算（usage.go 的 withTotal）。
	if in.spec.countTokens {
		// 只数 token 不生成内容：不预留输出额度，时长也短。
		input := int64(math.Ceil(float64(len(in.body)) / 3))
		return contract.Metering{
			contract.UnitInputTokens: input,
			contract.UnitTotalTokens: input,
			contract.UnitCalls:       1,
			contract.UnitTimeSeconds: 10,
		}
	}
	input := int64(math.Ceil(float64(len(in.body)) / 3))
	return contract.Metering{
		contract.UnitInputTokens:  input,
		contract.UnitOutputTokens: in.maxTokens,
		contract.UnitTotalTokens:  input + in.maxTokens,
		contract.UnitCalls:        1,
		contract.UnitTimeSeconds:  DefaultRunSeconds,
	}
}

func (a *Adapter) ToUnit(raw corepkg.Input, caller corepkg.Caller) contract.WorkUnit {
	in, ok := raw.(*input)
	if !ok {
		return contract.WorkUnit{}
	}
	unit := contract.WorkUnit{
		Kind: Kind, KindVersion: Version, Primitive: contract.PrimitiveRelay,
		Family: in.spec.family, Provider: a.options.Providers[in.spec.family], Model: in.model,
		Effort:      in.effort,
		Fast:        in.fast,
		ConsumerKey: caller.KeyID,
		Inputs: []contract.Payload{{
			Name: "body", Inline: in.body, ContentType: "application/json",
		}},
	}
	// 子会话亲和：同一密钥下的不同 agent 可以分别绑座位（C-04）。
	unit.AffinityKey = caller.KeyID
	if in.sessionHint != "" {
		unit.AffinityKey = caller.KeyID + ":" + in.sessionHint
	}
	// 节点要知道往哪条上游路径转发，以及带哪些客户端头。
	// relay 不解析请求体，这两样就是全部路由信息。
	unit.Inputs = append(unit.Inputs,
		contract.Payload{Name: "path", Inline: []byte(in.path), ContentType: "text/plain"},
		contract.Payload{Name: "headers", Inline: encodeHeaders(in.headers), ContentType: "application/json"},
	)
	return unit
}

// Writer 每条路径一个解析器：三种上游各自把用量放在不同的事件里。
func encodeHeaders(headers map[string]string) []byte {
	raw, err := json.Marshal(headers)
	if err != nil {
		return []byte("{}")
	}
	return raw
}

func (a *Adapter) Writer(ginContext *gin.Context, raw corepkg.Input, unit contract.WorkUnit) corepkg.EventWriter {
	writer := &relayWriter{context: ginContext, galaxy: a.deps.Galaxy, unitID: unit.ID, family: unit.Family}
	in, ok := raw.(*input)
	if !ok {
		writer.sniffer = &anthropicSniffer{}
		return writer
	}
	switch in.path {
	case "/v1/chat/completions":
		writer.sniffer = &chatSniffer{}
	case "/v1/responses":
		writer.sniffer = &responsesSniffer{}
	default:
		writer.sniffer = &anthropicSniffer{}
	}
	writer.stripUsage = in.injectedUsage
	writer.requestedStream = in.stream
	return writer
}

// ToError 错误体形态与官方一致（沿用 ai-bridge RELAY_PATHS 的 errorBody）。
func (a *Adapter) ToError(raw corepkg.Input, status int, code, message string) any {
	family := FamilyAnthropic
	if in, ok := raw.(*input); ok && in.spec.family != "" {
		family = in.spec.family
	}
	if family == FamilyOpenAI {
		return gin.H{"error": gin.H{"message": message, "type": code, "code": code, "param": nil, "status": status}}
	}
	return gin.H{"type": "error", "error": gin.H{"type": code, "message": message, "status": status}}
}

var _ corepkg.Adapter = (*Adapter)(nil)
