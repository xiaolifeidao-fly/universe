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
	// PreviousNodeID 这台机器上一次配对拿到的 nodeId（节点从本地令牌文件里读）。
	// 给了就把那条旧记录退役，避免同一台机器每重配一次就多一个僵尸节点。
	// 可选：全新机器没有它；老版本节点也不会传。
	PreviousNodeID string `json:"previousNodeId"`
}

type PairResult struct {
	NodeID string `json:"nodeId"`
	// Token 明文只在这一次返回，Hub 只存 sha256。
	Token           string `json:"token"`
	HubInstanceHint string `json:"hubInstanceHint,omitempty"`
}

// ---------- 接入方式 ----------

const (
	// AccessModePoll 节点长轮询领活，Hub 永不主动连它。可视化客户端只支持这一种。
	AccessModePoll = "poll"
	// AccessModeExport 节点把自己暴露在公网上，Hub 拿 endpoint + secret 主动回连。
	// 只有单独部署的 rust bridge 走这条 —— 它要求一个稳定可达的入口，
	// 那是笔记本上的桌面客户端给不了的。
	AccessModeExport = "export"
)

// NormalizeAccessMode 只认这两个值，其余一律当 poll。
//
// 不认识就报错是更严的做法，但接入方式是**节点自己声明**的：一个拼错的字段
// 不该让一台机器完全连不上来。回落到 poll 是安全的那一侧 —— 最坏结果是
// 它比预期慢一点领到活，而不是根本不在池子里。
func NormalizeAccessMode(value string) string {
	if value == AccessModeExport {
		return AccessModeExport
	}
	return AccessModePoll
}

// ExportEndpointInput 是 export 节点声明的回连信息。
//
// 密钥由**节点**生成、注册时交给 Hub，不是 Hub 发给节点的：这串东西是
// 「访问我的钥匙」，该由被访问的一方来定。Hub 必须原样保存明文才能出示，
// 所以它绝不进任何对外视图与日志。
type ExportEndpointInput struct {
	// URL 公网基地址，形如 https://box.example.com:8788。Hub 在它后面接
	// /node/v1/execute 这类路径。必须是 http(s)，不接受带用户名密码的形式。
	URL string `json:"url"`
	// Secret 回连密钥。Hub 以 Bearer 出示，节点逐字节比对。
	Secret string `json:"secret"`
}

// RegisterRequest 用提供者接入密钥自助注册一台机器。
//
// 与 PairRequest 的分工：配对码给「人看着两块屏幕」的可视化客户端；
// 接入密钥给放在机房里、没人值守的机器 —— 它重启之后要能自己回来。
type RegisterRequest struct {
	// Key 是 gpk- 开头的接入密钥明文。
	Key           string `json:"key" binding:"required"`
	DisplayName   string `json:"displayName"`
	BridgeVersion string `json:"bridgeVersion"`
	Contract      int    `json:"contract"`
	// AccessMode poll / export。不填按 poll。
	AccessMode string `json:"accessMode"`
	// Endpoint 只有 AccessMode=export 时有意义，其余情况忽略。
	Endpoint *ExportEndpointInput `json:"endpoint"`
	// NodeID 是这台机器上一次注册拿到的 nodeId（从本地令牌文件里读）。
	//
	// 带了就**沿用同一条节点记录**、只换一把新令牌，不像配对那样每次新建 ——
	// 一台服务器可能每天重启几次，每次多一个僵尸节点是不可接受的。
	// Hub 会校验它属于同一个主人，不属于就当没传，退回新建。
	NodeID string `json:"nodeId"`
}

type RegisterResult struct {
	NodeID string `json:"nodeId"`
	// Token 明文只在这一次返回，Hub 只存 sha256。
	Token string `json:"token"`
	// AccessMode Hub 最终认定的接入方式。节点要以它为准 ——
	// export 声明不合法时 Hub 会回落成 poll，节点得知道自己该去长轮询。
	AccessMode string `json:"accessMode"`
	// HubURL 平台公布的节点接入地址，供节点核对自己连的是不是同一个地方。
	HubURL string `json:"hubUrl,omitempty"`
	// Notice 回落或降级时的一句人话，节点原样打进日志。
	Notice string `json:"notice,omitempty"`
}

// ---------- 提供者接入密钥 ----------

type IssueProviderKeyRequest struct {
	OwnerUserID string `json:"-"`
	Alias       string `json:"alias"`
	// ExpiresInDays 0 表示不过期。
	ExpiresInDays int `json:"expiresInDays"`
}

