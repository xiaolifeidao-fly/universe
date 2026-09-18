package galaxy

import (
	"context"
	"time"

	"contract"
)

// service/galaxy 的对外依赖全部收在这一个文件里。领域包不认识 Redis、不认识 OSS、
// 不认识 gin —— 它只认这些接口，由 galaxy-api 的装配层注入实现。

// ---------- 支付渠道 ----------

// PaymentCallback 是支付渠道打回来的一次通知的原样内容。
//
// Body 必须是**未经解析的原始字节**：所有渠道的签名都覆盖原始报文，
// 反序列化再序列化一次，字段顺序和空白就变了，验签必然失败。
type PaymentCallback struct {
	Channel    string
	Headers    map[string]string
	Body       []byte
	ReceivedAt time.Time
}

// PaymentResult 是验签通过之后，渠道对这笔支付的认定。
// 金额与币种一定要带上：领域层要拿它和订单原价核对，
// 光有一个合法签名不代表付的是这个数。
type PaymentResult struct {
	OrderID    string
	PaymentRef string
	AmountPaid int64
	Currency   string
	// Paid 为假表示这条通知不是「支付成功」（关单、退款、状态查询回执等）。
	Paid bool
}

// PaymentVerifier 校验支付渠道回调的真实性。
//
// 领域层只认这个接口：支付宝的 RSA2、微信 V3 的 SHA256-RSA、Stripe 的 HMAC
// 各有各的签名法，但对共享池来说它们回答的是同一个问题 ——
// 「这条通知真是渠道发的吗，说的是哪一单、付了多少」。
//
// 没配 Verifier 时回调接口整体关闭：一个不验签的支付回调等于把发额度的
// 权限挂在公网上，任何人都能 POST 一个订单号把货提走。
//
// 多渠道由装配层的 payments.Registry 按 PaymentCallback.Channel 分发，
// 领域层看到的仍然只有这一个接口。
type PaymentVerifier interface {
	Verify(ctx context.Context, callback PaymentCallback) (PaymentResult, error)
}

// PaymentChannel 一个已接入渠道对外的样子。控制台按它渲染收银台。
type PaymentChannel struct {
	// Code 渠道码，同时是回调路径里的那一段：POST /galaxy/payments/{code}/callback。
	Code string
	// Title 给人看的名字。
	Title string
	// Sandbox 为真表示这个渠道不向任何外部收银台要钱 —— 本人点一下就算付成功。
	// 它必须一路标到界面上：把一个沙箱渠道混在真渠道里而不标注，
	// 运营会以为钱进来了。
	Sandbox bool
}

// PaymentDirectory 报告这套部署接了哪些渠道。
//
// 和 PaymentVerifier 分开而不是并成一个接口：验签是每条回调都要走的路，
// 列渠道是控制台偶尔一次的读。并在一起，只想接一种签名法的实现方
// 就得凭空编一个渠道清单出来。
//
// 装配层的实现可以两个都满足（payments.Registry 就是），领域层用类型断言取。
type PaymentDirectory interface {
	Channels() []PaymentChannel
}

// ---------- 控制面 ----------

// ScheduleWindow 挂机时段。时段外的贡献自动排空、不参与放置（P-07）。
type ScheduleWindow struct {
	From string `json:"from"`
	To   string `json:"to"`
	TZ   string `json:"tz,omitempty"`
}

