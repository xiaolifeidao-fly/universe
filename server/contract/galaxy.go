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
	// 三个 token 桶互不重叠，加起来才是这次请求读进模型的全部输入：
	// UnitInputTokens 是**未命中缓存的新增输入**，不含缓存命中的部分。
	//
	// Anthropic 原生就是这个口径；OpenAI 的 input_tokens 把 cached_tokens 算在里面，
	// 由 Hub 在 relay 解析时减齐（galaxy-hub-api/adapters/relay/usage.go 的 netInput）。
	// 不减的话，billing 逐单位乘单价累加会把缓存那部分收两遍。
	UnitInputTokens      MeterUnit = "llm.input_tokens"
	UnitOutputTokens     MeterUnit = "llm.output_tokens"
	UnitCacheReadTokens  MeterUnit = "llm.cache_read_tokens"
	UnitCacheWriteTokens MeterUnit = "llm.cache_write_tokens"
	UnitCalls            MeterUnit = "llm.calls"

	// 缓存写入按 TTL 拆开的两个计价桶，两者之和恒等于 UnitCacheWriteTokens ——
	// 所以拆开之后**合计那一个不再计价**（同 UnitTotalTokens，由 billing.go 兜住）。
	//
	// 必须拆：Anthropic 的 5 分钟缓存写入是基础输入价的 1.25 倍，1 小时是 2 倍。
	// 混在一个桶里按一个单价收，必然有一边算错，错的方向还取决于流量构成；
	// 而且事后补不回来 —— 分项只在上游那条流里出现过一次，流水里没存。
	//
	// 没有 TTL 概念的协议族（OpenAI）整笔落在 5m 这个桶上：对它来说 5m 就是
	// 「默认档」的意思。这样两族共用同一套计价桶，不会出现「有量却没有可计价的桶」。
	UnitCacheWrite5mTokens MeterUnit = "llm.cache_write_5m_tokens"
	UnitCacheWrite1hTokens MeterUnit = "llm.cache_write_1h_tokens"

	// UnitReasoningTokens 是 UnitOutputTokens 里属于推理的那一部分，不是新的一桶。
	// 推理模型（gpt-5.6 这一档）把它单独报出来，主人要能看出「输出的 3 万 token
	// 里有 2.9 万是在想」。因为是子集，它和合计一样**只进统计与额度，不计价**。
	UnitReasoningTokens MeterUnit = "llm.reasoning_tokens"

	// UnitTotalTokens 是 input / output / cache_read / cache_write 四个桶的**合计**，
	// 不是第五个桶。拆出来的 5m、1h 与 reasoning 都是这四个的子集，不另计入。
	//
	// 它存在的唯一理由是额度：主人想说的是「这台机器一天最多跑 200 万 token」，
	// 而不是「输入 80 万、输出 40 万、缓存读 60 万、缓存写 20 万」—— 分开设四条，
	// 任何一条先触顶都会让整台机器停摆，而剩下三条还空着大半。
	//
	// 因为是合计，它**永远不参与计价**：额度引擎按单位记数，账本按单位乘单价，
	// 把合计也乘一遍就是把每一笔都收两次。这条禁令由 billing.go 兜住，
	// 不依赖「运营别给它定价」。
	UnitTotalTokens MeterUnit = "llm.total_tokens"

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

// ---------- 推理强度 ----------

// Effort 一次请求让模型想多深。
//
// 它是**计价的一个维度**，不是展示字段：同一个模型，max 档一次请求烧掉的推理 token
// 能比 low 档多一个量级，而这些 token 全部落在 output 桶里按同一个单价收 ——
// 于是高强度的请求每跑一次平台都在亏，低强度的又收贵了。价目表因此按
// (kind, model, effort, unit) 定价，见 zt_galaxy_price。
//
// 两族的档位**各自原生**，不做统一映射，而且**两张表不一样长**：
//
//	anthropic  output_config.effort：low / medium / high / xhigh / max，官方默认 high。
//	openai     reasoning.effort：none / minimal / low / medium / high / xhigh / max /
//	           ultra，官方默认 medium。
//
// 这两张表是**从本机的客户端问出来的**，每一档都有出处：
//
//	claude --effort bogus            → 「Valid values: low, medium, high, xhigh, max.」
//	~/.codex/models_cache.json       → 每个模型的 supported_reasoning_levels；
//	                                   gpt-5.6-sol / terra 是 low…max + ultra。
//
// 两个坑，都踩过：
//
//   - **别拿 strings(1) 去二进制里捞。** 捞出来的 `…maxultrapersistent` 是相邻字面量
//     粘在一起的，persistent 属于另一个枚举。照它定价，那行价一次也匹配不上。
//   - **Claude 的 ultracode 不是一档 effort。** 它在 CLI 里是「xhigh + 动态工作流编排，
//     只对本会话生效」（claude 二进制原话），上线时 effort 字段里写的就是 xhigh。
//     给它单独开一档，同样是一行永远匹配不上的价 —— 而且真实的 ultracode 请求
//     会照常按 xhigh 收，看不出任何异常。
//
// 硬造一个跨族的公共刻度同样不行：openai 的 minimal / ultra 在 anthropic 没有对应档，
// none 也只有 openai 有（Claude 关思考走的是 thinking.type=disabled，那是另一个字段，
// 不是一档 effort）。运营定价时面对的就是上游真实收费的那个档位名。
type Effort = string

