package contract

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

// 共享算力池的跨层数据形状。这一层被 service/galaxy、galaxy-api、各业务适配器同时看见，
// 所以只放形状与常量，不放任何行为依赖（零 import 业务包）。
//
// 名词对照见 doc/galaxy/需求.md 第 2 节：
//   贡献(Contribution) 是供给的最小单元，座位、额度、队列、绑定全部按它组织；
//   工作单元(WorkUnit) 是通道层的统一信封，一次请求 / 一个回合 / 一个任务。

// GalaxyBizLine 共享池按平台维度运行，不按空间隔离（决策 D-05）。
// 池内表的 biz_line 固定为这个值；任务宇宙等按空间运行的业务在各自适配器里携带真实空间。
const GalaxyBizLine BizLine = "galaxy"

// ---------- 原语 ----------

// Primitive 通道层对工作形态的三种抽象。由 kind 决定，调用方不可填。
type Primitive string

const (
	// PrimitiveRelay 同步流式：请求 / 响应原样转发，上下文在消费者客户端。
	PrimitiveRelay Primitive = "relay"
	// PrimitiveSession 有状态多回合：上下文分账本 / 节点 thread / Git 远端三层。
	PrimitiveSession Primitive = "session"
	// PrimitiveJob 异步长任务：输入输出全部 OSS 引用，可在任意节点按 attempt 重跑。
	PrimitiveJob Primitive = "job"
)

func (p Primitive) Valid() bool {
	switch p {
	case PrimitiveRelay, PrimitiveSession, PrimitiveJob:
		return true
	}
	return false
}

// ---------- 计量单位 ----------

// MeterUnit 额度与计费的度量。单位是注册制的（X-06）：新增业务自带自己的单位集合，
// 额度引擎本身不认识任何具体单位，只按「单位 → 上限」这张表算。
type MeterUnit = string

const (
	UnitInputTokens      MeterUnit = "llm.input_tokens"
	UnitOutputTokens     MeterUnit = "llm.output_tokens"
	UnitCacheReadTokens  MeterUnit = "llm.cache_read_tokens"
	UnitCacheWriteTokens MeterUnit = "llm.cache_write_tokens"
	UnitCalls            MeterUnit = "llm.calls"

	UnitTimeSeconds MeterUnit = "time.seconds"

	UnitVideoOutputSeconds MeterUnit = "video.output_seconds"
	UnitVideoInputSeconds  MeterUnit = "video.input_seconds"
	UnitVideoFrames        MeterUnit = "video.frames"

	UnitGPUSeconds MeterUnit = "gpu.seconds"
	UnitCPUSeconds MeterUnit = "cpu.seconds"

	UnitStorageBytes MeterUnit = "storage.bytes"
	UnitEgressBytes  MeterUnit = "egress.bytes"
)

// MeterSource 计量值的来源。平台侧计量优先（S-04）：次数与时长 Hub 自己计，
// token 由 Hub 从透传的流里解析，节点自报只用于对账。
type MeterSource string

const (
	MeterSourceHub    MeterSource = "hub"
	MeterSourceStream MeterSource = "stream"
	MeterSourceNode   MeterSource = "node"
)

// Metering 一组单位到数量的映射。预估与实际用同一种形状。
type Metering map[MeterUnit]int64

func (m Metering) Clone() Metering {
	if m == nil {
		return nil
	}
	out := make(Metering, len(m))
	for unit, amount := range m {
		out[unit] = amount
	}
	return out
}

// Units 返回排序后的单位列表，让 Lua 参数、日志与账单行的顺序稳定可比。
func (m Metering) Units() []MeterUnit {
	units := make([]MeterUnit, 0, len(m))
	for unit := range m {
		units = append(units, unit)
	}
	sort.Strings(units)
	return units
}

func (m Metering) Add(other Metering) Metering {
	out := m.Clone()
	if out == nil {
		out = Metering{}
	}
	for unit, amount := range other {
		out[unit] += amount
	}
	return out
}

// ---------- 载荷 ----------

// ArtifactRef 产物引用。Hub 不代理产物字节，只签发 presigned URL（约束 3）。
// Key 里不含任何用户、密钥、节点信息。
type ArtifactRef struct {
	Store       string `json:"store"`
	Key         string `json:"key"`
	Size        int64  `json:"size,omitempty"`
	SHA256      string `json:"sha256,omitempty"`
	ContentType string `json:"contentType,omitempty"`
	ExpiresAt   string `json:"expiresAt,omitempty"`
	// URL 只在下发给节点或回给消费者的那一刻填 presigned 地址，不入库、不进 Redis。
	URL string `json:"url,omitempty"`
}

