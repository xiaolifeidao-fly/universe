package dto

import "time"

// 管理端仪表盘。
//
// 和「运营总览」（AdminOverview）是两页不同的东西，别合并：
// 那一页是**待办计数**（有几件事在等人处理，点进去就去办），这一页是**经营数字**
// （今天来了多少人、跑了多少量、收了多少钱、池子还剩多少）。
// 一页只该回答一个问题；把待办和经营摆在一起，两边都会被对方的数字盖住。
//
// 每个数都带得出自己的口径 —— 一个说不清是怎么算出来的数字，运营不会拿它做决定。

// AdminDashboard 一次取回仪表盘要的全部数字。
type AdminDashboard struct {
	// GeneratedAt 这份数出来的时刻。页面上要显示它：仪表盘会挂着自动刷新，
	// 看的人得知道眼前这个数是几分钟前的。
	GeneratedAt time.Time `json:"generatedAt"`
	// Date / DayStart 统计的是哪一天，以及那一天从哪一刻算起（服务端本地时区）。
	// 「今天」不是一个不言自明的词：跨时区看同一块板子的人会得出不同的结论。
	Date     string    `json:"date"`
	DayStart time.Time `json:"dayStart"`

	// Accounts 两端各自的账号情况：今日登录、今日注册、账号总数。
	Accounts DashboardAccounts `json:"accounts"`
	// Machines 此刻在线的共享端机器，按散户 / 工作室分开。
	Machines DashboardMachines `json:"machines"`
	// Usage 今日用量与金额，按 Claude / Codex 分类，两端的钱分开记。
	Usage    DashboardUsage    `json:"usage"`
	Requests DashboardRequests `json:"requests"`
	// Revenue 今日进账。
	Revenue DashboardRevenue `json:"revenue"`
	// Capacity 此刻池子里还剩多少额度。
	Capacity DashboardCapacity `json:"capacity"`
	// Tracking 官网打开与模型广场点击在所选日期的合计。
	Tracking DashboardTracking `json:"tracking"`
	// Degraded 取不到的那几块。取不到就说取不到，**不显示成 0** ——
	// 「今天零消耗」和「这块数据没取到」是完全不同的两件事，而 0 会被读成前者。
	Degraded []string `json:"degraded"`
}

// DashboardRequests counts today's created requests by their current state.
type DashboardRequests struct {
	Total     int64 `json:"total"`
	Completed int64 `json:"completed"`
	Failed    int64 `json:"failed"`
	Cancelled int64 `json:"cancelled"`
	Expired   int64 `json:"expired"`
	Pending   int64 `json:"pending"`
}

// ---------- 账号 ----------

type DashboardAccounts struct {
	// Provider 共享端（Nova）：出算力的人。
	Provider DashboardAccountStat `json:"provider"`
	// Consumer 使用端（Orbit）：买额度的人。
	Consumer DashboardAccountStat `json:"consumer"`
}

// DashboardAccountStat 一端账号的三个数。
type DashboardAccountStat struct {
	// LoggedIn 今天登录过的人数。
	//
	// 口径来自 last_login_at（只前进不后退），所以它是**人数**不是次数：
	// 同一个人今天登录五次也只算一个。要次数得另立一张登录流水表 —— 日活这个
	// 问题下人数才是要的那个数，而且不必为它在登录路径上多写一行。
	LoggedIn int64 `json:"loggedIn"`
	// Registered 今天新注册的人数。
	Registered int64 `json:"registered"`
	// Total 这一端的账号总数，含停用的。登录数要有个分母才读得出意思。
	Total int64 `json:"total"`
}

// ---------- 机器 ----------

// DashboardMachines 共享端机器此刻的在场情况。
//
// 在线的判定看**心跳**（status = active 且最近一次心跳在超时之内），不只看 status：
// status 由巡检每分钟刷，巡检停了它会停在 active，界面上就是一台「在线」着
// 却早已离场的机器。
type DashboardMachines struct {
	Online int64 `json:"online"`
	// Individual / Studio 在线机器里的散户与工作室各多少。
	// 没有 provider 行就是散户 —— 注册默认散户，只有管理端能设成工作室。
	Individual int64 `json:"individual"`
	Studio     int64 `json:"studio"`
	// Offline 登记过、此刻没心跳的。解绑掉的机器两边都不算。
	Offline int64 `json:"offline"`
	// Banned 还封着的机器数。
	Banned int64 `json:"banned"`
	// Total = Online + Offline。
	Total int64 `json:"total"`
}

// ---------- 用量 ----------

// 类别。按模型推：llm.chat 下面同时跑着 Claude 和 Codex，光看 kind 分不开。
const (
	UsageCategoryClaude = "claude"
	UsageCategoryCodex  = "codex"
	UsageCategoryVideo  = "video"
	UsageCategoryOther  = "other"
)

// DashboardUsage 今日用量。
type DashboardUsage struct {
	// Categories 各类别一格，永远至少含 claude 与 codex 两格（没有量时是 0，
	// 而不是整格消失 —— 一格「今天 Codex 没跑」和「界面上没有 Codex」不一样）。
	Categories []DashboardUsageCategory `json:"categories"`
	// Total 全部类别的合计。
	Total DashboardUsageCategory `json:"total"`
	// RolledUntil 汇总表已经封口到哪一刻；这之后到此刻的量是现算的。
	// 数字对不上时先看它：汇总表的活计是按小时封口的。
	RolledUntil time.Time `json:"rolledUntil"`
}