// ProviderKeyView 列表里的一把密钥。**不含明文**，明文只在签发那一次返回。
type ProviderKeyView struct {
	KeyID       string     `json:"keyId"`
	Alias       string     `json:"alias"`
	Status      string     `json:"status"`
	LastUsedAt  *time.Time `json:"lastUsedAt,omitempty"`
	LastNodeID  string     `json:"lastNodeId,omitempty"`
	ExpiresAt   *time.Time `json:"expiresAt,omitempty"`
	CreatedTime time.Time  `json:"createdTime"`
}

// IssuedProviderKey 签发结果。Secret 是唯一一次能看到明文的地方。
type IssuedProviderKey struct {
	ProviderKeyView
	Secret string `json:"secret"`
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
	// AvailableModels 上游现在有哪些模型，节点探测后上报，控制台拿它当候选项。
	// 刻意不叫 models：上面那个 Models 是 {allow,deny} 对象，同名会让反序列化直接失败。
	AvailableModels []string `json:"availableModels"`
	// Available / UnavailableReason 是节点探测到的事实：这台机器现在能不能干这件事。
	// 它和「主人愿不愿意共享」是两回事 —— 后者由控制台定，节点无权表态。
	// 不可用的原因要写成人话，它会原样显示给主人（「请运行 claude auth login」）。
	Available         *bool  `json:"available"`
	UnavailableReason string `json:"unavailableReason"`
}

// EnabledContribution 是 Hub 下发给节点的**生效配置**：主人在控制台开着、
// 且节点报了可用的那些能力，连同额度、座位、模型范围和挂机时段。
//
// 节点按它建通道。本机配置文件不再决定共享什么 —— 那是主人在控制台的事，
// 「随时随地能调」这条要求就落在这里：改完下一次心跳（≤15s）节点就换过来了。
type EnabledContribution struct {
	CID             string            `json:"cid"`
	Kind            string            `json:"kind"`
	KindVersion     int               `json:"kindVersion"`
	Provider        string            `json:"provider"`
	ModelsAllow     []string          `json:"modelsAllow"`
	ModelsDeny      []string          `json:"modelsDeny"`
	Seats           int               `json:"seats"`
	SeatConcurrency int               `json:"seatConcurrency"`
	Quota           []QuotaGrantInput `json:"quota"`
	Schedule        []ScheduleInput   `json:"schedule"`
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
	// AccessMode / Endpoint 每次 hello 都带，不只在注册时给一次。
	//
	// 公网地址会变：家宽的 IP 每天换、容器换一次宿主端口就换。只在注册时记一次，
	// Hub 会拿着一个早就失效的地址一直回连不上，而节点侧一切正常 ——
	// 这种「两边都觉得自己没错」的状态是最难查的。让 hello 顺手把它对齐掉。
	//
	// 空字符串表示「这一版节点不声明」，Hub 维持现状；要清空得显式改成 poll。
	AccessMode string               `json:"accessMode"`
	Endpoint   *ExportEndpointInput `json:"endpoint"`
	// MachineFingerprint 设备指纹：sha256(命名空间 + 系统的机器 id) 的十六进制，64 位小写。
	// 工作室的信誉按它记，同一台机器解绑重配、换账号再配都不清零。散户的节点也报，照样记下。
	//
	// 只在 hello 里带，配对和注册不带：节点拿到令牌之后第一件事就是 hello，而贡献要到
	// hello 才进池子，在那之前不可能被扣分。升级前就配好对的节点也靠这里补上。
	// 已经记下的指纹不会被改；老版本节点不传，Hub 退回按节点记。
	MachineFingerprint string `json:"machineFingerprint"`
	// Platform / Distribution / UpgradeBlocker 是这台机器上的 ai-bridge 自报的身份：
	// 装的是哪个平台的包（linux-x64…）、怎么分发来的（cli 独立部署 / nova 随应用），
	// 以及此刻为什么不能远程升级（目录不可写、没有内置发布公钥……，空串表示可以）。
	//
	// 每次 hello 都带而不是只在注册时报一次：它们会变 —— 安装目录的权限被改过、
	// 换了一份没有公钥的自编译包。只记一次的话，控制台上的升级按钮会按一份旧事实亮着。
	Platform       string `json:"platform"`
	Distribution   string `json:"distribution"`
	UpgradeBlocker string `json:"upgradeBlocker"`
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
	// Enabled 是节点这一刻该跑的全部通道。空数组表示一条都不该跑（全被关了或全不可用），
	// 这和「字段缺失」必须分得开 —— 后者是老版本 Hub，节点应当维持现状而不是全停。
	Enabled []EnabledContribution `json:"enabled"`
	// AccessMode Hub 最终认定的接入方式。
	//
	// 节点声明了 export、但回连信息在 Hub 这边不成立时会被回落成 poll。
	// 不把结论告诉节点，它就只开着一扇 Hub 永远不会来敲的门，一条活都收不到。
	AccessMode string `json:"accessMode,omitempty"`
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
	// HubURL 是平台公布的节点接入地址，供 bridge 自行校验本地配置。
	HubURL      string                       `json:"hubUrl,omitempty"`
	Cancel      []string                     `json:"cancel"`
	Drain       []string                     `json:"drain"`
	QuotaUpdate map[string]contract.Metering `json:"quotaUpdate"`
	ServerTime  int64                        `json:"serverTime"`
	// Enabled 和 hello 里那个是同一份东西，搭在心跳上下发。
	// 主人在控制台开关一条贡献、改额度或改时段，节点最迟一个心跳周期就换过来 ——
	// 「随时随地能调」靠的就是这一条，不需要主人回到那台机器上做任何事。
	Enabled []EnabledContribution `json:"enabled"`
	// Upgrade 待执行的升级指令，搭的是同一条路（控制台点完最多等一个心跳）。
	//
	// 没有指令时整个字段省略，**不能发 null**：节点侧的 serde 遇上显式 null 会让
	// 整个响应解析失败，那次心跳里的取消、排空、生效配置会一起丢掉。
	Upgrade *NodeUpgradeCommand `json:"upgrade,omitempty"`
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
	// ModelID 来源套餐绑定的模型，只用来认类别与展示。
	ModelID string `json:"modelId"`
}

