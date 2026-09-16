package dto

import "time"

// 运营后台专用的出入参。和消费端、共享端的同名视图分开写：
// 同一张表在两边露出的字段范围不一样（运营多一个「主人是谁」、少一层打码），
// 复用一个结构迟早会把只该给运营看的字段带进用户侧的响应里。

// ---------- 提现审批 ----------

// AdminPayoutQuery 提现队列的过滤条件。Status 为空表示不限，队列页默认只看 pending。
type AdminPayoutQuery struct {
	Status      string `form:"status"`
	OwnerUserID string `form:"ownerUserId"`
	// Keyword 按单号或主人 id 模糊找。
	Keyword string `form:"keyword"`
	Offset  int    `form:"offset"`
	Limit   int    `form:"limit"`
}

// AdminPayoutView 运营看到的一张提现单：比申请人自己看到的多一个主人是谁、谁处置的。
//
// Account 仍然是打码的 —— 它进了列表就会进日志、进截图。真要打款的那一刻按单号
// 单独取一次明文（RevealPayoutAccount），那一次是 POST，只读角色够不着。
type AdminPayoutView struct {
	PayoutView
	OwnerUserID string `json:"ownerUserId"`
	OwnerName   string `json:"ownerName"`
	HandledBy   string `json:"handledBy,omitempty"`
}

// AdminPayoutPage 一页提现单 + 各状态的计数。计数不随分页变 ——
// 队列顶上那排数字要回答「还剩多少笔要处理」，翻到第二页它不该跟着变。
type AdminPayoutPage struct {
	Total   int64             `json:"total"`
	Payouts []AdminPayoutView `json:"payouts"`
	// Counts 按状态计数：pending / paid / rejected。
	Counts map[string]int64 `json:"counts"`
	// MinCredits 起提金额（微积分），界面上解释「为什么这个人提不了」。
	MinCredits int64 `json:"minCredits"`
	// HoldDays 争议期天数。
	HoldDays int `json:"holdDays"`
}

// HandlePayoutRequest 处置一张提现单。
type HandlePayoutRequest struct {
	PayoutID string `json:"payoutId" binding:"required"`
	// Status 只接受 paid / rejected。paid 是「钱已经打出去了」，
	// rejected 会把积分原路退回申请人账户。
	Status string `json:"status" binding:"required"`
	// Note 面向申请人的说明。驳回时必填 —— 一个没有理由的驳回，申请人只会再提一次。
	Note string `json:"note"`
	// HandledBy 谁处置的。只取自凭证，请求体里报个名字不算数。
	HandledBy string `json:"-"`
}

// PayoutAccountView 收款账号明文。只在运营点「查看收款账号」那一次返回。
type PayoutAccountView struct {
	PayoutID string `json:"payoutId"`
	Method   string `json:"method"`
	Account  string `json:"account"`
}

// ---------- 价目表 ----------

// PriceView 价目表的一行：某个 kind 的某个计量单位，从某一刻起多少钱。
type PriceView struct {
	Kind string `json:"kind"`
	Unit string `json:"unit"`
	// Price 每百万单位的价格，单位微分（1,000,000 微分 = ¥1）。
	Price         int64     `json:"price"`
	Currency      string    `json:"currency"`
	ProviderShare float64   `json:"providerShare"`
	EffectiveFrom time.Time `json:"effectiveFrom"`
	// Effective 这一行此刻是不是正在生效的那一条。同一个 (kind, unit) 下
	// effective_from 最新且已经到点的那行为真，其余（历史价、未来价）为假。
	Effective bool `json:"effective"`
}

// PriceTableView 整张价目表 + 界面要用到的候选值。
//
// Kinds / Units 由服务端给：运营不该去背 "llm.input_tokens" 这种字符串，
// 拼错一个字母的后果是这条计量单位永远查不到价，而账单只会安静地少算一笔。
type PriceTableView struct {
	Prices []PriceView `json:"prices"`
	Kinds  []string    `json:"kinds"`
	Units  []string    `json:"units"`
	// UsedUnits 最近 30 天真实产生过用量、却没有价可查的 (kind, unit)。
	// 价目表是空的时候账单永远是 0，而系统不会报错 —— 这一列就是那个告警。
	Unpriced []PriceView `json:"unpriced"`
}