// DashboardUsageCategory 一类算力今天的量与钱。
type DashboardUsageCategory struct {
	Category string `json:"category"`
	// Tokens 今天消耗的 token 数。
	//
	// 取的是 Hub 解析时算好的合计（llm.total_tokens = 输入 + 输出 + 缓存读 + 缓存写），
	// 也就是共享者的额度计数器盯着的那个数。没有合计行的（非中转类能力、老数据）
	// 退回四个桶自己相加。
	Tokens int64 `json:"tokens"`
	// TokenBuckets 是输入、输出、缓存读写的可核对明细。Tokens 是四桶合计，
	// 但运营排查统计时不能只给一个合计数。
	TokenBuckets DashboardTokenBuckets `json:"tokenBuckets"`
	// Calls 计量流水里的调用数；成功数由 Requests.Completed 单独统计。
	Calls int64 `json:"calls"`
	// ConsumerAmount 使用端这一类花掉的钱（微元）：向使用者收的。
	ConsumerAmount int64 `json:"consumerAmount"`
	// ProviderAmount 共享端这一类挣到的钱（微元）：结给共享者的。
	//
	// 和上面那个**不是同一个数**，也不该相加：同一批 token，一边是收入一边是成本，
	// 差额才是平台毛利。token 数两边是同一个（同一批请求），所以只给一份。
	ProviderAmount int64 `json:"providerAmount"`
	// Margin = ConsumerAmount - ProviderAmount。可以是负的：
	// 结算单价高过对外单价是一个合法的运营选择（拉新期补贴），那时平台在倒贴。
	Margin int64 `json:"margin"`
	// Units 分计量单位的明细。量纲随单位而定，跨单位相加没有意义 ——
	// 界面上它是一张小表，不是几个可以加起来的数。
	Units []DashboardUsageUnit `json:"units"`
}

// DashboardTokenBuckets 是一类算力的 token 四桶明细与合计。
type DashboardTokenBuckets struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	CacheRead  int64 `json:"cacheRead"`
	CacheWrite int64 `json:"cacheWrite"`
	Total      int64 `json:"total"`
}

// DashboardUsageUnit 一个计量单位今天的量与钱。
type DashboardUsageUnit struct {
	Unit           string `json:"unit"`
	Amount         int64  `json:"amount"`
	ConsumerAmount int64  `json:"consumerAmount"`
	ProviderAmount int64  `json:"providerAmount"`
}

// ---------- 进账 ----------

// DashboardRevenue 今天有多少钱进来。
//
// 三个数各记各的，**不能相加**：
//
//	RechargePaid  运营线下收了钱、在管理端把积分充进去的那一笔实付金额。钱是今天进来的。
//	ChannelPaid   使用者自己走支付渠道付掉的订单。钱也是今天进来的。
//	PointsPaid    用积分买掉的订单。这笔钱在充值那天就已经进来过了 ——
//	              算进「今日充值」就是把同一笔钱数两遍。单列出来是为了看得见积分在被花掉。
type DashboardRevenue struct {
	RechargePaid   int64 `json:"rechargePaid"`
	RechargePoints int64 `json:"rechargePoints"`
	RechargeCount  int64 `json:"rechargeCount"`

	ChannelPaid  int64 `json:"channelPaid"`
	ChannelCount int64 `json:"channelCount"`

	PointsPaid  int64 `json:"pointsPaid"`
	PointsCount int64 `json:"pointsCount"`
}

// ---------- 算力剩余 ----------

// DashboardCapacity 此刻池子里还剩多少额度。
//
// 数来自共享者自己设的授权上限减去已用（额度计数器每分钟从 Redis 快照回库），
// 只统计**此刻在线**的机器 —— 离线机器的剩余额度现在一个 token 都放不出来。
type DashboardCapacity struct {
	// Windows 按额度窗口分档：5h / day / week / month / total。
	// 共享者按哪一档设上限，剩余就落在哪一档；一台机器可以同时有好几档。
	Windows []DashboardCapacityWindow `json:"windows"`
	// Machines 至少还有一档 token 额度有剩的在线机器数。
	Machines int64 `json:"machines"`
	// OnlineMachines 在线机器数，Machines 的分母。
	OnlineMachines int64 `json:"onlineMachines"`
	// Unlimited 在线但一条 token 额度都没设的机器数。它们不在上面任何一档里 ——
	// 不设上限不等于没有额度，把它们算成 0 会让「池子快空了」这个判断整个失真。
	Unlimited int64 `json:"unlimited"`
	// SnapshotAt 额度计数器最近一次快照回库的时刻。
	SnapshotAt time.Time `json:"snapshotAt"`
	// Stale 快照太旧（巡检停了 / Redis 断了）。此时「已用」是旧数，剩余会偏多。
	Stale bool `json:"stale"`
}

// DashboardCapacityWindow 一个额度窗口档里的剩余。
type DashboardCapacityWindow struct {
	// Window 5h / day / week / month / total。
	Window string `json:"window"`
	// Limit / Used / Left 这一档下全部 token 类额度的上限、已用与剩余合计。
	//
	// 跨机器相加是个**粗口径**：各家设的单位不一定一样（有人按合计 token 设，
	// 有人只卡输出 token）。它回答的是「这一档整体还有多少余量」，
	// 不是某一台机器还能跑多少。分单位的明细在 Units 里。
	Limit int64 `json:"limit"`
	Used  int64 `json:"used"`
	Left  int64 `json:"left"`
	// Machines / Contributions 这一档下还有剩余的机器数与贡献数。
	Machines      int64 `json:"machines"`
	Contributions int64 `json:"contributions"`
	// Units 分计量单位的明细。
	Units []DashboardCapacityUnit `json:"units"`
}

// DashboardCapacityUnit 一个计量单位在这一档下的剩余。
type DashboardCapacityUnit struct {
	Unit  string `json:"unit"`
	Limit int64  `json:"limit"`
	Used  int64  `json:"used"`
	Left  int64  `json:"left"`
}