// Payload 二态：小载荷内联，大载荷走 OSS 引用。两者互斥。
type Payload struct {
	Name        string       `json:"name"`
	Inline      []byte       `json:"inline,omitempty"`
	Ref         *ArtifactRef `json:"ref,omitempty"`
	ContentType string       `json:"contentType,omitempty"`
}

// ---------- 路由 ----------

// RouteKey 适配器 Route() 的产物，是放置算法唯一的输入形状。
type RouteKey struct {
	Kind        string `json:"kind"`
	KindVersion int    `json:"kindVersion"`
	// Family 协议族（relay 用）：anthropic | openai。同一 kind 内不拆，计量与定价一致。
	Family   string `json:"family,omitempty"`
	Provider string `json:"provider"`
	Model    string `json:"model,omitempty"`
	// AffinityKey 决定回不回同一个贡献；relay 默认 consumerKey + x-galaxy-session。
	AffinityKey string `json:"affinityKey,omitempty"`
	// HardPin 非空时跳过打分直接钉住该贡献：Responses 链式请求与 session 硬亲和。
	HardPin string `json:"hardPin,omitempty"`
}

// Lane 通道标识：一个 (kind, provider) 一条通道，贡献按它归组。
func (r RouteKey) Lane() string { return Lane(r.Kind, r.Provider) }

func Lane(kind, provider string) string { return kind + "|" + provider }

// ---------- 能力注册 ----------

// Affinity 消费者请求是否倾向或必须回到同一贡献。
type Affinity string

const (
	AffinityNone Affinity = "none"
	AffinitySoft Affinity = "soft"
	AffinityHard Affinity = "hard"
)

// KindSpec 一种业务能力的注册项。Hub 启动时从各适配器读入，放置与额度按它做决策。
type KindSpec struct {
	Kind      string    `json:"kind"`
	Version   int       `json:"version"`
	Primitive Primitive `json:"primitive"`
	Families  []string  `json:"families,omitempty"`
	Providers []string  `json:"providers"`

	Metering struct {
		// Units 该 kind 允许出现的计量单位；提供者授权的额度单位必须属于它。
		Units []MeterUnit `json:"units"`
		// Trusted 由 Hub 自己计量、不采信节点自报的单位。
		Trusted []MeterUnit `json:"trusted"`
	} `json:"metering"`

	Placement struct {
		Affinity     Affinity       `json:"affinity"`
		Requires     map[string]any `json:"requires,omitempty"`
		LocalityHint string         `json:"localityHint,omitempty"`
	} `json:"placement"`

	Retry struct {
		Idempotent  bool `json:"idempotent"`
		MaxAttempts int  `json:"maxAttempts"`
	} `json:"retry"`

	Lease struct {
		RenewSec  int `json:"renewSec"`
		MaxRunSec int `json:"maxRunSec"`
	} `json:"lease"`

	Retention struct {
		Inputs  string `json:"inputs,omitempty"`
		Outputs string `json:"outputs,omitempty"`
	} `json:"retention"`

	Context struct {
		Schema string `json:"schema,omitempty"`
		Resume string `json:"resume,omitempty"`
	} `json:"context"`

	Input struct {
		Schema         string `json:"schema,omitempty"`
		MaxInlineBytes int    `json:"maxInlineBytes"`
	} `json:"input"`
}

// TrustsUnit 报告某个单位是否由 Hub 权威计量。false 表示只能采信节点自报。
func (k KindSpec) TrustsUnit(unit MeterUnit) bool {
	for _, trusted := range k.Metering.Trusted {
		if trusted == unit {
			return true
		}
	}
	return false
}

func (k KindSpec) AllowsUnit(unit MeterUnit) bool {
	for _, allowed := range k.Metering.Units {
		if allowed == unit {
			return true
		}
	}
	return false
}

func (k KindSpec) SupportsProvider(provider string) bool {
	for _, candidate := range k.Providers {
		if candidate == provider {
			return true
		}
	}
	return false
}