// SavePriceRequest 新增或改一行价目。四元组 (kind, unit, effectiveFrom) 定位，
// 撞上已有的就覆盖价格与分成。
type SavePriceRequest struct {
	Kind          string     `json:"kind" binding:"required"`
	Unit          string     `json:"unit" binding:"required"`
	Price         int64      `json:"price"`
	Currency      string     `json:"currency"`
	ProviderShare float64    `json:"providerShare"`
	EffectiveFrom *time.Time `json:"effectiveFrom"`
}

// DeletePriceRequest 删一行价目。
type DeletePriceRequest struct {
	Kind          string    `json:"kind" binding:"required"`
	Unit          string    `json:"unit" binding:"required"`
	EffectiveFrom time.Time `json:"effectiveFrom" binding:"required"`
}

// ---------- 订单 ----------

// AdminOrderQuery 订单列表的过滤条件。
type AdminOrderQuery struct {
	Status string `form:"status"`
	UserID string `form:"userId"`
	// Keyword 按单号、下单人、渠道流水号模糊找。人工确认到账时手上往往只有一个流水号。
	Keyword string `form:"keyword"`
	Offset  int    `form:"offset"`
	Limit   int    `form:"limit"`
}

// AdminOrderView 运营看到的一张订单：比下单人自己看到的多一个「是谁下的」。
//
// 不含 IssuedSecret —— 那是履约那一次的一次性返回值，列表里永远查不到它。
type AdminOrderView struct {
	OrderView
	UserID   string `json:"userId"`
	UserName string `json:"userName"`
	// PaymentRef 渠道流水号。人工确认到账时运营填的就是它。
	PaymentRef string `json:"paymentRef,omitempty"`
}

type AdminOrderPage struct {
	Total  int64            `json:"total"`
	Orders []AdminOrderView `json:"orders"`
	// Counts 按状态计数：pending / paid / fulfilled / cancelled。不随分页变。
	Counts map[string]int64 `json:"counts"`
}

// ---------- 封禁名单 ----------

// BannedMachineView 封禁名单上的一台设备。
//
// Fingerprint 是设备指纹的哈希，光有它认不出是谁的机器 —— 所以带上这个指纹底下
// 的节点记录。一台被封之后又撤销的机器，节点列表会是空的，那正是这张名单存在的理由：
// 它是那个指纹**唯一**还能被看到、被解封的地方。
type BannedMachineView struct {
	Fingerprint string    `json:"fingerprint"`
	Banned      bool      `json:"banned"`
	Reason      string    `json:"reason,omitempty"`
	UpdatedBy   string    `json:"updatedBy,omitempty"`
	UpdatedTime time.Time `json:"updatedTime"`
	// Nodes 这个指纹下还留着的节点记录，含已撤销的。
	Nodes []BannedMachineNode `json:"nodes"`
}

type BannedMachineNode struct {
	NodeID      string `json:"nodeId"`
	DisplayName string `json:"displayName,omitempty"`
	OwnerUserID string `json:"ownerUserId,omitempty"`
	OwnerName   string `json:"ownerName,omitempty"`
	Status      string `json:"status,omitempty"`
}

// BanMachineRequest 按设备指纹封禁 / 解封。
//
// 和 BanNodeRequest 的区别是**拿什么定位**：那条按 node_id 找机器，机器不在了就没法解封；
// 这条直接认指纹，封禁名单上看得见的每一行都解得开。
type BanMachineRequest struct {
	Fingerprint string `json:"fingerprint" binding:"required"`
	Banned      bool   `json:"banned"`
	Reason      string `json:"reason"`
	// UpdatedBy 谁操作的。只取自凭证。
	UpdatedBy string `json:"-"`
}

// ---------- 用量偏差 ----------