// ContributionSnapshot 是放置算法唯一的候选来源：由 hello 建立、心跳维护，
// 存活在控制面里（Redis HASH `contrib:{cid}`）。MySQL 只留配置与对账快照。
type ContributionSnapshot struct {
	CID         string
	NodeID      string
	OwnerUserID string

	Kind        string
	KindVersion int
	Provider    string

	ModelsAllow []string
	ModelsDeny  []string

	Seats           int
	SeatConcurrency int

	// Inflight / SeatsUsed 由 Lua 在放置与结算时维护，心跳只作纠偏。
	Inflight  int
	SeatsUsed int

	// QuotaLimit 是 Hub 侧生效的授权上限（权威在 MySQL quota_grant）。
	// QuotaUsed / QuotaReserved 是当前窗口计数器，QuotaLeft = Limit − Used − Reserved。
	QuotaLimit    contract.Metering
	QuotaUsed     contract.Metering
	QuotaReserved contract.Metering

	Schedule []ScheduleWindow

	ThrottledUntil time.Time
	Draining       bool
	Paused         bool
	UpstreamOK     bool

	// Resources 是这台机器探测到的本机资源。job 的硬过滤要用它比对 kind 的资源需求：
	// 一台只剩 2GB 空间的机器接下一个要 20GB 的渲染任务，等于确定失败一次。
	Resources map[string]any

	Reputation float64
	P50TTFBMs  int

	LastBoundAt     time.Time
	LastBeatAt      time.Time
	CachedArtifacts []string
}

// Lane 贡献所属通道。
func (c ContributionSnapshot) Lane() string { return contract.Lane(c.Kind, c.Provider) }

// QuotaLeft 各单位剩余量。缺少授权行的单位视为不限量，返回时不出现。
func (c ContributionSnapshot) QuotaLeft() contract.Metering {
	left := make(contract.Metering, len(c.QuotaLimit))
	for unit, limit := range c.QuotaLimit {
		left[unit] = limit - c.QuotaUsed[unit] - c.QuotaReserved[unit]
	}
	return left
}

// Concurrency 贡献总并发上限：座位数 × 每座位并发。
func (c ContributionSnapshot) Concurrency() int {
	if c.Seats <= 0 || c.SeatConcurrency <= 0 {
		return 0
	}
	return c.Seats * c.SeatConcurrency
}

// NodeRuntime 节点在控制面里的存活状态。
type NodeRuntime struct {
	NodeID        string
	OwnerUserID   string
	BridgeVersion string
	Contract      int
	Resources     map[string]any
	Instance      string
	LastBeatAt    time.Time
}

// LaneRuntime 是心跳里节点自报的通道负载，用于纠偏与限流感知。
type LaneRuntime struct {
	CID             string
	Inflight        int
	Queued          int
	ThrottledUntil  time.Time
	UpstreamOK      bool
	Paused          bool
	CachedArtifacts []string
}

// PlaceCommand 是「原子绑定座位 + 预留额度 + 入队」这一步的全部输入。
// 过滤与打分在 placement.go 里做完，这里只剩不可分割的那几个写。
type PlaceCommand struct {
	RID         string
	CID         string
	ConsumerKey string
	Lane        string

	Estimate    contract.Metering
	QuotaLimits contract.Metering
	// WindowKeys 每个单位当前窗口的键，由 quota.go 按提供者时区算出。
	WindowKeys map[contract.MeterUnit]string
	// WindowExpiry 计数器过期时间：窗口末 + 1 天，留出对账余量。
	WindowExpiry map[contract.MeterUnit]time.Duration

	Seats           int
	SeatConcurrency int

	// ReuseBinding 为真时走 90% 路径：座位已经绑好，只需并发与额度两项校验。
	ReuseBinding bool
	BindTTL      time.Duration
	SeatTTL      time.Duration

	// Instance 持有消费者连接的 Hub 实例内网地址，节点上行直推它。
	Instance string
	Unit     []byte
	Body     []byte
	BodyTTL  time.Duration
	Deadline time.Time
}

// PlaceRejection 放置被拒的原因。它决定调用方是换一个贡献重试还是直接排队。
type PlaceRejection string

const (
	PlaceOK              PlaceRejection = ""
	PlaceSeatsFull       PlaceRejection = "seats_full"
	PlaceConcurrencyFull PlaceRejection = "concurrency_full"
	PlaceQuotaExceeded   PlaceRejection = "quota_exceeded"
	PlaceOffline         PlaceRejection = "offline"
)

type PlaceOutcome struct {
	Placed bool
	Reason PlaceRejection
	// Unit 单位名，仅 quota_exceeded 时有值，用于告诉主人是哪一维触顶。
	Unit contract.MeterUnit
}

