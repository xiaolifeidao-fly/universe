// Package dto 是共享池领域自己的入参与视图形状。
// 跨层看得见的形状在 contract/galaxy.go，这里只放 API ↔ service 之间的东西。
package dto

import (
	"time"

	"contract"
)

// ---------- 提供者：加入与贡献 ----------

// IssuePairingCodeRequest 控制台生成一次性配对码。
// 未记录当前条款版本同意的提供者拿不到配对码（P-16）。
type IssuePairingCodeRequest struct {
	OwnerUserID  string `json:"ownerUserId"`
	TermsVersion string `json:"termsVersion"`
}

type PairingCodeView struct {
	Code      string    `json:"code"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// AcceptTermsRequest 记录一次明示同意。提供者与消费者共用，靠 SubjectType 区分。
type AcceptTermsRequest struct {
	SubjectType  string `json:"subjectType"`
	UserID       string `json:"userId"`
	TermsVersion string `json:"termsVersion"`
	IP           string `json:"-"`
	UserAgent    string `json:"-"`
}

// PairRequest 节点用配对码换取长期 node token。
type PairRequest struct {
	Code          string `json:"code" binding:"required"`
	DisplayName   string `json:"displayName"`
	BridgeVersion string `json:"bridgeVersion"`
}

type PairResult struct {
	NodeID string `json:"nodeId"`
	// Token 明文只在这一次返回，Hub 只存 sha256。
	Token           string `json:"token"`
	HubInstanceHint string `json:"hubInstanceHint,omitempty"`
}

// ContributionInput 是 hello 里申报的一条贡献。
type ContributionInput struct {
	CID         string `json:"cid" binding:"required"`
	Kind        string `json:"kind" binding:"required"`
	KindVersion int    `json:"kindVersion"`
	Provider    string `json:"provider" binding:"required"`
	Models      struct {
		Allow []string `json:"allow"`
		Deny  []string `json:"deny"`
	} `json:"models"`
	Seats           int               `json:"seats"`
	SeatConcurrency int               `json:"seatConcurrency"`
	Quota           []QuotaGrantInput `json:"quota"`
	Schedule        []ScheduleInput   `json:"schedule"`
	UpstreamOK      *bool             `json:"upstreamOK"`
}

type QuotaGrantInput struct {
	Unit    string `json:"unit"`
	Limit   int64  `json:"limit"`
	Window  string `json:"window"`
	ResetAt string `json:"resetAt"`
}

type ScheduleInput struct {
	From string `json:"from"`
	To   string `json:"to"`
	TZ   string `json:"tz"`
}

// HelloRequest 全量替换该节点的贡献集合。contributions.update 是同一个端点。
type HelloRequest struct {
	NodeID        string              `json:"-"` // 由凭证认定，覆盖请求体
	OwnerUserID   string              `json:"-"`
	BridgeVersion string              `json:"bridgeVersion"`
	Contract      int                 `json:"contract"`
	Resources     map[string]any      `json:"resources"`
	Contributions []ContributionInput `json:"contributions"`
	Instance      string              `json:"-"`
}

type HelloResult struct {
	Accepted []string `json:"accepted"`
	Rejected []struct {
		CID    string `json:"cid"`
		Reason string `json:"reason"`
	} `json:"rejected"`
	// QuotaEffective 是 Hub 侧生效值。主人在控制台改过额度时它与节点本地不同，
	// 节点以此为准更新展示副本。
	QuotaEffective map[string][]QuotaGrantInput `json:"quotaEffective"`
}

// HeartbeatRequest 每 15s 一次。节点自报负载，Hub 回下发取消与额度更新。
type HeartbeatRequest struct {
	NodeID string      `json:"-"`
	Lanes  []LaneInput `json:"lanes"`
}

type LaneInput struct {
	CID             string            `json:"cid"`
	Inflight        int               `json:"inflight"`
	Queued          int               `json:"queued"`
	QuotaLeft       contract.Metering `json:"quotaLeft"`
	ThrottledUntil  *time.Time        `json:"throttledUntil"`
	UpstreamOK      *bool             `json:"upstreamOK"`
	Paused          *bool             `json:"paused"`
	CachedArtifacts []string          `json:"cachedArtifacts"`
}

type HeartbeatResult struct {
	Cancel      []string                     `json:"cancel"`
	Drain       []string                     `json:"drain"`
	QuotaUpdate map[string]contract.Metering `json:"quotaUpdate"`
	ServerTime  int64                        `json:"serverTime"`
}

// ---------- 节点：领活与回传 ----------

type NextRequest struct {
	NodeID      string     `json:"-"`
	Lanes       []NextLane `json:"lanes"`
	WaitSeconds int        `json:"-"`
}

type NextLane struct {
	CID  string `json:"cid"`
	Free int    `json:"free"`
}

type NextResult struct {
	Unit      map[string]any `json:"unit"`
	Lease     LeaseView      `json:"lease"`
	StreamURL string         `json:"streamURL"`
	Cancel    []string       `json:"cancel"`
}

type LeaseView struct {
	Token     string `json:"token"`
	ExpiresAt int64  `json:"expiresAt"`
	RenewSec  int    `json:"renewSec"`
}

type ProgressRequest struct {
	NodeID   string         `json:"-"`
	UnitID   string         `json:"-"`
	Lease    string         `json:"lease"`
	Seq      int            `json:"seq"`
	Progress map[string]any `json:"progress"`
	Renew    bool           `json:"renew"`
}

type ProgressResult struct {
	CancelRequested bool      `json:"cancelRequested"`
	Lease           LeaseView `json:"lease"`
}

// CompleteRequest 终态。Hub 以自己解析到的 usage 结算，节点自报只用于对账（S-04）。
type CompleteRequest struct {
	NodeID        string                `json:"-"`
	UnitID        string                `json:"-"`
	Lease         string                `json:"lease"`
	State         string                `json:"state"`
	Error         *contract.UnitError   `json:"error"`
	Outputs       []contract.Payload    `json:"outputs"`
	Usage         contract.Metering     `json:"usage"`
	ContextDelta  map[string]any        `json:"contextDelta"`
	WorkspaceRef  map[string]any        `json:"workspaceRef"`
	CheckpointRef *contract.ArtifactRef `json:"checkpointRef"`
	MS            int64                 `json:"ms"`
}

type CompleteResult struct {
	Settled contract.Metering `json:"settled"`
}

// ---------- 消费者：密钥 ----------

// IssueKeyRequest 签发算力密钥。P0 由后台为内测用户签发（C-10）。
// 数据告知的确认是硬前置：没有 NoticeVersion 就不签发（C-13）。
type IssueKeyRequest struct {
	OwnerUserID      string   `json:"ownerUserId" binding:"required"`
	Alias            string   `json:"alias"`
	AllowedKinds     []string `json:"allowedKinds"`
	AllowedProviders []string `json:"allowedProviders"`
	ModelTier        []string `json:"modelTier"`
	Concurrency      int      `json:"concurrency"`
	RPM              int      `json:"rpm"`
	TTLDays          int      `json:"ttlDays"`
	NoticeVersion    string   `json:"noticeVersion" binding:"required"`
	// Grants 初始额度余额，P0 由后台直接给内测额度。
	Grants contract.Metering `json:"grants"`
}

type IssuedKeyView struct {
	KeyID string `json:"keyId"`
	// Secret 明文只在签发这一次返回。
	Secret    string    `json:"secret"`
	Alias     string    `json:"alias"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// ConsumerKeyView 是 /v1/keys/me 的形状。绝不包含明文或哈希。
type ConsumerKeyView struct {
	KeyID            string            `json:"keyId"`
	Alias            string            `json:"alias"`
	Status           string            `json:"status"`
	AllowedKinds     []string          `json:"allowedKinds"`
	AllowedProviders []string          `json:"allowedProviders"`
	ModelTier        []string          `json:"modelTier"`
	Concurrency      int               `json:"concurrency"`
	RPM              int               `json:"rpm"`
	IssuedAt         time.Time         `json:"issuedAt"`
	ExpiresAt        time.Time         `json:"expiresAt"`
	FrozenUntil      *time.Time        `json:"frozenUntil,omitempty"`
	Balance          contract.Metering `json:"balance"`
}

// Caller 是一次消费者请求认定后的身份。适配器用它构造 WorkUnit。
type Caller struct {
	KeyID            string
	OwnerUserID      string
	Alias            string
	AllowedKinds     []string
	AllowedProviders []string
	ModelTier        []string
	Concurrency      int
	RPM              int
	ExpiresAt        time.Time
}

// ---------- 用量 ----------

type UsageQuery struct {
	ConsumerKey string `form:"-"`
	// ConsumerKeys 把统计限定在一组密钥内，由控制台按 owner 解析后填入。
	// 它和 ConsumerKey 一样不接受请求参数：请求里能指定的只有「看哪一把」，
	// 「有哪些把」永远由令牌决定。
	ConsumerKeys []string  `form:"-"`
	CID          string    `form:"cid"`
	Kind         string    `form:"kind"`
	From         time.Time `form:"-"`
	To           time.Time `form:"-"`
}

// UsageLine 一行扣费明细。input 与 output token 分行列出、按各自单价计算（验收标准）。
type UsageLine struct {
	Kind string `json:"kind"`
	Unit string `json:"unit"`
	// Amount 该单位的累计量；Calls 是产生它的请求数。
	Amount int64 `json:"amount"`
	Calls  int64 `json:"calls"`
	// UnitPrice 每百万单位价格（微分）；Cost 是按它算出的金额（微分）。
	UnitPrice int64 `json:"unitPrice"`
	Cost      int64 `json:"cost"`
}

type UsageReport struct {
	From     time.Time   `json:"from"`
	To       time.Time   `json:"to"`
	Lines    []UsageLine `json:"lines"`
	TotalFee int64       `json:"totalFee"`
	Currency string      `json:"currency"`
}

// ---------- 提供者视图 ----------

type ContributionView struct {
	CID             string            `json:"cid"`
	NodeID          string            `json:"nodeId"`
	Kind            string            `json:"kind"`
	KindVersion     int               `json:"kindVersion"`
	Provider        string            `json:"provider"`
	ModelsAllow     []string          `json:"modelsAllow"`
	ModelsDeny      []string          `json:"modelsDeny"`
	Seats           int               `json:"seats"`
	SeatConcurrency int               `json:"seatConcurrency"`
	Status          string            `json:"status"`
	Reputation      float64           `json:"reputation"`
	Online          bool              `json:"online"`
	SeatsUsed       int               `json:"seatsUsed"`
	SeatsEffective  int               `json:"seatsEffective"`
	Inflight        int               `json:"inflight"`
	Quota           []QuotaStatusView `json:"quota"`
	Schedule        []ScheduleInput   `json:"schedule"`
	ThrottledUntil  *time.Time        `json:"throttledUntil,omitempty"`
}

type QuotaStatusView struct {
	Unit      string  `json:"unit"`
	Limit     int64   `json:"limit"`
	Used      int64   `json:"used"`
	Reserved  int64   `json:"reserved"`
	Left      int64   `json:"left"`
	Window    string  `json:"window"`
	WindowKey string  `json:"windowKey"`
	Ratio     float64 `json:"ratio"`
	Warned    bool    `json:"warned"`
}

type NodeView struct {
	NodeID        string             `json:"nodeId"`
	DisplayName   string             `json:"displayName"`
	BridgeVersion string             `json:"bridgeVersion"`
	Status        string             `json:"status"`
	Banned        bool               `json:"banned"`
	LastBeatAt    *time.Time         `json:"lastBeatAt,omitempty"`
	Contributions []ContributionView `json:"contributions"`
}

// ExecutionRecord 是「我的机器上跑过什么」的匿名化日志（P-14）：
// 只有 kind、时间、用量、结果，没有消费者内容也没有消费者身份。
type ExecutionRecord struct {
	UnitID     string            `json:"unitId"`
	Kind       string            `json:"kind"`
	Model      string            `json:"model"`
	State      string            `json:"state"`
	ErrorCode  string            `json:"errorCode,omitempty"`
	Usage      contract.Metering `json:"usage"`
	StartedAt  *time.Time        `json:"startedAt,omitempty"`
	FinishedAt *time.Time        `json:"finishedAt,omitempty"`
}

// ---------- 池水位 ----------

type PoolStatus struct {
	Lanes []LaneStatus `json:"lanes"`
}

type LaneStatus struct {
	Kind           string `json:"kind"`
	Provider       string `json:"provider"`
	Contributions  int    `json:"contributions"`
	Online         int    `json:"online"`
	SeatsTotal     int    `json:"seatsTotal"`
	SeatsUsed      int    `json:"seatsUsed"`
	SeatsEffective int    `json:"seatsEffective"`
	Inflight       int    `json:"inflight"`
	Draining       int    `json:"draining"`
	Throttled      int    `json:"throttled"`
	WaitQueueDepth int    `json:"waitQueueDepth"`
}

// ---------- 额度商品与订单（P1） ----------

// PackageView 一份额度商品。
type PackageView struct {
	PackageCode  string            `json:"packageCode"`
	Title        string            `json:"title"`
	Units        contract.Metering `json:"units"`
	Amount       int64             `json:"amount"`
	Currency     string            `json:"currency"`
	TTLDays      int               `json:"ttlDays"`
	AllowedKinds []string          `json:"allowedKinds,omitempty"`
	ModelTier    []string          `json:"modelTier,omitempty"`
	Concurrency  int               `json:"concurrency"`
	RPM          int               `json:"rpm"`
	// Listed / SortOrder 只对运营有意义：消费者那条接口固定 listedOnly=true，
	// 拿到的 Listed 永远是 true。运营目录要看得见下架的，也要在改一个字段时
	// 把其余字段原样带回去 —— SavePackage 是整行覆盖，不带回来就等于清零。
	Listed    bool `json:"listed"`
	SortOrder int  `json:"sortOrder"`
}

// SavePackageRequest 运营维护商品目录。
type SavePackageRequest struct {
	PackageCode  string            `json:"packageCode" binding:"required"`
	Title        string            `json:"title" binding:"required"`
	Units        contract.Metering `json:"units" binding:"required"`
	Amount       int64             `json:"amount"`
	Currency     string            `json:"currency"`
	TTLDays      int               `json:"ttlDays"`
	AllowedKinds []string          `json:"allowedKinds"`
	ModelTier    []string          `json:"modelTier"`
	Concurrency  int               `json:"concurrency"`
	RPM          int               `json:"rpm"`
	Listed       *bool             `json:"listed"`
	SortOrder    int               `json:"sortOrder"`
}

// CreateOrderRequest 下单。TargetKeyID 非空表示给已有密钥充值，
// 空表示支付成功后签发一把新密钥。
type CreateOrderRequest struct {
	UserID      string `json:"-"`
	PackageCode string `json:"packageCode" binding:"required"`
	TargetKeyID string `json:"targetKeyId"`
	// NoticeVersion 只在要签发新密钥时必填：数据告知的确认是签发的硬前置（C-13）。
	NoticeVersion string `json:"noticeVersion"`
}

type OrderView struct {
	OrderID     string            `json:"orderId"`
	PackageCode string            `json:"packageCode"`
	Units       contract.Metering `json:"units"`
	Amount      int64             `json:"amount"`
	Currency    string            `json:"currency"`
	Status      string            `json:"status"`
	TargetKeyID string            `json:"targetKeyId,omitempty"`
	KeyID       string            `json:"keyId,omitempty"`
	PaidAt      *time.Time        `json:"paidAt,omitempty"`
	FulfilledAt *time.Time        `json:"fulfilledAt,omitempty"`
	CreatedTime time.Time         `json:"createdTime"`
	// IssuedSecret 只在履约签发出新密钥的那一次返回，之后永远查不到。
	IssuedSecret string `json:"issuedSecret,omitempty"`
}

// PayOrderRequest 支付回调。PaymentRef 是渠道流水号，同时充当幂等键。
type PayOrderRequest struct {
	OrderID    string `json:"orderId" binding:"required"`
	PaymentRef string `json:"paymentRef" binding:"required"`
}

// PaymentChannelView 一个可选支付渠道。Sandbox 必须一路透到界面上：
// 沙箱渠道点一下就算付了，混在真渠道里不标注，运营会以为钱进来了。
type PaymentChannelView struct {
	Code    string `json:"code"`
	Title   string `json:"title"`
	Sandbox bool   `json:"sandbox"`
}

// PaySandboxRequest 沙箱支付。UserID 由令牌解析，不接受请求体里的值 ——
// 它是「这单是不是你自己的」这道校验的唯一依据。
type PaySandboxRequest struct {
	UserID  string `json:"-"`
	OrderID string `json:"orderId" binding:"required"`
	Channel string `json:"channel"`
}

// RenewKeyRequest 续期换发：新密钥继承余额与允许范围，旧密钥进入冻结。
type RenewKeyRequest struct {
	OwnerUserID string `json:"-"`
	KeyID       string `json:"keyId" binding:"required"`
	TTLDays     int    `json:"ttlDays"`
}

// ---------- 会话与回合（session 原语，P1） ----------

type OpenSessionRequest struct {
	ConsumerKey string `json:"-"`
	Kind        string `json:"kind"`
	KindVersion int    `json:"kindVersion"`
	Provider    string `json:"provider"`
	// Space 是业务自己的空间；ProgramRef 是业务侧的项目标识。
	// 共享池不解读它们，只负责存下来供业务回查（O-02）。
	Space        string         `json:"space"`
	ProgramRef   string         `json:"programRef"`
	WorkspaceRef map[string]any `json:"workspaceRef"`
	ContextShema string         `json:"contextSchemaVersion"`
}

type SessionView struct {
	SID string `json:"sid"`
	// KeyID 是发起这个会话的算力密钥。控制台按人列表，一个人手里好几把密钥，
	// 不带这一列就看不出这条是哪把密钥花的钱。
	KeyID        string         `json:"keyId,omitempty"`
	Kind         string         `json:"kind"`
	KindVersion  int            `json:"kindVersion"`
	Provider     string         `json:"provider"`
	Space        string         `json:"space,omitempty"`
	ProgramRef   string         `json:"programRef,omitempty"`
	State        string         `json:"state"`
	LastSeq      int            `json:"lastSeq"`
	WorkspaceRef map[string]any `json:"workspaceRef,omitempty"`
	CreatedTime  time.Time      `json:"createdTime"`
	LastTurnAt   *time.Time     `json:"lastTurnAt,omitempty"`
	CloseReason  string         `json:"closeReason,omitempty"`
	// Migrated 为真表示这个会话换过节点。它意味着执行层上下文是重建出来的，
	// 不是原样接着跑的。
	Migrated bool `json:"migrated,omitempty"`
}

type CloseSessionRequest struct {
	SID         string `json:"sid"`
	ConsumerKey string `json:"-"`
	Reason      string `json:"reason"`
}

// BeginTurnRequest 占位一个回合。seq 由调用方给，Hub 用它做幂等。
type BeginTurnRequest struct {
	SID         string         `json:"sid"`
	Seq         int            `json:"seq"`
	ConsumerKey string         `json:"-"`
	Input       map[string]any `json:"input"`
}

// TurnPlan 是「这次该怎么派」的结论。
type TurnPlan struct {
	SID string `json:"sid"`
	Seq int    `json:"seq"`
	// Op 是 session 子类型：open 第一回合、turn 同节点续跑、resume 跨节点续接。
	Op string `json:"op"`
	// HardPin 非空表示钉在这个贡献上，不重新放置。
	HardPin string `json:"hardPin,omitempty"`
	// Existing 非空表示这个 seq 已经跑过了，直接把已有结果还给消费者，不重跑。
	Existing *TurnView `json:"existing,omitempty"`
	// Resume 跨节点续接要交给新节点的东西。
	Resume *ResumeContext `json:"resume,omitempty"`
}

// ResumeContext 跨节点续接的全部输入（设计文档 7.3）。
type ResumeContext struct {
	FromSeq      int            `json:"fromSeq"`
	WorkspaceRef map[string]any `json:"workspaceRef,omitempty"`
	Checkpoint   *CheckpointRef `json:"checkpoint,omitempty"`
	// Digest 是账本里 turn[0..n] 的摘要。checkpoint 用不了时靠它重建 thread，
	// 这条路径是有损的。
	Digest []TurnDigest `json:"digest,omitempty"`
	// WorkspaceLost 为真表示上一个节点未推送的改动已经丢了，续接提示必须明示（T-09）。
	WorkspaceLost bool `json:"workspaceLost,omitempty"`
}

type CheckpointRef struct {
	Provider   string               `json:"provider"`
	CLIVersion string               `json:"cliVersion"`
	Ref        contract.ArtifactRef `json:"ref"`
	Seq        int                  `json:"seq"`
}

type TurnDigest struct {
	Seq           int      `json:"seq"`
	OutputSummary string   `json:"outputSummary,omitempty"`
	ChangedFiles  []string `json:"changedFiles,omitempty"`
}

type TurnView struct {
	SID              string            `json:"sid"`
	Seq              int               `json:"seq"`
	UnitID           string            `json:"unitId,omitempty"`
	State            string            `json:"state"`
	OutputSummary    string            `json:"outputSummary,omitempty"`
	ToolCalls        []map[string]any  `json:"toolCalls,omitempty"`
	ChangedFiles     []string          `json:"changedFiles,omitempty"`
	Artifacts        []map[string]any  `json:"artifacts,omitempty"`
	Usage            contract.Metering `json:"usage,omitempty"`
	ExternalThreadID string            `json:"externalThreadId,omitempty"`
	WorkspaceLost    bool              `json:"workspaceLost,omitempty"`
	StartedAt        time.Time         `json:"startedAt"`
	EndedAt          *time.Time        `json:"endedAt,omitempty"`
}

// SessionContextView 是 GET …/context 的形状：业务层上下文的全部。
// 节点不在了这份东西仍然完整（T-08）。
type SessionContextView struct {
	Session SessionView `json:"session"`
	Turns   []TurnView  `json:"turns"`
}

// ContextDelta 是节点每个回合结束交上来的结构化增量（设计文档 7.2）。
type ContextDelta struct {
	Schema           string           `json:"schema"`
	Seq              int              `json:"seq"`
	OutputSummary    string           `json:"outputSummary"`
	ToolCalls        []map[string]any `json:"toolCalls"`
	ChangedFiles     []string         `json:"changedFiles"`
	Artifacts        []map[string]any `json:"artifacts"`
	ExternalThreadID string           `json:"externalThreadId"`
	WorkspaceLost    bool             `json:"workspaceLost"`
}

// ---------- 长任务（job 原语，P2） ----------

type JobProgress struct {
	Pct        int                   `json:"pct"`
	Stage      string                `json:"stage,omitempty"`
	PreviewRef *contract.ArtifactRef `json:"previewRef,omitempty"`
}

type JobView struct {
	JobID        string                 `json:"jobId"`
	KeyID        string                 `json:"keyId,omitempty"`
	Kind         string                 `json:"kind"`
	State        string                 `json:"state"`
	Attempt      int                    `json:"attempt"`
	Progress     *JobProgress           `json:"progress,omitempty"`
	Outputs      []contract.ArtifactRef `json:"outputs,omitempty"`
	Usage        contract.Metering      `json:"usage,omitempty"`
	ErrorCode    string                 `json:"errorCode,omitempty"`
	ErrorMessage string                 `json:"errorMessage,omitempty"`
	CreatedTime  time.Time              `json:"createdTime"`
	StartedAt    *time.Time             `json:"startedAt,omitempty"`
	FinishedAt   *time.Time             `json:"finishedAt,omitempty"`
}

// WorkloadQuery 控制台按「人」查会话与任务。
//
// OwnerUserID 是这组只读接口唯一的授权依据，由令牌决定，不接受请求体里的值。
// KeyID 可选，用来只看某一把密钥 —— 不在名下的 keyId 查出来是空，不是全部。
type WorkloadQuery struct {
	OwnerUserID string `json:"-"`
	KeyID       string `json:"keyId"`
	Kind        string `json:"kind"`
	State       string `json:"state"`
	Limit       int    `json:"limit"`
}

// SaveContributionLimitsRequest 主人在控制台改一条贡献的授权。
//
// 额度以 Hub 为权威（三维额度规则第 8 条）：这里改完之后，节点下一次 hello
// 拿到的 quotaEffective 就与它本地申报的不同，节点以 Hub 为准更新展示副本。
type SaveContributionLimitsRequest struct {
	OwnerUserID     string            `json:"-"`
	CID             string            `json:"cid" binding:"required"`
	ModelsAllow     []string          `json:"modelsAllow"`
	ModelsDeny      []string          `json:"modelsDeny"`
	Seats           int               `json:"seats"`
	SeatConcurrency int               `json:"seatConcurrency"`
	Quota           []QuotaGrantInput `json:"quota"`
	Schedule        []ScheduleInput   `json:"schedule"`
}

// ---------- 平台运营（manager 后台） ----------

// AdminNodeView 平台视角的节点。比提供者自己看到的多两样：主人是谁、能不能封。
type AdminNodeView struct {
	NodeView
	OwnerUserID string `json:"ownerUserId"`
}

// AuditProbeView 一次抽检的结果。只有签名与判定，没有请求内容 ——
// 原文在比对完成的那一刻就被清掉了。
type AuditProbeView struct {
	ProbeID    string     `json:"probeId"`
	CID        string     `json:"cid"`
	UnitID     string     `json:"unitId"`
	Family     string     `json:"family"`
	Model      string     `json:"model"`
	Similarity float64    `json:"similarity"`
	Verdict    string     `json:"verdict"`
	Detail     string     `json:"detail,omitempty"`
	CreatedAt  time.Time  `json:"createdAt"`
	CheckedAt  *time.Time `json:"checkedAt,omitempty"`
}

// BanNodeRequest 封禁一台机器。封禁不是暂停：它是平台单方面的处置，主人自己解不开。
type BanNodeRequest struct {
	NodeID string `json:"nodeId" binding:"required"`
	Banned bool   `json:"banned"`
	Reason string `json:"reason"`
}

// ---------- 争议工单（S-09） ----------

// FileDisputeRequest 消费者对一次执行提出申诉。
// OwnerUserID 由令牌决定，不接受请求体里的值。
type FileDisputeRequest struct {
	OwnerUserID string `json:"-"`
	UnitID      string `json:"unitId" binding:"required"`
	Reason      string `json:"reason" binding:"required"`
	Detail      string `json:"detail"`
}

type DisputeQuery struct {
	Status string `json:"status"`
	CID    string `json:"cid"`
	Limit  int    `json:"limit"`
}

// ResolveDisputeRequest 运营裁决。Status 取 reviewing（转入处理中）、
// upheld（支持申诉，走追回）、rejected（驳回）。
type ResolveDisputeRequest struct {
	DisputeID  string `json:"disputeId" binding:"required"`
	Status     string `json:"status" binding:"required"`
	Resolution string `json:"resolution"`
	HandledBy  string `json:"-"`
}

type DisputeView struct {
	DisputeID string `json:"disputeId"`
	UnitID    string `json:"unitId"`
	Attempt   int    `json:"attempt"`
	Kind      string `json:"kind"`
	KeyID     string `json:"keyId"`
	// CID 是执行这单的贡献。给运营用来定位提供者 —— 消费者那边这个字段
	// 只是个不透明的串，看不出对面是谁。
	CID            string            `json:"cid,omitempty"`
	Reason         string            `json:"reason"`
	Detail         string            `json:"detail,omitempty"`
	Status         string            `json:"status"`
	Resolution     string            `json:"resolution,omitempty"`
	Refund         contract.Metering `json:"refund,omitempty"`
	ClawbackAmount int64             `json:"clawbackAmount,omitempty"`
	HandledBy      string            `json:"handledBy,omitempty"`
	HandledAt      *time.Time        `json:"handledAt,omitempty"`
	CreatedTime    time.Time         `json:"createdTime"`
	UpdatedTime    time.Time         `json:"updatedTime"`
}