type IssuedKeyView struct {
	KeyID string `json:"keyId"`
	// Secret 明文只在签发这一次返回。
	Secret    string    `json:"secret"`
	Alias     string    `json:"alias"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// ConsumerKeyView 是 /v1/keys/me 的形状。绝不包含明文或哈希 —— 明文要单独走取回接口。
type ConsumerKeyView struct {
	KeyID  string `json:"keyId"`
	Alias  string `json:"alias"`
	Status string `json:"status"`
	// Category 这把密钥该接到哪个客户端：claude / codex / video / other。
	// other 表示范围不限，Claude Code 和 Codex 都能接。
	Category string `json:"category"`
	ModelID  string `json:"modelId,omitempty"`
	// Revealable 服务端能不能取回明文。老密钥只存了哈希，要换发一次才行。
	Revealable       bool              `json:"revealable"`
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
	// Provider 是这笔用量走的上游（claude_oauth / codex_chatgpt 等）。
	// 同一个 kind 下 Claude 与 Codex 分行列出：账单要能看出钱花在哪个上游。
	Provider string `json:"provider"`
	Unit     string `json:"unit"`
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
	CID         string   `json:"cid"`
	NodeID      string   `json:"nodeId"`
	Kind        string   `json:"kind"`
	KindVersion int      `json:"kindVersion"`
	Provider    string   `json:"provider"`
	ModelsAllow []string `json:"modelsAllow"`
	ModelsDeny  []string `json:"modelsDeny"`
	// 节点报的上游可用模型。给控制台当候选项，不参与任何调度判定。
	AvailableModels []string          `json:"availableModels"`
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
	// Available / UnavailableReason 是节点报的「这台机器现在能不能干」，
	// 和 Status（主人愿不愿意共享）是两回事，界面上要分开显示：
	// 一个是「你关掉了」，另一个是「你的 Claude 登录态过期了」，处置方式完全不同。
	Available         bool   `json:"available"`
	UnavailableReason string `json:"unavailableReason,omitempty"`
	// SeatsBound 有多少消费者绑在这条贡献上。大于 0 时不允许下线。
	SeatsBound int `json:"seatsBound"`
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
	NodeID        string     `json:"nodeId"`
	DisplayName   string     `json:"displayName"`
	BridgeVersion string     `json:"bridgeVersion"`
	Status        string     `json:"status"`
	Banned        bool       `json:"banned"`
	LastBeatAt    *time.Time `json:"lastBeatAt,omitempty"`
	// AccessMode 这台机器怎么接进来的：poll 长轮询 / export Hub 回连。
	// 界面上要显示出来 —— 两种接入方式的排障路径完全不同，
	// 而主人自己往往说不清机房里那台是怎么配的。
	AccessMode string `json:"accessMode"`
	// EndpointURL export 机器的公网入口。**不含密钥**。
	EndpointURL string `json:"endpointUrl,omitempty"`
	// EndpointStatus 最近一次回连探测：ok / unreachable，没探过是空串。
	//
	// 它和 Status 是两件事：心跳是节点主动出站的，公网入口不通照样能心跳。
	// 分开显示，主人才看得出「进程活着，但你的端口没映射对」。
	EndpointStatus    string             `json:"endpointStatus,omitempty"`
	EndpointError     string             `json:"endpointError,omitempty"`
	EndpointCheckedAt *time.Time         `json:"endpointCheckedAt,omitempty"`
	Contributions     []ContributionView `json:"contributions"`

	// 下面几项是「这台机器上的 ai-bridge」：装的是什么、能不能一键升级、升到哪儿了。
	// 老版本节点报不上来，Platform / Distribution 是空串 —— 界面据此说「版本太旧」。
	Platform     string `json:"platform"`
	Distribution string `json:"distribution"`
	// UpgradeBlocker 节点自报的「此刻升不了的原因」，人话，直接显示在按钮旁边。
	UpgradeBlocker string `json:"upgradeBlocker"`
	// LatestVersion 这个平台当前最新的已发布版本；没有包时是空串。
	LatestVersion string `json:"latestVersion"`
	// UpgradeAvailable 有没有更新的版本可升。它只看版本与分发方式，
	// **不看在不在线**：一台关着的机器也该显示「有新版本」，只是点不动。
	UpgradeAvailable bool `json:"upgradeAvailable"`
	// Upgrade 最近一次升级。从没升级过就没有这个字段。
	Upgrade *NodeUpgradeView `json:"upgrade,omitempty"`
}

// ExecutionRecord 是「我的机器上跑过什么」的匿名化日志（P-14）：
// 只有 kind、时间、用量、结果，没有消费者内容也没有消费者身份。
type ExecutionRecord struct {
	UnitID    string            `json:"unitId"`
	Kind      string            `json:"kind"`
	Model     string            `json:"model"`
	State     string            `json:"state"`
	ErrorCode string            `json:"errorCode,omitempty"`
	Usage     contract.Metering `json:"usage"`
	// Credits 这一次给主人记了多少积分。失败不计费的那些是 0。
	// 它来自账本而不是用量乘单价 —— 分成比例改过之后，重算出来的和账上的对不上。
	Credits    int64      `json:"credits"`
	StartedAt  *time.Time `json:"startedAt,omitempty"`
	FinishedAt *time.Time `json:"finishedAt,omitempty"`
	// NodeID / NodeName 这一次是主人的哪台机器跑的，NodeName 是主人给机器起的名字。
	// 机器解绑了也照样给，老记录不会变成一串 id。只回给主人自己，消费者的记录里没有。
	NodeID   string `json:"nodeId,omitempty"`
	NodeName string `json:"nodeName,omitempty"`
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
	// ModelID 绑定的模型，空表示通用套餐。分享返现按这个模型的比例算。
	ModelID string `json:"modelId,omitempty"`
	// Category 是商品归属（claude / codex / video / other），由 kind 与模型档推出来。
	// 派生规则放服务端：控制台按它分栏，两个端各写一份匹配规则的话，
	// 同一个额度包会在 Nova 和 Orbit 上落进不同的栏。
	Category string `json:"category"`
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
	// ModelID 绑定到模型目录里的哪个模型，留空为通用套餐。填了就必须在目录里存在。
	ModelID   string `json:"modelId"`
	Listed    *bool  `json:"listed"`
	SortOrder int    `json:"sortOrder"`
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
	// PayMethod points=积分；channel=支付渠道。老订单是空串，按 channel 看。
	PayMethod   string     `json:"payMethod,omitempty"`
	ModelID     string     `json:"modelId,omitempty"`
	TargetKeyID string     `json:"targetKeyId,omitempty"`
	KeyID       string     `json:"keyId,omitempty"`
	PaidAt      *time.Time `json:"paidAt,omitempty"`
	FulfilledAt *time.Time `json:"fulfilledAt,omitempty"`
	CreatedTime time.Time  `json:"createdTime"`
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
	OwnerUserID string `json:"-"`
	// NodeID 用来消歧：cid 是去掉节点前缀的短名，多台机器上会重名。
	NodeID          string            `json:"nodeId"`
	CID             string            `json:"cid" binding:"required"`
	ModelsAllow     []string          `json:"modelsAllow"`
	ModelsDeny      []string          `json:"modelsDeny"`
	Seats           int               `json:"seats"`
	SeatConcurrency int               `json:"seatConcurrency"`
	Quota           []QuotaGrantInput `json:"quota"`
	Schedule        []ScheduleInput   `json:"schedule"`
}

// ---------- 平台运营（manager 后台） ----------

// 提供者身份。注册出来默认是散户，只有管理端能设成工作室。
//
// 两者只差信誉跟着谁走：散户跟着账号（名下几台机器共用一份分数），
// 工作室跟着设备（按设备指纹，每台机器各算各的，换账号配也还是那份）。
const (
	ProviderIndividual = "individual"
	ProviderStudio     = "studio"
)

// AdminNodeView 平台视角的节点。比提供者自己看到的多三样：主人是谁、主人是散户还是工作室、能不能封。
type AdminNodeView struct {
	NodeView
	OwnerUserID string `json:"ownerUserId"`
	// OwnerName 主人的共享端账号「昵称（用户名）」。账号查不到（比如迁移前的老数据）时是空串，界面退回显示 id。
	OwnerName string `json:"ownerName"`
	// ProviderType 主人的身份，individual / studio。这台机器贡献上的信誉按它读账号或设备那一份。
	ProviderType string `json:"providerType"`
}

// SetProviderTypeRequest 管理端改一个账号的身份。改的是账号，名下所有机器一起变。
type SetProviderTypeRequest struct {
	OwnerUserID  string `json:"ownerUserId" binding:"required"`
	ProviderType string `json:"providerType" binding:"required"`
	// UpdatedBy 由接口层从凭证里取，请求体里报的不算数。
	UpdatedBy string `json:"-"`
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
// 报过设备指纹的节点封的是那台设备，同一台设备上的其他节点记录一起封、一起解。
type BanNodeRequest struct {
	NodeID string `json:"nodeId" binding:"required"`
	Banned bool   `json:"banned"`
	Reason string `json:"reason"`
	// UpdatedBy 由接口层从凭证里取，请求体里报的不算数。
	UpdatedBy string `json:"-"`
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

// ---------- 提供者：今天与收益 ----------

// ProviderDashboard 是「今天」这一页要的全部数字，一次查完。
//
// 拆成四五个接口让前端并发拉是另一种做法，但这一页的数字互相解释：
// 「今天赚了 1,284」和「今天跑了 316 次」必须是同一个时刻的口径，
// 分开取会在跨零点或结算落后时给出对不上的两半。
type ProviderDashboard struct {
	// 有没有机器、在不在共享，决定这一页显示仪表盘还是引导配对。
	Nodes  int  `json:"nodes"`
	Online bool `json:"online"`
	// SharingSince 本轮连续在线的起点。节点掉线再上线会重新计。
	SharingSince *time.Time `json:"sharingSince,omitempty"`

	Credits   CreditSummary `json:"credits"`
	Today     DayStats      `json:"today"`
	Yesterday DayStats      `json:"yesterday"`
	// Trend 最近 7 天的积分，画小柱图用。缺的那天补 0，前端不用自己对齐日期。
	Trend []DailyPoint `json:"trend"`
}

// CreditSummary 积分的四个口径。可提现 + 待结算才是「已经赚到的」，
// 分开显示是因为待结算那部分要过 7 天争议期。
//
// 这里所有的数都是**微积分**：1,000,000 = 1 积分 = ¥1，和使用端那套积分同一个口径，
// 也和账本、单价同一量纲。界面按 ÷1,000,000 显示。
type CreditSummary struct {
	Available int64 `json:"available"`
	Pending   int64 `json:"pending"`
	Withdrawn int64 `json:"withdrawn"`
	Today     int64 `json:"today"`
	Week      int64 `json:"week"`
	Month     int64 `json:"month"`
	Total     int64 `json:"total"`
	// Referral 邀请奖励的累计净额（已扣掉申诉追回的那部分）。
	//
	// 它已经算在余额里了，单独给一格是因为上面那几个口径只统计**自己贡献算力**
	// 结算出来的积分 —— 邀请带来的那部分在里面一点都看不见。
	Referral int64 `json:"referral"`
}

// DayStats 一天的执行统计。用来回答「今天跑了多少、成功率如何」。
type DayStats struct {
	Calls   int64             `json:"calls"`
	Failed  int64             `json:"failed"`
	Usage   contract.Metering `json:"usage"`
	Credits int64             `json:"credits"`
	// AvgDurationMs 只统计有终态时间的单元，跑到一半的不算。
	AvgDurationMs int64 `json:"avgDurationMs"`
}

type DailyPoint struct {
	Date   string `json:"date"`
	Amount int64  `json:"amount"`
}

// LedgerQuery 积分账本的过滤条件。Type 是账本类型（settle/payout/clawback…），
// 空表示全部。
type LedgerQuery struct {
	OwnerUserID string `form:"-"`
	Type        string `form:"type"`
	Offset      int    `form:"offset"`
	Limit       int    `form:"limit"`
}

// CreditLedgerEntry 账本上的一行。
type CreditLedgerEntry struct {
	Type   string `json:"type"`
	Amount int64  `json:"amount"`
	Unit   string `json:"unit,omitempty"`
	UnitID string `json:"unitId,omitempty"`
	// CID 对主人是可读的（那是他自己的机器），和给消费者看的争议视图不一样。
	CID       string    `json:"cid,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

type CreditLedgerPage struct {
	Total   int64               `json:"total"`
	Entries []CreditLedgerEntry `json:"entries"`
}

// ProviderRecordQuery 执行记录的过滤条件。
//
// CID 是去掉节点前缀的短名，和界面上显示的一致；服务端自己扩回全局 id。
type ProviderRecordQuery struct {
	OwnerUserID string    `form:"-"`
	CID         string    `form:"cid"`
	Model       string    `form:"model"`
	State       string    `form:"state"`
	From        time.Time `form:"-"`
	To          time.Time `form:"-"`
	Offset      int       `form:"offset"`
	Limit       int       `form:"limit"`
}

// ProviderRecordPage 一页执行记录 + 这个过滤条件下的整体统计。
//
// 统计跟着分页一起返回而不是单独一个接口：它统计的是**当前筛选条件**下的全部，
// 不是当前这一页。分成两个接口，两边的筛选条件迟早会不一致。
type ProviderRecordPage struct {
	Total   int64             `json:"total"`
	Records []ExecutionRecord `json:"records"`
	Stats   DayStats          `json:"stats"`
	// Models 是这个人机器上出现过的模型，供筛选下拉用。
	Models []string `json:"models"`
}

// PayoutView 一次提现申请。Account 已打码，原样的收款账号不回给前端。
type PayoutView struct {
	PayoutID    string     `json:"payoutId"`
	Credits     int64      `json:"credits"`
	Amount      int64      `json:"amount"`
	Currency    string     `json:"currency"`
	Fee         int64      `json:"fee"`
	Method      string     `json:"method"`
	Account     string     `json:"account"`
	Status      string     `json:"status"`
	Note        string     `json:"note,omitempty"`
	HandledAt   *time.Time `json:"handledAt,omitempty"`
	CreatedTime time.Time  `json:"createdTime"`
}

// CreatePayoutRequest 发起提现。
type CreatePayoutRequest struct {
	OwnerUserID string `json:"-"`
	// Credits 提现金额，单位是**微积分**（1,000,000 = 1 积分 = ¥1），
	// 和余额、账本同一量纲 —— 界面拿到的是什么单位，就原样提回来，中间不折算。
	// 服务端要求它不低于起提金额，且是整数积分。
	Credits int64  `json:"credits" binding:"required"`
	Method  string `json:"method" binding:"required"`
	Account string `json:"account" binding:"required"`
}

// ---------- 消费者：概览与逐笔记录 ----------

// ConsumerDashboard 是密钥页与使用记录页共用的那一排数字。
type ConsumerDashboard struct {
	Keys       int               `json:"keys"`
	ActiveKeys int               `json:"activeKeys"`
	Balance    contract.Metering `json:"balance"`
	Today      DayStats          `json:"today"`
	// SpentMicros 最近 N 天的花费（微分），Days 说明是几天。
	SpentMicros int64  `json:"spentMicros"`
	Days        int    `json:"days"`
	Currency    string `json:"currency"`
	// AvgFirstByteMs 首字延迟。排队 + 上游，端到端口径。
	AvgFirstByteMs int64 `json:"avgFirstByteMs"`
}

// UsageRecordQuery 逐笔用量的过滤条件。KeyID 只能收窄到自己名下的密钥。
type UsageRecordQuery struct {
	OwnerUserID string    `form:"-"`
	KeyID       string    `form:"keyId"`
	Kind        string    `form:"kind"`
	State       string    `form:"state"`
	From        time.Time `form:"-"`
	To          time.Time `form:"-"`
	Offset      int       `form:"offset"`
	Limit       int       `form:"limit"`
}

// UsageRecord 一次请求的扣费明细。
//
// 和 UsageLine 的区别是粒度：那个是「这段时间一共花了多少」，这个是「这一次花了多少」。
// 申诉钉的是 (unitId, attempt)，所以逐笔视图必须把 unitId 摆出来。
type UsageRecord struct {
	UnitID   string `json:"unitId"`
	KeyID    string `json:"keyId"`
	KeyAlias string `json:"keyAlias,omitempty"`
	Kind     string `json:"kind"`
	Provider string `json:"provider,omitempty"`
	Model    string `json:"model,omitempty"`
	State    string `json:"state"`
	Attempt  int    `json:"attempt"`

	ErrorCode string            `json:"errorCode,omitempty"`
	Usage     contract.Metering `json:"usage"`
	// Cost 这一次的扣费（微分）。失败不计费的那些是 0。
	Cost       int64      `json:"cost"`
	Currency   string     `json:"currency"`
	StartedAt  *time.Time `json:"startedAt,omitempty"`
	FinishedAt *time.Time `json:"finishedAt,omitempty"`
	// DurationMs 端到端耗时，没跑完的是 0。
	DurationMs int64 `json:"durationMs"`
}

type UsageRecordPage struct {
	Total   int64         `json:"total"`
	Records []UsageRecord `json:"records"`
}

// ---------- 门户（未登录可见的那一面） ----------

// PortalOverview 门户一次取回整站要展示的东西。
//
// 拆成四条接口没有意义：这四份数据都很小、都随运营改动一起变、都不带用户维度，
// 而门户的首页本来就要同时用到它们（价格滚动条要模型，CTA 要额度包）。
// 一次取回还顺带让「模型数」这类统计和列表天然一致 —— 分两条接口取，
// 中间被改一次目录就会出现「写着 12 个模型，列出来 11 个」。
type PortalOverview struct {
	// Endpoint 是消费者要填进 base_url 的那个地址，服务端给，门户不再配一遍。
	Endpoint  string             `json:"endpoint"`
	Stats     PortalStats        `json:"stats"`
	Families  []PortalFamilyView `json:"families"`
	Models    []PortalModelView  `json:"models"`
	Packages  []PackageView      `json:"packages"`
	Prices    []PortalPriceLine  `json:"prices"`
	UpdatedAt time.Time          `json:"updatedAt"`
}

// PortalStats 首页那排数字。
//
// 每一项都必须是库里真有的事实。像「5000+ 开发者」这种没有出处的数字不放进来 ——
// 门户上第一眼看到的数字如果是编的，后面写什么都不作数了。
type PortalStats struct {
	Models   int `json:"models"`
	Vendors  int `json:"vendors"`
	Families int `json:"families"`
	Packages int `json:"packages"`
	// MinTopup 上架额度包里最便宜的那个（微分）。0 表示一个包都没上架。
	MinTopup   int64  `json:"minTopup"`
	Currency   string `json:"currency"`
	MaxContext int64  `json:"maxContext"`
	// KeyTTLDays / FreezeDays 是密钥的默认有效期与到期后的冻结期，来自部署配置。
	KeyTTLDays  int `json:"keyTtlDays"`
	FreezeDays  int `json:"freezeDays"`
	Concurrency int `json:"concurrency"`
	RPM         int `json:"rpm"`
	// Availability 是部署方声明的可用性承诺（galaxy.portal.availability）。
	// 没配就是空串，门户少显示一格，不编一个。
	Availability string `json:"availability,omitempty"`
}

// PortalFamilyView 模型页的分栏。计数与最低价都由服务端算好 ——
// 门户算一遍、控制台再算一遍，迟早对不上。
type PortalFamilyView struct {
	Family   string `json:"family"`
	Vendor   string `json:"vendor,omitempty"`
	Count    int    `json:"count"`
	MinInput int64  `json:"minInput"`
	Currency string `json:"currency"`
}

// PortalModelView 门户上的一个模型。价格是「每百万 token 的微分」，与账单同口径。
type PortalModelView struct {
	ModelID         string   `json:"modelId"`
	DisplayName     string   `json:"displayName"`
	Vendor          string   `json:"vendor,omitempty"`
	Family          string   `json:"family"`
	Kind            string   `json:"kind"`
	ContextTokens   int64    `json:"contextTokens,omitempty"`
	MaxOutputTokens int64    `json:"maxOutputTokens,omitempty"`
	InputPrice      int64    `json:"inputPrice"`
	OutputPrice     int64    `json:"outputPrice"`
	CachePrice      int64    `json:"cachePrice"`
	Currency        string   `json:"currency"`
	Tags            []string `json:"tags,omitempty"`
	Summary         string   `json:"summary,omitempty"`
	Featured        bool     `json:"featured"`
	// Priced 说明这三个单价是这个模型自己的，还是回落到了 kind 的统一价。
	// 门户据此决定要不要在卡片上标「统一价」—— 不标的话，回落期间
	// 所有模型显示同一个价，看起来像是页面坏了。
	Priced    bool `json:"priced"`
	SortOrder int  `json:"sortOrder"`
	// ReferralBps / Listed 只有运营的目录接口会填：返现比例跟陌生人无关，
	// 门户那条公开接口本来就只列上架的。ReferralBps 为空表示走全局默认。
	ReferralBps *int64 `json:"referralBps,omitempty"`
	Listed      *bool  `json:"listed,omitempty"`
}

// PortalPriceLine kind × 单位的当前单价，定价页那张表直接渲染它。
// 分成比例不在这里 —— 那是平台与提供者之间的事，消费者面不需要知道。
type PortalPriceLine struct {
	Kind     string `json:"kind"`
	Unit     string `json:"unit"`
	Price    int64  `json:"price"`
	Currency string `json:"currency"`
}

// SubmitLeadRequest 门户「联系我们」。这是全站唯一未鉴权就能写库的入口，
// 所以每个字段都在服务端再截一次长度，前端的 maxlength 只算提示。
type SubmitLeadRequest struct {
	Name    string `json:"name"`
	Contact string `json:"contact" binding:"required"`
	Company string `json:"company"`
	Topic   string `json:"topic"`
	Scale   string `json:"scale"`
	Message string `json:"message"`
	Source  string `json:"source"`
	// Website 是蜜罐字段：真人看不见它，脚本会顺手填。非空直接当成功打发走，
	// 不写库也不报错 —— 报错等于告诉对方哪里被拦了。
	Website string `json:"website"`

	IP        string `json:"-"`
	UserAgent string `json:"-"`
}

// LeadView 提交成功后回给来访者的东西。只有一个单号 ——
// 库里那条记录的其余字段跟来访者无关。
type LeadView struct {
	LeadID    string    `json:"leadId"`
	CreatedAt time.Time `json:"createdAt"`
}

// SaveModelRequest 运营维护门户模型目录。整行覆盖，和 SavePackage 一个脾气：
// 只想改一个字段也要把其余字段原样带回来，不带回来就是清零。
type SaveModelRequest struct {
	ModelID         string   `json:"modelId" binding:"required"`
	DisplayName     string   `json:"displayName"`
	Vendor          string   `json:"vendor"`
	Family          string   `json:"family"`
	Kind            string   `json:"kind"`
	ContextTokens   int64    `json:"contextTokens"`
	MaxOutputTokens int64    `json:"maxOutputTokens"`
	InputPrice      int64    `json:"inputPrice"`
	OutputPrice     int64    `json:"outputPrice"`
	CachePrice      int64    `json:"cachePrice"`
	Currency        string   `json:"currency"`
	Tags            []string `json:"tags"`
	Summary         string   `json:"summary"`
	// ReferralBps 分享返现比例（万分之一），不传就是走全局默认。整行覆盖，所以编辑时要把原值带回来。
	ReferralBps *int64 `json:"referralBps"`
	Listed      *bool  `json:"listed"`
	Featured    bool   `json:"featured"`
	SortOrder   int    `json:"sortOrder"`
}

// LeadRecord 运营看到的线索。比 LeadView 多的是联系方式与正文 ——
// 那是这条记录存在的理由。IP 与 UA 只留在库里，不进这个视图。
type LeadRecord struct {
	LeadID      string     `json:"leadId"`
	Name        string     `json:"name,omitempty"`
	Contact     string     `json:"contact"`
	Company     string     `json:"company,omitempty"`
	Topic       string     `json:"topic,omitempty"`
	Scale       string     `json:"scale,omitempty"`
	Message     string     `json:"message,omitempty"`
	Source      string     `json:"source,omitempty"`
	Status      string     `json:"status"`
	HandledBy   string     `json:"handledBy,omitempty"`
	HandledAt   *time.Time `json:"handledAt,omitempty"`
	CreatedTime time.Time  `json:"createdTime"`
}

type LeadPage struct {
	Total int64        `json:"total"`
	Leads []LeadRecord `json:"leads"`
}

// HandleLeadRequest 运营把一条线索标成已处理 / 已关闭。
type HandleLeadRequest struct {
	LeadID    string `json:"leadId" binding:"required"`
	Status    string `json:"status" binding:"required"`
	HandledBy string `json:"-"`
}
