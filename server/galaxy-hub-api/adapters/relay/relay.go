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

	FamilyAnthropic = "anthropic"
	FamilyOpenAI    = "openai"

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
}

func New(deps *corepkg.Deps, options Options) *Adapter {
	return &Adapter{deps: deps, options: options.withDefaults()}
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
// 协议头（anthropic-version / anthropic-beta）与 SDK 指纹（x-stainless-*）会影响
// 上游的行为与解析，丢掉它们响应就不再与直连一致；authorization、x-api-key、cookie
// 这类凭据一律不转发 —— 上游鉴权用的是提供者本机的订阅登录态。
var forwardedHeaders = []string{
	"anthropic-version", "anthropic-beta", "anthropic-dangerous-direct-browser-access",
	"openai-beta", "user-agent", "x-app", "x-claude-code-session-id",
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

func (a *Adapter) Route(ctx context.Context, raw corepkg.Input) (contract.RouteKey, error) {
	in, ok := raw.(*input)
	if !ok {
		return contract.RouteKey{}, contract.NewUnitError(contract.ErrorClassInput, contract.CodeInvalidBody, false, "入参形状不正确")
	}
	route := contract.RouteKey{
		Kind: Kind, KindVersion: Version, Family: in.spec.family,
		Provider: a.options.Providers[in.spec.family], Model: in.model,
	}
	if in.previousResponseID != "" {
		cid, found := a.deps.Galaxy.LookupResponseContribution(ctx, in.previousResponseID)
		if !found {
			return route, contract.NewUnitError(contract.ErrorClassInput, contract.CodeInvalidBody, false,
				"previous_response_id 已过期，请重新发起对话")
		}
		route.HardPin = cid
	}
	return route, nil
}

// Estimate 预估（设计文档 5.5）。预估只用于预留，终态按实际回补。
func (a *Adapter) Estimate(raw corepkg.Input) contract.Metering {
	in, ok := raw.(*input)
	if !ok {
		return contract.Metering{}
	}
	if in.spec.countTokens {
		// 只数 token 不生成内容：不预留输出额度，时长也短。
		return contract.Metering{
			contract.UnitInputTokens: int64(math.Ceil(float64(len(in.body)) / 3)),
			contract.UnitCalls:       1,
			contract.UnitTimeSeconds: 10,
		}
	}
	return contract.Metering{
		contract.UnitInputTokens:  int64(math.Ceil(float64(len(in.body)) / 3)),
		contract.UnitOutputTokens: in.maxTokens,
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