// MismatchQuery 用量偏差的过滤条件。
type MismatchQuery struct {
	CID  string `form:"cid"`
	Unit string `form:"unit"`
	// MinRatio 只看偏差不小于它的（0.3 = 三成）。0 表示不筛。
	MinRatio float64 `form:"minRatio"`
	// Days 往回看几天。0 按服务端默认（7 天）。
	Days   int `form:"days"`
	Offset int `form:"offset"`
	Limit  int `form:"limit"`
}

// UsageMismatchView 一次「节点自报和 Hub 解析对不上」的记录。
//
// HubValue 是平台侧计量（S-04：平台侧优先），NodeValue 是节点自报的。
// 两者的比值超过阈值就落一行 —— 单看一行说明不了问题，同一条贡献反复上榜才是虚报。
type UsageMismatchView struct {
	UnitID    string    `json:"unitId"`
	CID       string    `json:"cid"`
	OwnerName string    `json:"ownerName,omitempty"`
	Unit      string    `json:"unit"`
	HubValue  int64     `json:"hubValue"`
	NodeValue int64     `json:"nodeValue"`
	Ratio     float64   `json:"ratio"`
	CreatedAt time.Time `json:"createdAt"`
}

// MismatchOffender 反复出现偏差的一条贡献。
type MismatchOffender struct {
	CID        string  `json:"cid"`
	OwnerName  string  `json:"ownerName,omitempty"`
	Times      int64   `json:"times"`
	WorstRatio float64 `json:"worstRatio"`
}

type MismatchPage struct {
	Total   int64               `json:"total"`
	Records []UsageMismatchView `json:"records"`
	// Offenders 这段时间里偏差次数最多的几条贡献。逐行看看不出规律，这份排行才是结论。
	Offenders []MismatchOffender `json:"offenders"`
	// Threshold 当前告警阈值（galaxy.usage_mismatch_ratio），界面上解释「多大才算偏差」。
	Threshold float64 `json:"threshold"`
	Days      int     `json:"days"`
}

// ---------- 运行工单 ----------

// AdminUnitQuery 运行工单的过滤条件。
type AdminUnitQuery struct {
	State string `form:"state"`
	Kind  string `form:"kind"`
	CID   string `form:"cid"`
	// ConsumerKey 收窄到某一把密钥。
	ConsumerKey string `form:"consumerKey"`
	// Days 往回看几天。0 按服务端默认（1 天）—— 运行工单是排障用的，翻太久没有意义。
	Days   int `form:"days"`
	Offset int `form:"offset"`
	Limit  int `form:"limit"`
}

// AdminUnitView 一条工单：谁的请求、落在哪条贡献上、跑成什么样。
//
// **不含任何请求内容** —— 工单表上本来就不存它（C-12），这里也不去别处凑。
type AdminUnitView struct {
	UnitID      string `json:"unitId"`
	Kind        string `json:"kind"`
	Primitive   string `json:"primitive"`
	Provider    string `json:"provider"`
	Model       string `json:"model,omitempty"`
	ConsumerKey string `json:"consumerKey"`
	KeyAlias    string `json:"keyAlias,omitempty"`
	CID         string `json:"cid,omitempty"`
	NodeID      string `json:"nodeId,omitempty"`
	State       string `json:"state"`
	ErrorClass  string `json:"errorClass,omitempty"`
	ErrorCode   string `json:"errorCode,omitempty"`
	ErrorMsg    string `json:"errorMessage,omitempty"`
	// Instance 持有消费者连接的 Hub 实例。多实例部署时排障第一步就是它。
	Instance    string     `json:"instance,omitempty"`
	Attempt     int        `json:"attempt"`
	StartedAt   *time.Time `json:"startedAt,omitempty"`
	FinishedAt  *time.Time `json:"finishedAt,omitempty"`
	DurationMs  int64      `json:"durationMs,omitempty"`
	CreatedTime time.Time  `json:"createdTime"`
}