// ClaimCommand 节点长轮询领活。只列出有空位的通道，Hub 只在这些队列上阻塞（T-03）。
type ClaimCommand struct {
	NodeID string
	CIDs   []string
	Wait   time.Duration
}

// ClaimedUnit 领到的一份工作。Body 是内联请求体，节点拿到即可直接转发上游。
type ClaimedUnit struct {
	RID      string
	CID      string
	Unit     []byte
	Body     []byte
	Instance string
	Deadline time.Time
}

// UnitRuntime 控制面里的单元运行态，供 stream / progress / complete 三个端点校验。
type UnitRuntime struct {
	RID         string
	ConsumerKey string
	Kind        string
	KindVersion int
	Provider    string
	Model       string
	SID         string
	CID         string
	Instance    string
	State       contract.UnitState
	Lease       string
	Estimate    contract.Metering
	// Envelope 是当初入队的那份工作单元 JSON。租约过期要重派时按它原样重放，
	// 不需要消费者再提交一次 —— job 的输入本来就自包含。
	Envelope []byte
	// HubUsage 是 Hub 自己从透传流里解析出的用量，节点 complete 之前就已写入。
	// 平台侧计量优先（S-04）：可信单位以它为准，节点自报只用于对账。
	HubUsage    contract.Metering
	PlacedAt    time.Time
	FirstByteAt time.Time
	Deadline    time.Time
	Attempt     int
}

// SettleCommand 终态回补：实际用量入账、预留回滚、并发与座位释放。
type SettleCommand struct {
	RID         string
	CID         string
	ConsumerKey string
	Estimate    contract.Metering
	Actual      contract.Metering
	WindowKeys  map[contract.MeterUnit]string
	// ReleaseSeat 为真时同时摘掉座位绑定：贡献被停、被摘除或消费者换绑时才用。
	ReleaseSeat bool
	Lane        string
	State       contract.UnitState
}

// ControlPlane 是共享池的控制面：唤醒队列、座位、绑定、额度计数器、取消标志。
// 它不承载响应字节与账目（约束 1、2）—— 字节在 Hub 进程内直传，账目在 MySQL。
type ControlPlane interface {
	RegisterNode(ctx context.Context, node NodeRuntime) error
	// TouchNode 心跳续期，返回该节点在控制面里还在不在。
	// 登记项过期时它不写任何东西 —— 心跳手上凑不出一条完整的登记项，
	// 重建要由调用方拿数据库的行来做。
	TouchNode(ctx context.Context, nodeID string, beatAt time.Time) (bool, error)
	DropNode(ctx context.Context, nodeID string) error

	// ReplaceContributions 是 hello 的语义：全量替换该节点的贡献集合。
	ReplaceContributions(ctx context.Context, nodeID string, snapshots []ContributionSnapshot) error
	UpdateLaneRuntime(ctx context.Context, runtimes []LaneRuntime) error
	SetDraining(ctx context.Context, cid string, draining bool) error
	// SetReputation 把 Hub 算好的机器信誉写进这些贡献的快照。只改已经在控制面里的。
	SetReputation(ctx context.Context, cids []string, reputation float64) error
	// SyncQuota 用当前窗口的计数器重算贡献的 used / left 并写回快照。
	// 窗口翻转后的自动恢复就发生在这里：新窗口计数器是空的，余量自然回到上限。
	SyncQuota(ctx context.Context, cid string, limits contract.Metering, windowKeys map[contract.MeterUnit]string) (used, reserved contract.Metering, err error)
	ListLaneContributions(ctx context.Context, lane string) ([]ContributionSnapshot, error)
	ListNodeContributions(ctx context.Context, nodeID string) ([]ContributionSnapshot, error)
	GetContribution(ctx context.Context, cid string) (ContributionSnapshot, bool, error)

	LookupBinding(ctx context.Context, consumerKey, lane string) (string, bool, error)
	ReleaseBinding(ctx context.Context, consumerKey, lane, cid string) error

	Place(ctx context.Context, command PlaceCommand) (PlaceOutcome, error)
	Claim(ctx context.Context, command ClaimCommand) (*ClaimedUnit, error)

	LoadUnit(ctx context.Context, rid string) (UnitRuntime, bool, error)
	MarkRunning(ctx context.Context, rid, lease string, at time.Time) error
	// LeaseExpired 报告某个单元的租约是不是已经过期。job 靠它触发 attempt+1 重派。
	LeaseExpired(ctx context.Context, rid string, grace time.Duration) (bool, error)
	MarkFirstByte(ctx context.Context, rid string, at time.Time) error
	// RecordHubUsage 由持有消费者连接的实例在流结束时写入。
	RecordHubUsage(ctx context.Context, rid string, usage contract.Metering) error
	// Settle 终态回补。返回 false 表示这个单元**之前就结过账了**（节点重发了一次
	// complete，或者两条收尾路径撞在一起）。调用方必须据此跳过计费 ——
	// 账本按 txn 幂等，但余额是加减：重放一次就是白发一笔钱。
	Settle(ctx context.Context, command SettleCommand) (bool, error)

	RequestCancel(ctx context.Context, rid, reason string) error
	CancelRequested(ctx context.Context, rid string) (bool, error)
	TakeNodeCancels(ctx context.Context, nodeID string) ([]string, error)

	// RememberResponse 记住 OpenAI Responses 的 id → 贡献映射：
	// previous_response_id 引用的是上游账号侧状态，后续请求必须回原节点（5.1 唯一硬约束）。
	RememberResponse(ctx context.Context, responseID, cid string, ttl time.Duration) error
	LookupResponse(ctx context.Context, responseID string) (string, bool, error)

	// BumpProbeBudget 抽检的每日配额计数。返回自增之后的值。
	BumpProbeBudget(ctx context.Context, cid, day string) (int64, error)

	// Healthy 报告控制面本身是否可用。不可用时拒绝新单但不丢账（非功能需求·可用性）。
	Healthy(ctx context.Context) error
}