// Ref 是 kind 注册表的键：同名不同版本是两条独立注册。
func (k KindSpec) Ref() string { return KindRef(k.Kind, k.Version) }

func KindRef(kind string, version int) string { return fmt.Sprintf("%s@%d", kind, version) }

// ---------- 工作单元 ----------

// UnitState 工作单元状态机（设计文档 1.3）。
type UnitState string

const (
	UnitQueued    UnitState = "queued"
	UnitPlaced    UnitState = "placed"
	UnitRunning   UnitState = "running"
	UnitStreaming UnitState = "streaming"
	UnitCompleted UnitState = "completed"
	UnitFailed    UnitState = "failed"
	UnitCancelled UnitState = "cancelled"
	UnitExpired   UnitState = "expired"
)

func (s UnitState) Terminal() bool {
	switch s {
	case UnitCompleted, UnitFailed, UnitCancelled, UnitExpired:
		return true
	}
	return false
}

// ErrorClass 错误分类（设计文档第 12 节）。它决定改派、计费与信誉三件事，
// 所以是协议的一部分而不是日志字段。
type ErrorClass string

const (
	ErrorClassInput    ErrorClass = "input_fault"
	ErrorClassUpstream ErrorClass = "upstream_fault"
	ErrorClassNode     ErrorClass = "node_fault"
	ErrorClassHub      ErrorClass = "hub_fault"
	ErrorClassBilling  ErrorClass = "billing"
	ErrorClassProtocol ErrorClass = "protocol"
)

// 错误码。消费者与节点两侧共用同一套字符串。
const (
	CodeInvalidBody     = "invalid_body"
	CodeModelNotAllowed = "model_not_allowed"
	CodeContentPolicy   = "content_policy"
	CodeArtifactMissing = "artifact_missing"

	CodeUpstream429     = "upstream_429"
	CodeUpstream5xx     = "upstream_5xx"
	CodeUpstreamTimeout = "upstream_timeout"

	CodeNodeOffline            = "node_offline"
	CodeNodeUnavailable        = "node_unavailable"
	CodeLeaseExpired           = "lease_expired"
	CodeCapabilityMismatch     = "capability_mismatch"
	CodeStreamIdleTimeout      = "stream_idle_timeout"
	CodeOutputChecksumMismatch = "output_checksum_mismatch"

	CodeNoCapacity       = "no_capacity"
	CodeQueueWaitTimeout = "queue_wait_timeout"
	CodeRedisUnavailable = "redis_unavailable"

	CodeInsufficientBalance = "insufficient_balance"
	CodeKeyInvalid          = "key_invalid"
	CodeKeyExpired          = "key_expired"
	CodeScopeDenied         = "scope_denied"

	CodeContractMismatch = "contract_mismatch"
	CodeLeaseInvalid     = "lease_invalid"
	CodeUnitCancelled    = "unit_cancelled"
	CodeConsentRequired  = "consent_required"
)

// UnitError 终态错误。Retryable 只表达「这一类错误本身可不可重试」，
// 真正改不改派还要看首字节是否已经发出（失败语义见设计文档 6.2）。
type UnitError struct {
	Class     ErrorClass `json:"class"`
	Code      string     `json:"code"`
	Retryable bool       `json:"retryable"`
	Message   string     `json:"message,omitempty"`
}

func (e *UnitError) Error() string {
	if e == nil {
		return ""
	}
	if e.Message == "" {
		return e.Code
	}
	return e.Code + ": " + e.Message
}

// HTTPStatus 把错误码映射成消费者侧的 HTTP 状态码（设计文档第 12 节的表）。
func (e *UnitError) HTTPStatus() int {
	if e == nil {
		return 200
	}
	switch e.Code {
	case CodeKeyInvalid, CodeKeyExpired:
		return 401
	case CodeInsufficientBalance:
		return 402
	case CodeScopeDenied, CodeContentPolicy, CodeConsentRequired:
		return 403
	case CodeInvalidBody, CodeModelNotAllowed, CodeArtifactMissing:
		return 400
	case CodeLeaseInvalid:
		return 409
	case CodeUnitCancelled:
		return 410
	case CodeContractMismatch:
		return 426
	}
	switch e.Class {
	case ErrorClassInput:
		return 400
	case ErrorClassUpstream:
		return 502
	case ErrorClassNode:
		return 502
	case ErrorClassHub:
		return 503
	}
	return 500
}