const (
	// EffortNone 只有 openai 有。它是「这一次不推理」，不是「没填」——
	// 没填走各族默认档（DefaultEffort）。
	EffortNone    Effort = "none"
	EffortMinimal Effort = "minimal"
	EffortLow     Effort = "low"
	EffortMedium  Effort = "medium"
	EffortHigh    Effort = "high"
	EffortXHigh   Effort = "xhigh"
	EffortMax     Effort = "max"
	// EffortUltra 只有 openai 有，排在 max 之上。
	EffortUltra Effort = "ultra"
)

// 两族各自的档位，**按由浅到深排列**：界面上的下拉、价目表的排序都按这个顺序，
// 让运营一眼看出「这一档比那一档贵是对的」。
//
// 具体模型只支持其中一个子集（Codex 按模型下发 supported_reasoning_levels，
// Claude 会对选中的模型做静默降级）。这里给的是**全集** —— 价目表要回答的是
// 「这个值传上来时按多少收」，而传上来的可以是任何一档；按子集收窄，
// 换一个模型就会有一档查不到价，而查不到价是静默算 0。
//
// minimal 留着，虽然本机的模型缓存里一个模型都没声明它：上游的 400 明确说它合法
// （老一些的 gpt-5 走这一档）。漏掉它的代价不是少一行下拉，是 minimal 的请求会被
// NormalizeEffort 判成「认不出来」、补成默认档 medium —— 最浅的一档按中档收钱。
var (
	anthropicEfforts = []Effort{EffortLow, EffortMedium, EffortHigh, EffortXHigh, EffortMax}
	openaiEfforts    = []Effort{
		EffortNone, EffortMinimal, EffortLow, EffortMedium, EffortHigh,
		EffortXHigh, EffortMax, EffortUltra,
	}
)

const (
	// FamilyAnthropic / FamilyOpenAI 协议族名。relay 适配器里也有一份同值常量 ——
	// 这里再定义一次是因为强度词表要按族分叉，而 contract 不能 import 适配器包。
	FamilyAnthropic = "anthropic"
	FamilyOpenAI    = "openai"
)

// FamilyEfforts 某一族认识的全部档位。族名认不出来时返回 nil ——
// 返回一份「通用档位」等于替一个我们并不了解的上游宣布了它的计价刻度。
func FamilyEfforts(family string) []Effort {
	switch strings.ToLower(strings.TrimSpace(family)) {
	case FamilyAnthropic:
		return anthropicEfforts
	case FamilyOpenAI:
		return openaiEfforts
	}
	return nil
}

// DefaultEffort 请求里没写强度时，上游实际会用的那一档。
//
// 计价必须把它补齐：不补的话，「没写」是一个查不到价的空档，会静默回落到模型的
// 不分强度价 —— 而 Codex 不写 reasoning 时上游跑的就是 medium，那笔钱本该按 medium 收。
// 认不出来的族返回空串，也就是不分强度，和加这一列之前的行为一致。
func DefaultEffort(family string) Effort {
	switch strings.ToLower(strings.TrimSpace(family)) {
	case FamilyAnthropic:
		return EffortHigh
	case FamilyOpenAI:
		return EffortMedium
	}
	return ""
}

// NormalizeEffort 把一个外部来的值收敛到该族认识的档位。
//
// 认不出来一律回空串，**不猜也不报错**：请求体里写了什么是消费者的自由，上游怎么处理
// 一个它不认识的档位是上游的事；我们只需要知道「这次算不算某个定了价的档」。
// 猜一个最近的档去计价，等于按一个从没发生过的档位收钱。
func NormalizeEffort(family, value string) Effort {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" {
		return ""
	}
	for _, effort := range FamilyEfforts(family) {
		if effort == normalized {
			return effort
		}
	}
	return ""
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
	// Effort 这次请求的推理强度，已按 Family 收敛过（见 NormalizeEffort / DefaultEffort）。
	// 它进计价键，所以一路要带到单元行上 —— 账单与结算事后都按它重新取价。
	Effort Effort `json:"effort,omitempty"`
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
	// Effort 推理强度，计价键的一部分（见 Effort 的说明）。
	//
	// 它必须留在信封里：结算发生在请求跑完之后，那时 Hub 手上只有 Redis 里这份 JSON，
	// 而取价要 (kind, model, effort) 三样齐全。少了它，同一次请求下单时按 max 档预估、
	// 结算时按不分强度价扣，两个数对不上且没有任何地方会报错。
	Effort Effort `json:"effort,omitempty"`

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