type AdminUnitPage struct {
	Total int64           `json:"total"`
	Units []AdminUnitView `json:"units"`
	// Counts 这段时间里各状态各有多少。不随分页变。
	Counts map[string]int64 `json:"counts"`
	Days   int              `json:"days"`
}

// CancelUnitRequest 运营强制取消一条还在跑的工单。
type CancelUnitRequest struct {
	UnitID string `json:"unitId" binding:"required"`
	// Reason 会写进工单事件流，节点侧也拿得到。
	Reason string `json:"reason"`
	// CancelledBy 谁取消的。只取自凭证。
	CancelledBy string `json:"-"`
}

// ---------- 运营总览 ----------

// AdminOverview 「今天要做什么」。
//
// 每一项都是一个**待办计数**，点进去就是对应那一页 —— 不是一块看着好看的仪表盘。
// 共享池的运营散在十几个页面上，没有这一页，判断「有没有事要处理」只能一页页翻。
type AdminOverview struct {
	// PendingPayouts 待处理的提现。积分在申请那一刻就扣走了，这个数不是零就有人在等钱。
	PendingPayouts int64 `json:"pendingPayouts"`
	// PendingOrders 待付款的订单。线下转账要在这里补。
	PendingOrders int64 `json:"pendingOrders"`
	// OpenDisputes 还没裁决的争议工单。
	OpenDisputes int64 `json:"openDisputes"`
	// NewLeads 还没跟进的门户线索。
	NewLeads int64 `json:"newLeads"`
	// UnpricedUnits 有用量却查不到价的计量单位数。不是零就意味着有一部分钱正在被静默算成 0。
	UnpricedUnits int `json:"unpricedUnits"`
	// RecentMismatches 近 7 天的用量偏差条数。
	RecentMismatches int64 `json:"recentMismatches"`
	// BannedMachines 此刻还封着的机器数。
	BannedMachines int64 `json:"bannedMachines"`
	// Pool 池子此刻的水位合计。
	Pool OverviewPool `json:"pool"`
	// Today 今天的工单情况。
	Today OverviewToday `json:"today"`
	// Degraded 取不到的那几块。控制面没配 Redis 时池水位是空的 ——
	// 显示成 0 会被读成「池子空了」，那是完全不同的一件事。
	Degraded []string `json:"degraded"`
}

type OverviewPool struct {
	Lanes         int `json:"lanes"`
	Contributions int `json:"contributions"`
	Online        int `json:"online"`
	SeatsTotal    int `json:"seatsTotal"`
	SeatsUsed     int `json:"seatsUsed"`
	Inflight      int `json:"inflight"`
	WaitQueue     int `json:"waitQueue"`
}

type OverviewToday struct {
	Units   int64 `json:"units"`
	Failed  int64 `json:"failed"`
	Running int64 `json:"running"`
}

// ---------- 邀请返现 ----------

// AdminReferralQuery 邀请关系的过滤条件。
type AdminReferralQuery struct {
	// Side consumer（使用端买套餐返）/ provider（共享端出算力返）。
	// **两端是两套码，码不通用** —— 不分端查出来的是两批互不相干的人拌在一起。
	Side string `form:"side"`
	// InviterID 只看这个人拉来的。
	InviterID string `form:"inviterId"`
	Keyword   string `form:"keyword"`
	// InvitedOnly 只看被人邀请来的，滤掉自己注册的那一大批（默认开）。
	InvitedOnly bool `form:"invitedOnly"`
	Offset      int  `form:"offset"`
	Limit       int  `form:"limit"`
}

// ReferralRecord 一行邀请关系。
type ReferralRecord struct {
	UserID     string `json:"userId"`
	UserName   string `json:"userName,omitempty"`
	InviteCode string `json:"inviteCode"`
	// InvitedBy 空表示自己注册的，没有邀请人。
	InvitedBy   string    `json:"invitedBy,omitempty"`
	InviterName string    `json:"inviterName,omitempty"`
	CreatedTime time.Time `json:"createdTime"`
}