// ---------- 产物 ----------

// ObjectSigner 产物签名。Hub 不搬字节，只签 URL（约束 3）。
type ObjectSigner interface {
	SignPut(ctx context.Context, key, contentType string, size int64, ttl time.Duration) (string, error)
	SignGet(ctx context.Context, key string, ttl time.Duration) (string, error)
}

// ObjectUploader 服务端直接写对象存储。**只给 ai-bridge 安装包用**。
//
// 它是「Hub 不经手字节」那条约束的唯一例外，而且理由和产物正好相反：安装包是
// 平台自己发布的东西，要在写进去之前算 sha256、验发布签名 —— 这两件事只有
// 经手字节的一方做得了。产物仍然走 presigned 直传，一个字节都不过服务端。
type ObjectUploader interface {
	// Put 返回的是**带部署前缀的完整对象键**，签下载地址时要用它。
	Put(ctx context.Context, objectKey, contentType string, content []byte, sha256 string) (string, error)
}

// ---------- 可观测 ----------

// Metrics 指标出口。领域包只描述「发生了什么、多久、多少」，
// 至于是 Prometheus 还是别的，由装配层决定。
//
// 三种语义分开而不是合成一个 Record：counter 只增、gauge 是当前值、
// histogram 要分桶。混成一个接口，实现方就只能靠命名约定去猜该怎么聚合。
type Metrics interface {
	Count(name string, labels map[string]string, delta float64)
	Gauge(name string, labels map[string]string, value float64)
	Observe(name string, labels map[string]string, value float64)
}