func NewUnitError(class ErrorClass, code string, retryable bool, message string) *UnitError {
	return &UnitError{Class: class, Code: code, Retryable: retryable, Message: message}
}

// WorkUnit 通道层的统一信封。通用层对 Inputs 不透明（约束 7）：
// 业务参数只在适配器的 Parse 进、写回出两处被解读。
type WorkUnit struct {
	ID          string    `json:"id"`
	Kind        string    `json:"kind"`
	KindVersion int       `json:"kindVersion"`
	Primitive   Primitive `json:"primitive"`
	Family      string    `json:"family,omitempty"`
	Provider    string    `json:"provider"`
	Model       string    `json:"model,omitempty"`

	// ConsumerKey 是密钥的匿名标识（ck_…），不是 sk- 明文；节点只看得到它。
	ConsumerKey string `json:"consumerKey"`
	// Space 是业务自己的空间（任务宇宙的 bizLine 之类），由适配器解析。
	// 共享池本身按平台维度运行，池内表的 biz_line 固定为 galaxy；
	// 这个字段只用来给按空间运行的业务做统计与回查（O-02）。
	Space       string `json:"space,omitempty"`
	AffinityKey string `json:"affinityKey,omitempty"`
	HardPin     string `json:"hardPin,omitempty"`
	// CID 放置后填：命中的贡献 id。
	CID string `json:"cid,omitempty"`

	// Op 是 session 原语的子类型：open | resume | turn | close。
	// relay 与 job 留空 —— 它们只有一种工作形态，不需要再分。
	Op  string `json:"op,omitempty"`
	SID string `json:"sid,omitempty"`

	Seq     int `json:"seq,omitempty"`
	Attempt int `json:"attempt,omitempty"`

	Deadline int64 `json:"deadline,omitempty"`

	Inputs  []Payload `json:"inputs,omitempty"`
	Outputs []Payload `json:"outputs,omitempty"`

	Metering struct {
		Estimate Metering `json:"estimate,omitempty"`
		Actual   Metering `json:"actual,omitempty"`
	} `json:"metering"`

	State     UnitState  `json:"state"`
	Error     *UnitError `json:"error,omitempty"`
	CreatedAt int64      `json:"createdAt"`
}

// Lane 单元所属通道。
func (u WorkUnit) Lane() string { return Lane(u.Kind, u.Provider) }

// session 原语的子类型。
const (
	OpOpen   = "open"
	OpResume = "resume"
	OpTurn   = "turn"
	OpClose  = "close"
)

// InlineInput 取内联载荷；relay 的请求体就走这里。
func (u WorkUnit) InlineInput(name string) ([]byte, bool) {
	for _, payload := range u.Inputs {
		if payload.Name == name && payload.Ref == nil {
			return payload.Inline, true
		}
	}
	return nil, false
}

// ---------- 模型白名单 ----------

// ModelMatch 判断模型是否命中 allow ∖ deny。模式支持尾部 *，与节点侧同语义。
// 白名单在 Hub 放置时过滤一次、节点收单时再校验一次（原则 8：两侧对称校验）。
func ModelMatch(model string, allow, deny []string) bool {
	for _, pattern := range deny {
		if matchPattern(model, pattern) {
			return false
		}
	}
	if len(allow) == 0 {
		return true
	}
	for _, pattern := range allow {
		if matchPattern(model, pattern) {
			return true
		}
	}
	return false
}

func matchPattern(value, pattern string) bool {
	pattern = strings.TrimSpace(pattern)
	if pattern == "" {
		return false
	}
	if pattern == "*" {
		return true
	}
	if strings.HasSuffix(pattern, "*") {
		return strings.HasPrefix(value, strings.TrimSuffix(pattern, "*"))
	}
	return value == pattern
}

// ---------- 哨兵错误 ----------

var (
	ErrKindNotRegistered = errors.New("能力未注册")
	ErrNoCapacity        = errors.New("共享池暂无可用算力，请稍后重试")
	ErrConsentRequired   = errors.New("请先阅读并同意共享池条款")
	// ErrNodeBanned 节点鉴权和 hello 拦下被封禁的机器时回的都是它：hello 只是新配出来的记录
	// 第一个被认出来的地方，节点侧不该因为拦在哪一层而看到两种结果。
	ErrNodeBanned = errors.New("这台机器已被平台停用")
)