// InviterRank 一个邀请人的战绩：拉来几个人、平台为此付出多少（微积分）。
type InviterRank struct {
	InviterID   string `json:"inviterId"`
	InviterName string `json:"inviterName,omitempty"`
	Invitees    int64  `json:"invitees"`
	// Payout 返给这个人的积分合计。共享端已经扣掉申诉追回的那部分，是净额。
	Payout int64 `json:"payout"`
}

type AdminReferralPage struct {
	Total   int64            `json:"total"`
	Records []ReferralRecord `json:"records"`
	// Top 拉人最多的几位。逐行翻看不出谁在真的带量，这份排行才是结论。
	Top []InviterRank `json:"top"`
	// DefaultBps 使用端通用套餐的默认返现比例（万分之一）。各模型自己的比例在模型目录上。
	DefaultBps int64 `json:"defaultBps"`
	// ProviderRate 共享端的返现比例（0.1 = 10%），0 表示这个活动没开。
	ProviderRate float64 `json:"providerRate"`
	// ProviderDays 共享端返现期限（天），0 表示长期有效。
	ProviderDays int    `json:"providerDays"`
	Side         string `json:"side"`
}

// ---------- 信誉 ----------

// ReputationView 一份信誉记录。
//
// Subject 的形状是 account:<账号> / device:<设备指纹> / node:<nodeId> ——
// 散户的信誉跟着账号走（名下机器共用一份），工作室的跟着设备走（每台各算各的）。
type ReputationView struct {
	Subject string `json:"subject"`
	// Kind account / device / node，从 Subject 前缀拆出来给界面用。
	Kind string `json:"kind"`
	// Ref Subject 冒号后面那一段。
	Ref string `json:"ref"`
	// OwnerName Kind 是 account 时能查到名字；device / node 查不到就是空串。
	OwnerName string `json:"ownerName,omitempty"`
	// Settled 是结算时刻那一刻的分数，Effective 是按回升速率算出来的**此刻**的分数。
	// 界面上要显示 Effective —— 直接显示 Settled 会把早就自然回满的主体说成还在低分。
	Settled   float64   `json:"settled"`
	Effective float64   `json:"effective"`
	SettledAt time.Time `json:"settledAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	// Nodes 这个主体对应的机器，帮运营认出「这是谁的哪台」。
	Nodes []BannedMachineNode `json:"nodes"`
}

type ReputationPage struct {
	Records []ReputationView `json:"records"`
	// Threshold 当前筛选用的阈值。
	Threshold float64 `json:"threshold"`
	// RecoveryPerDay 信誉每天回升多少，封顶 1。界面上解释「为什么过几天自己就好了」。
	RecoveryPerDay float64 `json:"recoveryPerDay"`
}

// SetReputationRequest 人工把一个主体的信誉设成某个值。
//
// 它**不叠加**：运营想的是「恢复到满分」这种确定结果，而叠加式的 +0.3 在一个
// 已经被扣到 0.2 的主体上给出的是 0.5 —— 点两次又是另一个数。
type SetReputationRequest struct {
	Subject string `json:"subject" binding:"required"`
	// Value 0..1。1 是满分。
	Value float64 `json:"value"`
	// Reason 为什么改。会写进管理端的操作记录。
	Reason string `json:"reason"`
	// UpdatedBy 谁改的。只取自凭证。
	UpdatedBy string `json:"-"`
}

// ---------- 三本账 ----------

// LedgerSide 哪一侧的账本。
const (
	LedgerSideConsumer = "consumer"
	LedgerSideProvider = "provider"
	LedgerSidePlatform = "platform"
)

// AdminLedgerQuery 账本的过滤条件。
type AdminLedgerQuery struct {
	// Side consumer / provider / platform，默认 consumer。
	Side string `form:"side"`
	Type string `form:"type"`
	// Keyword 按幂等键、工单号，以及这一侧的主体（密钥 / 贡献 / 主人）模糊找。
	Keyword string `form:"keyword"`
	// Days 往回看几天，0 按服务端默认（30 天）。
	Days   int `form:"days"`
	Offset int `form:"offset"`
	Limit  int `form:"limit"`
}

// LedgerEntry 一行账本。三侧共用一个形状，各自没有的字段留空。
type LedgerEntry struct {
	TxnID string `json:"txnId"`
	Type  string `json:"type"`
	Unit  string `json:"unit,omitempty"`
	// Amount 的**量纲按侧不同**：消费侧是计量数（token 之类），供给侧是微积分，
	// 平台侧是微分。见 AdminLedgerPage.AmountUnit。
	Amount int64  `json:"amount"`
	Price  int64  `json:"price,omitempty"`
	UnitID string `json:"unitId,omitempty"`

	KeyID        string `json:"keyId,omitempty"`
	BalanceAfter int64  `json:"balanceAfter,omitempty"`

	CID           string `json:"cid,omitempty"`
	OwnerUserID   string `json:"ownerUserId,omitempty"`
	OwnerName     string `json:"ownerName,omitempty"`
	RelatedUserID string `json:"relatedUserId,omitempty"`

	CreatedAt time.Time `json:"createdAt"`
}

// LedgerTypeTotal 某一类流水的笔数与合计。按整个筛选条件算，不随分页变。
type LedgerTypeTotal struct {
	Type   string `json:"type"`
	Count  int64  `json:"count"`
	Amount int64  `json:"amount"`
}

type AdminLedgerPage struct {
	Total   int64             `json:"total"`
	Entries []LedgerEntry     `json:"entries"`
	Totals  []LedgerTypeTotal `json:"totals"`
	Side    string            `json:"side"`
	Days    int               `json:"days"`
	// AmountUnit 这一侧的 amount 是什么量纲：metering（计量数）/ credit（微积分）/ money（微分）。
	//
	// **必须一路透到界面上**：三张表的 amount 是三个不同的东西，界面拿同一套
	// 「÷1,000,000 显示成元」的规则去渲染，消费侧那一列会变成一个荒唐的小数，
	// 而看的人不会意识到自己在读一个错的数。
	AmountUnit string `json:"amountUnit"`
	// Types 这一侧会出现的流水类型，供界面做下拉。
	Types []string `json:"types"`
}

// ---------- 运行参数 ----------

// SettingView 一项可调参数此刻的样子。
type SettingView struct {
	Key string `json:"key"`
	// Group 界面上的分组：placement / score / key / artifact / risk / payout / referral / compliance。
	Group string `json:"group"`
	// Kind int / float / duration / text。duration 的值是**毫秒**。
	Kind string `json:"kind"`
	// Value 此刻生效的值。
	Value string `json:"value"`
	// Default 配置文件里的那份。点「改回默认」就是退回它。
	Default string `json:"default"`
	// Overridden 这一项是不是在后台改过。为假表示它还跟着配置文件走。
	Overridden bool `json:"overridden"`
	// Min / Max 允许范围，两个都是 0 表示不限。
	Min float64 `json:"min"`
	Max float64 `json:"max"`
	// Unit 界面上的单位提示：second / minute / hour / day / ratio / bps / seat / time / credit。
	Unit      string     `json:"unit,omitempty"`
	UpdatedBy string     `json:"updatedBy,omitempty"`
	UpdatedAt *time.Time `json:"updatedAt,omitempty"`
}

type AdminSettingsPage struct {
	Settings []SettingView `json:"settings"`
	// PropagationSeconds 改完最多多少秒在全部进程上生效。
	//
	// **必须显示出来**：改完不是立刻到处生效的，各个进程按自己的节奏回查。
	// 不说这句话，运营改完刷新一下没看到效果，就会再改一遍、再改一遍。
	PropagationSeconds int `json:"propagationSeconds"`
}

// SaveSettingRequest 改一项运行参数。Value 为空表示改回默认（删掉那一行）。
type SaveSettingRequest struct {
	Key   string `json:"key" binding:"required"`
	Value string `json:"value"`
	// Reset 为真表示改回配置文件里的默认值。
	Reset bool `json:"reset"`
	// UpdatedBy 谁改的。只取自凭证。
	UpdatedBy string `json:"-"`
}