// 指标名（设计文档第 14 节）。
const (
	MetricPlaceLatency  = "galaxy_place_latency_ms"
	MetricPlaceRedisOps = "galaxy_place_redis_ops"
	MetricTTFB          = "galaxy_ttfb_ms"
	// MetricStreamGap 一次上行里最长的一段静默（毫秒）。
	// 它是 streamIdleTimeoutMs 该设多少的唯一依据 —— 那个阈值要盖住
	// 正常请求的静默上限，凭感觉拍一个数字，不是拍太松就是开始误杀慢上游。
	MetricStreamGap      = "galaxy_stream_gap_ms"
	MetricUnitTotal      = "galaxy_unit_total"
	MetricReassignTotal  = "galaxy_reassign_total"
	MetricSpillTotal     = "galaxy_spill_total"
	MetricLaneInflight   = "galaxy_lane_inflight"
	MetricLaneQuotaLeft  = "galaxy_lane_quota_left_ratio"
	MetricThrottledTotal = "galaxy_throttled_total"
	MetricUsageMismatch  = "galaxy_usage_mismatch_total"
	MetricWaitQueueDepth = "galaxy_wait_queue_depth"
	MetricAuditVerdict   = "galaxy_audit_verdict_total"

	// MetricAccessSyncFailed hello 对齐接入方式失败的次数。
	// 它不阻断 hello，所以没有这条指标就完全是静默的 —— 而它一旦持续发生，
	// 表现是一台 export 机器悄悄退回长轮询，谁都不知道为什么变慢了。
	MetricAccessSyncFailed = "galaxy_access_sync_failed_total"
	// MetricUnitResettled 收到重复终态、被结算闸门挡下的次数。
	// 正常应当接近 0；持续有量说明某条收尾路径在重发 complete。
	MetricUnitResettled = "galaxy_unit_resettled_total"
	// MetricNodeBridgeInfoFailed hello 记不下「机器装的是什么」的次数。
	// 它不阻断 hello：那几列只服务于展示与升级，坏了不该让整个池子的机器连不上。
	MetricNodeBridgeInfoFailed = "galaxy_node_bridge_info_failed_total"
	// MetricReferralSelfInvite 邀请奖励因为「同一台设备」被拦下的次数。
	// 拦下是正常风控，不是错误；盯着它能看出有没有人在批量刷小号。
	MetricReferralSelfInvite = "galaxy_referral_self_invite_total"
	// MetricExportDispatch Hub 回连派单的结果计数，按 outcome 分（ok/unreachable/rejected）。
	MetricExportDispatch = "galaxy_export_dispatch_total"
	// MetricExportDispatchLatency 一次回连派单从发起到拿到响应头的耗时。
	MetricExportDispatchLatency = "galaxy_export_dispatch_ms"
	// MetricContributionRebuilt 心跳发现贡献不在控制面里、照库里的行重建的条数。
	// 正常应当是 0。有量就说明控制面丢过状态（Hub 停了超过 45 秒、Redis 抖动、
	// 有人清过 key），每一条都对应「一台机器在线着却收不到活」的一段时间。
	MetricContributionRebuilt = "galaxy_contribution_rebuilt_total"
)

// 放置路径。埋点按它分组，才看得出「90% 请求走已绑定路径」这条是不是真的。
const (
	PlacePathBound   = "bound"
	PlacePathHardPin = "hardpin"
	PlacePathSelect  = "select"
	PlacePathWait    = "wait"
)

// noopMetrics 没接监控时的默认实现。指标缺席不该让业务路径长出一堆 nil 判断。
type noopMetrics struct{}

func (noopMetrics) Count(string, map[string]string, float64)   {}
func (noopMetrics) Gauge(string, map[string]string, float64)   {}
func (noopMetrics) Observe(string, map[string]string, float64) {}

// ---------- 抽检 ----------

// ShadowReplayer 用 Hub 自己的账号把一次请求原样重放一遍。
//
// 关键在于「Hub 自己的账号」：拿提供者的凭据去重放，等于让被查的人自证清白。
// 没配 Hub 账号时抽检整体关闭 —— 宁可不查，也不能查出个假结论。
type ShadowReplayer interface {
	Replay(ctx context.Context, family, path string, body []byte) ([]byte, error)
}

// ---------- 通知 ----------

// ProviderNotifier 把额度预警、凭据失效这类事件送到提供者（P-10、P-12）。
// P0 只落库，实现可以是空操作。
type ProviderNotifier interface {
	NotifyQuotaWarning(ctx context.Context, ownerUserID, cid string, unit contract.MeterUnit, used, limit int64)
	NotifyContributionRemoved(ctx context.Context, ownerUserID, cid, reason string)
}
