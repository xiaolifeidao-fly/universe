// Package galaxy 是共享算力池的通用核心：把提供者授权出来的贡献汇聚成一个池，
// 对消费者的每次请求做鉴权、放置、额度、计量与结算。
//
// 它不 import 任何其他领域包，也不认识「中转站」「任务宇宙」「视频剪辑」这些业务 ——
// 业务参数只在适配器的 parse 进、写回出两处被解读（架构原则 5）。
// 需要外部能力时在 ports.go 里声明最小接口，由 galaxy-api 的装配层注入。
package galaxy

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"gorm.io/gorm"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// Config 是共享池的可调参数（设计文档第 15 节的默认参数表）。
type Config struct {
	// Instance 本 Hub 实例的内网地址，写进 next 的 streamURL 让节点上行直推这台机器。
	Instance string
	// ContractVersion 契约版本。与节点不匹配在 hello 阶段拒连（S-11）。
	ContractVersion int

	PlatformSeatLimit int
	// BindIdleTTL 座位的空闲窗口：消费者停手多久之后不再算「占着这台机器」。
	// 闲置从**最后一条请求结束**起算，在途请求不计入 —— 放置时座位会被撑到
	// 「截止时刻 + 这个窗口」。它同时是共享设置页那颗「有 N 位使用者绑在这台上」
	// 牌子的消失时间，所以不能配长：主人停手半小时还看着牌子挂在那儿，只会以为是卡了。
	BindIdleTTL time.Duration
	// AffinityTTL「上次落在哪台」记多久。它和座位是两条时间线：座位让出去了，
	// 偏好还记着，下一条请求先去敲那台的门 —— 敲得开就接着用（上游 prompt cache
	// 还热着），位子被别人占了就照常去挑别的机器。它只影响挑机器的顺序，
	// 不占资源、不上界面，所以可以比座位长得多。
	AffinityTTL      time.Duration
	SpillWait        time.Duration
	MaxWait          time.Duration
	HeartbeatTimeout time.Duration
	BodyTTL          time.Duration
	MaxPlaceAttempts int
	Weights          ScoreWeights

	// 密钥有效期与冻结期。
	KeyTTL         time.Duration
	KeyFreeze      time.Duration
	KeyConcurrency int
	KeyRPM         int

	// KeyCipherSecret 加密存储密钥明文用的密钥（galaxy.key_cipher_secret）。
	// 签发密钥的 galaxy-api 和取回明文的 manager-api 必须配同一个值；没配时密钥照发，
	// 只是取不回明文 —— 「使用」按钮和运营转交都用不了。见 keycipher.go。
	KeyCipherSecret string

	// ProviderTermsVersion / ConsumerNoticeVersion 是同意记录的当前版本。
	// 升版后旧同意失效，提供者下次 hello 被要求重新同意。
	ProviderTermsVersion  string
	ConsumerNoticeVersion string

	// ConsumerBaseURL 消费者 SDK 要填的 base_url，控制台原样展示。
	//
	// 不填就从 Instance 派生（Instance + "/v1"）—— 消费者路由就挂在 /v1 上。
	// 需要显式配置的是「对外地址和 Instance 不同」的部署：Instance 是 Hub 之间
	// 互相寻址用的内网地址，而这个要给用户的 SDK 用，走的是公网入口。
	ConsumerBaseURL string

	// ProviderHubURL 提供者的 ai-bridge 要填的 pool.hubURL，控制台原样展示。
	//
	// 和 ConsumerBaseURL 是同一个公网入口的两副面孔：消费者打 /v1/*，节点打
	// /agent/v1/*。所以不填就从 ConsumerBaseURL 去掉尾巴上的 /v1 派生。
	//
	// 都拿不到才退回 Instance。单机开发时那个值恰好是对的，但生产部署下
	// Instance 是 Hub 之间互相寻址的内网地址 —— 把它显示给用户，用户照着填，
	// 节点就会去连一个它根本够不到的地方。这条必须显式配。
	ProviderHubURL string

	// ConsumerClientDownload 使用端桌面客户端（Orbit）的下载地址，使用端控制台原样展示。
	//
	// 控制台自己就是这个客户端的界面，但它同时挂在浏览器上给没装客户端的人用，
	// 而「使用」那个一键写本机配置的按钮只有桌面壳里才有 —— 在浏览器里看控制台的人
	// 需要一条路把客户端拿到手，这就是那条路。
	//
	// 一个端有四条地址：Windows / mac Intel / mac Apple 芯片各一条，加一条通用下载页。
	// 分平台不是为了整齐 —— Apple 芯片和 Intel 的包不能互相代替，只给一条地址就有一半人下错。
	//
	// 一条都不配就是那一块不显示：安装包托管在哪儿是部署方的事，这里派生不出来，
	// 猜一个地址只会换来一次 404。
	//
	// 源头有两个，叠加关系：配置文件里的 galaxy.consumer_client_download_url 是**通用那条**
	// 的默认值，后台「运行参数」的 client.consumer_download_url[.平台] 覆盖它
	// （管理端那一页就是改这几行）。分平台的三条只有数据库一个源头，见下面 Provider 那段的理由。
	ConsumerClientDownload dto.DesktopDownloadURLs

	// ProviderClientDownload 共享端桌面客户端（Nova）的下载地址。
	//
	// 和上面那个成对，但**只有数据库这一个源头**（照 ConsumerReferralBps 的先例）：
	// 它是为管理端展示加的，还没有任何一个服务从配置文件里读它，
	// 再开一个 galaxy.provider_client_download_url 出来，等于一上来就摆两个都要维护
	// 而其中一个永远没人填的地方。真需要预置时再补配置文件那一层。
	//
	// 现在只有管理端在展示它 —— 共享端控制台那一块要不要摆，是另一件事。
	ProviderClientDownload dto.DesktopDownloadURLs

	// UsageMismatchRatio 节点自报与 Hub 解析的偏差告警阈值。
	UsageMismatchRatio float64

	// ReputationRecoveryPerDay 机器信誉每天回升多少，封顶 1。
	ReputationRecoveryPerDay float64

	PresignPutTTL time.Duration
	PresignGetTTL time.Duration

	// SessionIdleTTL 会话多久没有新回合就自动关闭并释放座位。
	SessionIdleTTL time.Duration

	// PayoutRate 多少「微积分」兑一块钱，默认 1,000,000。
	//
	// 提供者的积分和使用者的积分是同一个口径：**1 积分 = ¥1，库里存微积分**
	// （和 amount / price 同一量纲）。这样两端只有一种「积分」，不会出现
	// 同一个词在共享端值一分、在使用端值一块的局面。
	// 账本与余额里的数都是微积分，界面按 ÷1,000,000 显示。
	PayoutRate int
	// PayoutMinCredits 单次提现的起提金额，单位同样是微积分（默认 10,000,000 = ¥10）。
	// 低于它的申请直接拒 —— 一笔一块钱的提现，人工处理成本远高于金额本身。
	PayoutMinCredits int64
	// PayoutHoldDays 争议期。这段时间内结算的积分算「待结算」，提不出来。
	PayoutHoldDays int

	// PortalAvailability 门户上那句可用性承诺（例如 "99.9%"）。
	//
	// 它是**部署方的承诺**，不是算出来的指标 —— 所以没配就是空串，门户那一格
	// 直接不显示。默认给一个好看的数字等于替部署方许了一个他没许的诺。
	PortalAvailability string

	// BridgeReleaseKeys ai-bridge 的发布公钥（base64，可以配多把，换钥匙期间新旧并存）。
	//
	// 运营上传安装包时服务端先按它验一遍签名。没配就传不上去 —— 这是故意的：
	// 一个没签名的包发出去，每台机器都会在升级的最后一步拒装，而运营要到那时候才知道。
	// 私钥离线保管，公钥同时编进 ai-bridge 自己（release-keys.txt）。
	BridgeReleaseKeys []string
	// BridgeDownloadBaseURL 安装包的公开访问前缀（桶是公开读或者前面挂了 CDN 时配）。
	// 配了就直接拼地址，不再逐次签名；不配走 OSS 签名地址。
	BridgeDownloadBaseURL string

	// ConsumerReferralBps 使用端通用套餐的默认返现比例（万分之一）。
	//
	// 它和下面那两个共享端的值不一样：**它的源头一直是数据库**（zt_galaxy_setting 的
	// referral.default_bps），配置文件里没有它。放进 Config 只是为了让运行参数那套
	// 叠加机制有个落点 —— 读它仍然读的是同一行。
	ConsumerReferralBps int64

	// ReferralRate 共享端邀请返现的比例：0.1 表示被邀请人赚到的积分，平台额外给
	// 邀请人 10%。0 表示这个活动没开。被邀请人自己的收益不受影响 —— 这笔钱是平台出的。
	ReferralRate float64
	// ReferralDays 返现期限（天）。0 表示长期有效。
	ReferralDays int
	// ReferralRegisterURL 邀请链接指向的注册页（Nova 网页版的 /register）。
	// 不配就没有链接可分享，邀请页只显示邀请码 —— 给一个打不开的链接更糟。
	ReferralRegisterURL string
}

func DefaultConfig() Config {
	return Config{
		ContractVersion:          1,
		PlatformSeatLimit:        10,
		BindIdleTTL:              time.Minute,
		AffinityTTL:              30 * time.Minute,
		SpillWait:                3 * time.Second,
		MaxWait:                  10 * time.Second,
		HeartbeatTimeout:         45 * time.Second,
		BodyTTL:                  60 * time.Second,
		MaxPlaceAttempts:         3,
		Weights:                  DefaultScoreWeights(),
		KeyTTL:                   30 * 24 * time.Hour,
		KeyFreeze:                30 * 24 * time.Hour,
		KeyConcurrency:           4,
		KeyRPM:                   120,
		ProviderTermsVersion:     "provider-terms/v1",
		ConsumerNoticeVersion:    "consumer-notice/v1",
		UsageMismatchRatio:       0.10,
		ReputationRecoveryPerDay: DefaultReputationRecoveryPerDay,
		PresignPutTTL:            15 * time.Minute,
		PresignGetTTL:            60 * time.Minute,
		SessionIdleTTL:           24 * time.Hour,
		PayoutRate:               priceScale,
		PayoutMinCredits:         10 * priceScale,
		PayoutHoldDays:           7,
	}
}

func (c Config) withDefaults() Config {
	defaults := DefaultConfig()
	if c.ContractVersion <= 0 {
		c.ContractVersion = defaults.ContractVersion
	}
	if c.PlatformSeatLimit <= 0 {
		c.PlatformSeatLimit = defaults.PlatformSeatLimit
	}
	if c.BindIdleTTL <= 0 {
		c.BindIdleTTL = defaults.BindIdleTTL
	}
	if c.AffinityTTL <= 0 {
		c.AffinityTTL = defaults.AffinityTTL
	}
	if c.AffinityTTL < c.BindIdleTTL {
		// 偏好短于座位没有意义：座位还占着、偏好先忘了，下一条请求会去挑别的机器，
		// 而这台的座位仍旧记在他名下 —— 一个人同时占住两台。
		c.AffinityTTL = c.BindIdleTTL
	}
	if c.SpillWait <= 0 {
		c.SpillWait = defaults.SpillWait
	}
	if c.MaxWait <= 0 {
		c.MaxWait = defaults.MaxWait
	}
	if c.HeartbeatTimeout <= 0 {
		c.HeartbeatTimeout = defaults.HeartbeatTimeout
	}
	if c.BodyTTL <= 0 {
		c.BodyTTL = defaults.BodyTTL
	}
	if c.MaxPlaceAttempts <= 0 {
		c.MaxPlaceAttempts = defaults.MaxPlaceAttempts
	}
	if c.Weights == (ScoreWeights{}) {
		c.Weights = defaults.Weights
	}
	if c.KeyTTL <= 0 {
		c.KeyTTL = defaults.KeyTTL
	}
	if c.KeyFreeze <= 0 {
		c.KeyFreeze = defaults.KeyFreeze
	}
	if c.KeyConcurrency <= 0 {
		c.KeyConcurrency = defaults.KeyConcurrency
	}
	if c.KeyRPM <= 0 {
		c.KeyRPM = defaults.KeyRPM
	}
	if c.ProviderTermsVersion == "" {
		c.ProviderTermsVersion = defaults.ProviderTermsVersion
	}
	// base_url 没配就从 Instance 派生。放在 withDefaults 里而不是 DefaultConfig，
	// 是因为它依赖 Instance —— 那个值要等 loadConfig 读完配置才定下来。
	if strings.TrimSpace(c.ConsumerBaseURL) == "" && strings.TrimSpace(c.Instance) != "" {
		c.ConsumerBaseURL = strings.TrimRight(strings.TrimSpace(c.Instance), "/") + "/v1"
	}
	// 节点地址同理派生，但源头取 ConsumerBaseURL 而不是 Instance —— 上面那行刚把
	// 「对外地址」的结论算完，这里再从 Instance 算一遍就会在显式配了
	// consumer_base_url 的部署上给出两个不一致的地址。
	if strings.TrimSpace(c.ProviderHubURL) == "" {
		if base := strings.TrimSpace(c.ConsumerBaseURL); base != "" {
			c.ProviderHubURL = strings.TrimRight(strings.TrimSuffix(strings.TrimRight(base, "/"), "/v1"), "/")
		} else if instance := strings.TrimSpace(c.Instance); instance != "" {
			c.ProviderHubURL = strings.TrimRight(instance, "/")
		}
	}
	if c.ConsumerNoticeVersion == "" {
		c.ConsumerNoticeVersion = defaults.ConsumerNoticeVersion
	}
	if c.UsageMismatchRatio <= 0 {
		c.UsageMismatchRatio = defaults.UsageMismatchRatio
	}
	if c.ReputationRecoveryPerDay <= 0 {
		c.ReputationRecoveryPerDay = defaults.ReputationRecoveryPerDay
	}
	if c.PresignPutTTL <= 0 {
		c.PresignPutTTL = defaults.PresignPutTTL
	}
	if c.PresignGetTTL <= 0 {
		c.PresignGetTTL = defaults.PresignGetTTL
	}
	if c.SessionIdleTTL <= 0 {
		c.SessionIdleTTL = defaults.SessionIdleTTL
	}
	if c.PayoutRate <= 0 {
		c.PayoutRate = defaults.PayoutRate
	}
	if c.PayoutMinCredits <= 0 {
		c.PayoutMinCredits = defaults.PayoutMinCredits
	}
	if c.PayoutHoldDays < 0 {
		c.PayoutHoldDays = defaults.PayoutHoldDays
	}
	return c
}

// NodeIdentity 是凭证认定的节点身份。它覆盖请求体里的任何节点字段（原则：端侧不可信）。
type NodeIdentity struct {
	NodeID      string
	OwnerUserID string
	DisplayName string
	Banned      bool
}

// Placement 一次成功放置的结果。
type Placement struct {
	UnitID   string
	CID      string
	Attempt  int
	Estimate contract.Metering
}

// Service 共享算力池。
type Service interface {
	// ---------- 能力 ----------
	Kinds() []contract.KindSpec
	Config() Config

	// ---------- 提供者 ----------
	AcceptTerms(ctx context.Context, req dto.AcceptTermsRequest) error
	HasConsent(ctx context.Context, subjectType, userID, termsVersion string) (bool, error)
	IssuePairingCode(ctx context.Context, req dto.IssuePairingCodeRequest) (dto.PairingCodeView, error)
	Pair(ctx context.Context, req dto.PairRequest) (dto.PairResult, error)
	// RegisterNodeByKey 用提供者接入密钥自助注册一台机器（poll 或 export）。
	// 给单独部署、无人值守的 rust bridge 用 —— 那种机器上没人能去点「生成配对码」。
	RegisterNodeByKey(ctx context.Context, req dto.RegisterRequest) (dto.RegisterResult, error)
	AuthenticateNode(ctx context.Context, token string) (NodeIdentity, error)
	Hello(ctx context.Context, req dto.HelloRequest) (dto.HelloResult, error)
	Heartbeat(ctx context.Context, req dto.HeartbeatRequest) (dto.HeartbeatResult, error)
	Next(ctx context.Context, req dto.NextRequest) (*dto.NextResult, error)
	Progress(ctx context.Context, req dto.ProgressRequest) (dto.ProgressResult, error)
	// AuthorizeUnit 校验一个单元当前确实落在这个节点上。
	// 节点通道的每个回传端点都要过这一关：凭证只证明「你是某个节点」，
	// 不证明「这个单元是派给你的」。
	AuthorizeUnit(ctx context.Context, unitID, nodeID string) error
	Complete(ctx context.Context, req dto.CompleteRequest) (dto.CompleteResult, error)

	ListNodes(ctx context.Context, ownerUserID string) ([]dto.NodeView, error)
	// ListRetiredNodes 主人解绑掉的机器。ListNodes 不含它们，两边互补。
	ListRetiredNodes(ctx context.Context, ownerUserID string) ([]dto.NodeView, error)
	ListExecutionRecords(ctx context.Context, ownerUserID, cid string, limit int) ([]dto.ExecutionRecord, error)
	// SetContributionStatus 开关一条贡献。关闭时手上还有在跑的请求就排队（停止接新单、
	// 在途跑完自动落地），除非请求里带了 Force —— 那会掐断在跑的请求并扣信誉分。
	// 结果要交给界面：关闭是立即生效还是在排队，只看 HTTP 200 分不出来。
	SetContributionStatus(ctx context.Context, ownerUserID string, req dto.SetContributionStatusRequest) (dto.SetContributionStatusResult, error)
	// SaveContributionLimits 控制台改授权。额度以 Hub 为权威：改完节点下一次 hello
	// 拿到的 quotaEffective 就与本地申报不同，节点以 Hub 为准。
	SaveContributionLimits(ctx context.Context, req dto.SaveContributionLimitsRequest) error
	RevokeNode(ctx context.Context, ownerUserID, nodeID string) error
	CreditBalance(ctx context.Context, ownerUserID string) (int64, error)

	// ---------- 提供者：接入密钥与回连 ----------
	IssueProviderKey(ctx context.Context, req dto.IssueProviderKeyRequest) (dto.IssuedProviderKey, error)
	ListProviderKeys(ctx context.Context, ownerUserID string) ([]dto.ProviderKeyView, error)
	// RevokeProviderKey 吊销一把接入密钥。已经用它注册出来的机器不受影响 ——
	// 那些机器手里是各自的 node token，要停哪一台去机器列表里撤销那一台。
	RevokeProviderKey(ctx context.Context, ownerUserID, keyID string) error
	// NodeLanes 一台机器此刻还有空位的通道。export 派单器拿它代替节点自报的那份。
	NodeLanes(ctx context.Context, nodeID string) ([]dto.NextLane, error)
	// ExportTargetOf 取一台机器的回连信息。第二个返回值为假表示它不走回连。
	ExportTargetOf(ctx context.Context, nodeID string) (ExportTarget, bool)
	// ListExportTargets 全部还在用的 export 机器，供派单器在 Hub 启动时恢复。
	ListExportTargets(ctx context.Context) ([]ExportTarget, error)
	// RecordEndpointHealth 记一次回连探测结果，主人在控制台上看到的就是这句话。
	RecordEndpointHealth(ctx context.Context, nodeID, status, detail string) error
	// EnableHardPinFallback 允许旧 Responses 会话在原贡献的回连身份错位后解除硬钉。
	// 请求携带完整上下文，下一次 Submit 会删掉 previous_response_id 再重新放置。
	EnableHardPinFallback(ctx context.Context, cid string) error

	// ---------- 提供者：今天与收益 ----------
	// ProviderDashboard 「今天」那一页要的全部数字，一次查完 ——
	// 收益、用量、在线时长互相解释，分成几个接口取会给出对不上的两半。
	ProviderDashboard(ctx context.Context, ownerUserID string) (dto.ProviderDashboard, error)
	ProviderLedger(ctx context.Context, query dto.LedgerQuery) (dto.CreditLedgerPage, error)
	// ProviderRecords 执行记录分页 + 当前筛选条件下的统计。仍然匿名化（C-12）。
	ProviderRecords(ctx context.Context, query dto.ProviderRecordQuery) (dto.ProviderRecordPage, error)
	ListPayouts(ctx context.Context, ownerUserID string, limit int) ([]dto.PayoutView, error)
	// CreatePayout 发起提现。先条件扣积分再建单，扣不动就是余额不够。
	CreatePayout(ctx context.Context, req dto.CreatePayoutRequest) (dto.PayoutView, error)

	// ---------- 消费者 ----------
	// CreateConsumerKey 使用者自助新建一把密钥，最多 5 把有效的。
	// 密钥不带额度：额度是账户里的积分余额，名下几把密钥花的是同一份钱。
	CreateConsumerKey(ctx context.Context, req dto.CreateConsumerKeyRequest) (dto.IssuedKeyView, error)
	// IssueKey 运营代签。和上面走同一条签发路径，区别只在能指定范围与有效期。
	IssueKey(ctx context.Context, req dto.IssueKeyRequest) (dto.IssuedKeyView, error)
	// IssueRegistrationKey 使用端注册即送的那一把，由账号服务在注册成功后调一次。
	// 唯一不过数据告知那道闸的签发路径，见 consumerkey.go 里的说明。
	IssueRegistrationKey(ctx context.Context, ownerUserID string) (dto.IssuedKeyView, error)
	AuthenticateKey(ctx context.Context, secret string) (dto.Caller, error)
	DescribeKey(ctx context.Context, keyID string) (dto.ConsumerKeyView, error)
	ListKeys(ctx context.Context, ownerUserID string) ([]dto.ConsumerKeyView, error)
	RevokeKey(ctx context.Context, ownerUserID, keyID string) error
	// RenewKey 换发：新密钥继承允许范围，旧密钥立刻作废。余额在账户上，不跟着走。
	RenewKey(ctx context.Context, req dto.RenewKeyRequest) (dto.IssuedKeyView, error)
	// RevealKey 取回密钥明文和接入地址。ownerUserID 非空只认本人名下、没吊销的；空串是运营，哪把都能取。
	RevealKey(ctx context.Context, ownerUserID, keyID string) (dto.KeySecretView, error)
	// AdminKeys 运营翻全站的密钥，带主人是谁。
	AdminKeys(ctx context.Context, query dto.AdminKeyQuery) (dto.AdminKeyPage, error)
	Usage(ctx context.Context, query dto.UsageQuery) (dto.UsageReport, error)

	// ---------- 使用者积分与分享 ----------
	// 1 积分 = ¥1。运营充进来，调模型时按单价逐笔扣掉，邀请来的人充值时按比例返给邀请人。
	PointsSummary(ctx context.Context, ownerUserID string) (dto.PointsSummary, error)
	// PointsLedger 积分流水。Operator 为真是运营（可翻全站、按 OwnerKeyword 找人）；否则只看 OwnerUserID 本人的。
	PointsLedger(ctx context.Context, query dto.PointsLedgerQuery) (dto.PointsLedgerPage, error)
	// RechargePoints 运营给使用者充积分。同一个 RequestID 只充一次。
	RechargePoints(ctx context.Context, req dto.RechargePointsRequest) (dto.PointsLedgerEntry, error)
	// ReferralOverview 分享页：邀请码（老账号第一次打开时补一个）、邀请人数、累计返现、返现比例。
	ReferralOverview(ctx context.Context, ownerUserID string) (dto.ReferralOverview, error)
	ListInvitees(ctx context.Context, ownerUserID string, offset, limit int) (dto.InviteePage, error)
	ReferralSettings(ctx context.Context) (dto.ReferralSettings, error)
	SaveReferralSettings(ctx context.Context, req dto.SaveReferralSettingsRequest) error
	// ConsumerCatalog 使用端的模型广场：在卖哪些模型、各自什么价。
	ConsumerCatalog(ctx context.Context, fallbackModels []string) (dto.ConsumerCatalog, error)
	// RecordTrackingEvent 记录受支持的位置事件；日期只取服务端时钟。
	RecordTrackingEvent(ctx context.Context, eventKey, targetKey string) error

	// ---------- 门户（未登录可见的那一面） ----------
	// PortalCatalog 门户整站要展示的东西：模型目录、额度包、单价表与统计。
	// fallbackModels 是部署方声明的模型清单，目录表为空时用它兜底。
	// 一律不带用户维度 —— 这几条路由是公开的。
	PortalCatalog(ctx context.Context, fallbackModels []string) (dto.PortalOverview, error)
	// SubmitLead 门户「联系我们」。蜜罐 + 按 IP 限流 + 字段截断都在服务端。
	SubmitLead(ctx context.Context, req dto.SubmitLeadRequest) (dto.LeadView, error)
	ListLeads(ctx context.Context, status string, offset, limit int) (dto.LeadPage, error)
	HandleLead(ctx context.Context, req dto.HandleLeadRequest) error
	ListPortalModels(ctx context.Context, listedOnly bool) ([]dto.PortalModelView, error)
	// ProviderModels 共享端的模型页：平台在卖哪些模型、跑它们各自记多少积分。
	// 只给**结算价** —— 对外价和毛利不在这条接口里，共享者拿不到也就反推不出抽成。
	ProviderModels(ctx context.Context, ownerUserID string) ([]dto.ProviderModelView, error)
	// ---------- 模型分组 ----------
	// 分组是平台在卖的那个单位：价挂在它上面，密钥选中它才签得出来，
	// 共享者加入它才接得到单，请求进来先落到一个分组上。见 modelgroup.go。
	AdminModelGroups(ctx context.Context) ([]dto.ModelGroupView, error)
	SaveModelGroup(ctx context.Context, req dto.SaveModelGroupRequest) error
	DeleteModelGroup(ctx context.Context, req dto.DeleteModelGroupRequest) error
	// ConsumerGroupOptions 使用端新建密钥时的候选分组（带对外价）。
	ConsumerGroupOptions(ctx context.Context) (dto.ConsumerGroupCatalog, error)
	// ResolveGroupPolicy 这一次请求落在哪个分组上，以及那个分组允许哪些强度、开不开快速。
	// 通用层在鉴权之后、构造单元之前调它，然后按结果改写请求体。
	ResolveGroupPolicy(ctx context.Context, caller dto.Caller, route contract.RouteKey) (contract.GroupPolicy, error)

	// ProviderModelOptions 共享设置页那两个模型框的候选项：平台已上架的模型，
	// 按厂商分组，让一条车道只看见自己那一族。不带用户维度 —— 它是平台的声明，
	// 「这台机器上有没有」由贡献自己的 availableModels 回答。
	ProviderModelOptions(ctx context.Context) ([]dto.ModelOptionGroup, error)
	SavePortalModel(ctx context.Context, req dto.SaveModelRequest) error
	DeletePortalModel(ctx context.Context, modelID string) error

	// ---------- 通道 ----------
	// Submit 放置一个工作单元。返回后单元已入队，节点随时可能领走。
	Submit(ctx context.Context, unit contract.WorkUnit) (Placement, error)
	// FirstByte 记首字节。它是失败语义的分水岭：之前可改派不计费，之后不改派。
	FirstByte(ctx context.Context, unitID string) error
	// Abandon 消费者主动断开：按已产出计费，并让节点尽快 abort 上游。
	Abandon(ctx context.Context, unitID, reason string) error
	// FailUnit 由 Hub 侧判定的失败（节点掉线、空闲超时等）收口在这里。
	FailUnit(ctx context.Context, unitID string, cause *contract.UnitError) error
	// Reassignable 报告某个单元现在还能不能改派（首字节前 + kind 幂等 + 未超次数）。
	Reassignable(ctx context.Context, unitID string) bool
	// ContributionAlive 报告承接某次请求的那台机器还在不在线。
	// relay 在首字节之前拿它兜底：节点领走单元之后失联，不会有任何人来收尾。
	ContributionAlive(ctx context.Context, cid string) bool
	// RecordHubResult 由适配器的写回器在流结束时调用，交出 Hub 自己解析到的用量
	// 与响应的结构签名。签名只在这次请求被抽中时才用得上。
	RecordHubResult(ctx context.Context, unitID string, usage contract.Metering, signature string) error
	RememberResponse(ctx context.Context, responseID, cid string) error
	// LookupResponseContribution 解析 previous_response_id 对应的贡献，供硬钉使用。
	LookupResponseContribution(ctx context.Context, responseID string) (string, bool)

	// ---------- 会话（session 原语） ----------
	OpenSession(ctx context.Context, req dto.OpenSessionRequest) (dto.SessionView, error)
	GetSession(ctx context.Context, sid string) (dto.SessionView, error)
	// AuthorizeSession 会话归属校验：会话里有业务原文，串了就是数据泄露。
	AuthorizeSession(ctx context.Context, sid, consumerKey string) error
	ListSessions(ctx context.Context, consumerKey string, limit int) ([]dto.SessionView, error)
	CloseSession(ctx context.Context, req dto.CloseSessionRequest) error
	// BeginTurn 占位一个回合并算出这次该用什么 op、要不要钉在原贡献上。
	// 同一个 seq 提交两次不重跑，直接返回已有结果。
	BeginTurn(ctx context.Context, req dto.BeginTurnRequest) (dto.TurnPlan, error)
	SessionContext(ctx context.Context, sid string, fromSeq int) (dto.SessionContextView, error)
	GetTurn(ctx context.Context, sid string, seq int) (dto.TurnView, error)
	// UnitState 只读一个单元的状态，供事件流的兜底轮询用。
	UnitState(ctx context.Context, unitID string) (contract.UnitState, error)
	// ListUnitEvents 回放一个单元已经落库的事件，供断线重连续读。
	ListUnitEvents(ctx context.Context, unitID string, fromSeq int) ([]UnitEventView, error)
	// AppendUnitEvent 由事件日志在落库时回调。
	AppendUnitEvent(ctx context.Context, unitID string, seq int, kind string, data []byte) error

	// ---------- 长任务（job 原语） ----------
	GetJob(ctx context.Context, unitID, consumerKey string) (dto.JobView, error)
	ListJobs(ctx context.Context, consumerKey, kind string, limit int) ([]dto.JobView, error)
	CancelJob(ctx context.Context, unitID, consumerKey string) error
	// RequeueStaleJobs 把租约过期的任务换一台机器重跑。job 的输入自包含且执行幂等，
	// 节点跑丢了不该让用户重新提交。
	RequeueStaleJobs(ctx context.Context, now time.Time) (int, error)

	// ---------- 控制台只读（按人，不按密钥） ----------
	// 上面那几组按 sk- 密钥授权，控制台拿的是用户令牌，中间隔着「一个人有多把密钥」。
	// 所以单独一组按 owner 过滤的接口，授权依据只有令牌里的用户 id。
	OwnedSessions(ctx context.Context, query dto.WorkloadQuery) ([]dto.SessionView, error)
	OwnedSessionContext(ctx context.Context, ownerUserID, sid string, fromSeq int) (dto.SessionContextView, error)
	OwnedCloseSession(ctx context.Context, ownerUserID, sid, reason string) error
	OwnedJobs(ctx context.Context, query dto.WorkloadQuery) ([]dto.JobView, error)
	OwnedJob(ctx context.Context, ownerUserID, jobID string) (dto.JobView, error)
	OwnedCancelJob(ctx context.Context, ownerUserID, jobID string) error
	OwnedUnitEvents(ctx context.Context, ownerUserID, unitID string, fromSeq int) ([]UnitEventView, error)
	// OwnedUsage 与 Usage 只差一处，而那一处是安全边界：统计范围由令牌决定。
	OwnedUsage(ctx context.Context, ownerUserID string, query dto.UsageQuery) (dto.UsageReport, error)
	// OwnedUsageRecords 逐笔扣费。汇总回答「这个月花了多少」，它回答
	// 「那一次为什么扣了这么多」——申诉从这里进去。
	OwnedUsageRecords(ctx context.Context, query dto.UsageRecordQuery) (dto.UsageRecordPage, error)
	ConsumerDashboard(ctx context.Context, ownerUserID string, days int) (dto.ConsumerDashboard, error)

	// ---------- 争议工单 ----------
	// 消费者与提供者互不可见，出了问题只能由平台居中裁决。
	FileDispute(ctx context.Context, req dto.FileDisputeRequest) (dto.DisputeView, error)
	OwnedDisputes(ctx context.Context, ownerUserID string, limit int) ([]dto.DisputeView, error)
	WithdrawDispute(ctx context.Context, ownerUserID, disputeID string) error
	AdminDisputes(ctx context.Context, query dto.DisputeQuery) ([]dto.DisputeView, error)
	// ResolveDispute 裁决。支持申诉会在三本账上各记一笔反向流水并扣信誉。
	ResolveDispute(ctx context.Context, req dto.ResolveDisputeRequest) (dto.DisputeView, error)

	// ---------- 产物 ----------
	SignUpload(ctx context.Context, kind, name, contentType string, size int64, ownerKey string) (contract.ArtifactRef, error)
	// SignNodeUpload 给节点签产物上传地址。对象键由 Hub 生成，不交给节点自己起名。
	SignNodeUpload(ctx context.Context, unitID, name, contentType string, size int64) (contract.ArtifactRef, error)
	SignDownload(ctx context.Context, objectKey string) (contract.ArtifactRef, error)

	// ---------- 提供者：机器上的 ai-bridge ----------
	// RequestNodeUpgrade 控制台点「升级」。指令搭在下一次心跳上下发，
	// 装不装得成由节点说了算（原则 8），这里只负责记下「该升到哪一版」。
	RequestNodeUpgrade(ctx context.Context, ownerUserID, nodeID string) (dto.NodeUpgradeView, error)
	// ReportNodeUpgrade 节点回报升级进度。返回 false 表示这条回报对应的不是当前这一次升级。
	ReportNodeUpgrade(ctx context.Context, req dto.NodeUpgradeReport) (bool, error)
	// RequestNodeTool 控制台点机器上某个本机工具（claude / codex）的「安装 / 升级」。
	// 同样是记一条指令等心跳下发；装什么包、怎么装在节点自己手里。
	RequestNodeTool(ctx context.Context, ownerUserID, nodeID, tool string) (dto.NodeToolView, error)
	// RequestNodeLogin 控制台点机器上某个工具（claude / codex）的「登录」。
	// 只是记一条待下发的指令；授权地址和短码要等机器把 CLI 的输出报回来。
	RequestNodeLogin(ctx context.Context, ownerUserID, nodeID, tool string) (dto.NodeLoginView, error)
	// SubmitNodeLoginCode 主人把浏览器里拿到的授权码粘回来，转交给那台机器。
	// 只有 claude 这条路用得上 —— codex 走设备码，机器自己轮询。
	SubmitNodeLoginCode(ctx context.Context, ownerUserID, nodeID, tool, code string) (dto.NodeLoginView, error)

	// ---------- 提供者：邀请返现 ----------
	ProviderReferral(ctx context.Context, ownerUserID string) (dto.ProviderReferralOverview, error)
	ListProviderInvitees(ctx context.Context, ownerUserID string, offset, limit int) (dto.ProviderInviteePage, error)

	// ---------- ai-bridge 的版本分发 ----------
	// BridgeManifest 下载清单：每个平台最新的那一版，加上安装脚本的地址。未登录也能取。
	BridgeManifest(ctx context.Context) (dto.BridgeReleaseManifest, error)
	// BridgeDownloadURL 真正的对象地址，供下载那一跳 302 过去。version 为空表示最新。
	BridgeDownloadURL(ctx context.Context, platform, version string) (string, error)
	// BridgeChecksum 给安装脚本校验用的 sha256 与文件名。
	BridgeChecksum(ctx context.Context, platform, version string) (string, string, error)
	ListBridgeReleases(ctx context.Context) ([]dto.BridgeReleaseView, error)
	// PublishBridgeRelease 运营上传一个安装包：算校验值、验签、写对象存储、登记。
	PublishBridgeRelease(ctx context.Context, req dto.PublishBridgeReleaseRequest) (dto.BridgeReleaseView, error)
	SetBridgeReleaseStatus(ctx context.Context, req dto.SetBridgeReleaseStatusRequest) error

	// ---------- 桌面客户端（Nova / Orbit）的版本分发 ----------
	//
	// 只有运营这三条。客户端那一侧走 electron-updater，直接读 OSS 上公开读目录里的
	// 清单，**不经过服务端的任何接口** —— 所以这里没有「取更新」那种方法。
	ListDesktopReleases(ctx context.Context) (dto.DesktopReleasePage, error)
	// PrepareDesktopRelease 第一步：收下 electron-builder 出的清单，登记这一版，回几个直传地址。
	PrepareDesktopRelease(ctx context.Context, req dto.PrepareDesktopReleaseRequest) (dto.DesktopReleaseUpload, error)
	// PublishDesktopRelease 第二步：确认包真的在对象存储上了，再把清单发出去。
	PublishDesktopRelease(ctx context.Context, req dto.PublishDesktopReleaseRequest) (dto.DesktopReleaseView, error)
	// SetDesktopReleaseStatus 下架 / 重新上架。改的是「对外那份清单指向谁」，不删包。
	SetDesktopReleaseStatus(ctx context.Context, req dto.SetDesktopReleaseStatusRequest) error

	// ---------- 平台运营（manager 后台） ----------
	AdminNodes(ctx context.Context, limit int) ([]dto.AdminNodeView, error)
	// BanNode 平台封禁。和主人自己撤销的区别：封禁主人解不开。
	BanNode(ctx context.Context, req dto.BanNodeRequest) error
	// SetProviderType 把账号设成工作室 / 改回散户。注册默认是散户，只有管理端能改。
	SetProviderType(ctx context.Context, req dto.SetProviderTypeRequest) error
	AdminProbes(ctx context.Context, cid string, limit int) ([]dto.AuditProbeView, error)
	AdminUsage(ctx context.Context, query dto.UsageQuery) (dto.UsageReport, error)

	// ---------- 平台运营：提现审批 ----------
	// 积分在申请那一刻就扣走了，单子停在 pending 等于钱既不在用户手上也没打出去 ——
	// 这三个方法是那笔钱唯一的出口。
	AdminPayouts(ctx context.Context, query dto.AdminPayoutQuery) (dto.AdminPayoutPage, error)
	// HandlePayout 打款完成 / 驳回。驳回会把积分原路退回并记一笔反向流水。
	HandlePayout(ctx context.Context, req dto.HandlePayoutRequest) (dto.AdminPayoutView, error)
	// RevealPayoutAccount 收款账号明文。列表里只给打码的，真要打款时单独取一次。
	RevealPayoutAccount(ctx context.Context, payoutID string) (dto.PayoutAccountView, error)

	// ---------- 平台运营：总览与排障 ----------
	// AdminOverview 「今天要做什么」：各页的待办计数一次取回。
	AdminOverview(ctx context.Context) (dto.AdminOverview, error)
	// AdminDashboard 「今天做成了什么」：登录、在线机器、用量与金额、进账、算力剩余。
	// 和上面那个是两页：一个数待办，一个数经营。
	AdminDashboard(ctx context.Context) (dto.AdminDashboard, error)
	// AdminMismatches 用量偏差。这张表此前只写不读 —— 落了行，没人看得见。
	AdminMismatches(ctx context.Context, query dto.MismatchQuery) (dto.MismatchPage, error)
	// AdminUnits 跨租户的运行工单，排障用。按人查的那条在 OwnedJobs。
	AdminUnits(ctx context.Context, query dto.AdminUnitQuery) (dto.AdminUnitPage, error)
	// AdminCancelUnit 强制取消一条还在跑的工单。取消是请求不是命令（原则 8）。
	AdminCancelUnit(ctx context.Context, req dto.CancelUnitRequest) error

	// ---------- 平台运营：运行参数 ----------
	// 原本只在 application.properties 里的那批可调值。改完按 TTL 在各进程生效，
	// 不用重启 —— 见 settings.go。部署事实（地址、密钥、契约版本）不在其中。
	AdminSettings(ctx context.Context) (dto.AdminSettingsPage, error)
	// SaveAdminSetting 改一项，或把它改回配置文件里的默认值。
	SaveAdminSetting(ctx context.Context, req dto.SaveSettingRequest) error

	// ---------- 平台运营：三本账 ----------
	// AdminLedger 逐笔流水。结算汇总回答「这个月一共多少」，它回答「那一笔怎么记的」。
	// 平台侧那本账此前完全没有读的路 —— 毛利与坏账一直在写，没人看得见。
	AdminLedger(ctx context.Context, query dto.AdminLedgerQuery) (dto.AdminLedgerPage, error)

	// ---------- 平台运营：邀请返现与信誉 ----------
	// AdminReferrals 两端的邀请关系与拉人排行。此前只有一个「默认比例」开关，
	// 返出去的钱一分都看不见 —— 一个开着的活动，钱在流出而没人看得见流向。
	AdminReferrals(ctx context.Context, query dto.AdminReferralQuery) (dto.AdminReferralPage, error)
	// AdminReputations 分数没满的主体。按此刻的分数筛，不是按库里那个结算值。
	AdminReputations(ctx context.Context, threshold float64, limit int) (dto.ReputationPage, error)
	// SetReputation 人工设定一个主体的信誉。设成，不是加减。
	SetReputation(ctx context.Context, req dto.SetReputationRequest) error

	// ---------- 平台运营：订单 ----------
	// PayOrder（人工确认到账）一直都在，但没有任何地方列得出订单 ——
	// 运营手上是一个渠道流水号，而那条接口要的是单号，两者之间没有桥。
	AdminOrders(ctx context.Context, query dto.AdminOrderQuery) (dto.AdminOrderPage, error)

	// ---------- 平台运营：封禁名单 ----------
	// 封禁记在设备指纹上，而 BanNode 是按 node_id 找机器的 —— 机器不在了，
	// 那个指纹就再也没有入口碰得到。这两个方法是它唯一的去处。
	AdminBannedMachines(ctx context.Context, bannedOnly bool, limit int) ([]dto.BannedMachineView, error)
	// BanMachine 按指纹封禁 / 解封，机器在不在册都办得了。
	BanMachine(ctx context.Context, req dto.BanMachineRequest) error

	// ---------- 平台运营：价目表 ----------
	// 没有价可查时扣费与分成静默算 0，所以这张表必须在管理端维护得动，
	// 而且要把「有用量却没有价」的单位直接列出来。
	AdminPrices(ctx context.Context) (dto.PriceTableView, error)
	SaveAdminPrice(ctx context.Context, req dto.SavePriceRequest) error
	DeleteAdminPrice(ctx context.Context, req dto.DeletePriceRequest) error

	// ---------- 运维 ----------
	PoolStatus(ctx context.Context) (dto.PoolStatus, error)
	Sweep(ctx context.Context) error
	// RunProbes 跑一批待比对的抽检。定时任务调用，不在请求路径上。
	RunProbes(ctx context.Context, limit int) (int, error)
	// SeedPrices 写入某个 kind 的「单位 → 单价」表：prices 对外收，providerPrices 结算给共享者。
	// 定价是运营动作，由初始化命令调用。
	SeedPrices(ctx context.Context, kind string, prices, providerPrices map[contract.MeterUnit]int64) error
}

// Ports 是共享池核心的全部外部依赖。做成一个结构体而不是一串参数：
// 这些东西会随业务增加（抽检、指标、通知都是后来加的），一个个往参数表里塞
// 会让每次扩展都变成一次全量改调用点。
type Ports struct {
	Control  ControlPlane
	Signer   ObjectSigner
	Notifier ProviderNotifier
	// Replayer 没配时抽检整体关闭：宁可不查，也不能拿被查者的凭据查出个假结论。
	Replayer ShadowReplayer
	Audit    AuditConfig
	// Metrics 没接监控时留空，走无操作实现。
	Metrics Metrics
	// Uploader 只有管理端装配它：上传 ai-bridge 安装包是运营动作，
	// galaxy-api 上没有任何路径需要往对象存储里写整个文件。
	Uploader ObjectUploader
	// Desktop 同样只有管理端装配：桌面客户端发版是运营动作。
	// 客户端自己**不经过任何接口**取更新，它直接读 OSS 上那个公开读目录里的清单。
	Desktop DesktopStore
}

type service struct {
	repository *repository.GalaxyRepository
	control    ControlPlane
	signer     ObjectSigner
	// uploader 只有管理端进程装配，其余进程是 nil：上传安装包是运营动作。
	uploader ObjectUploader
	// desktop 同上：桌面客户端发版只在管理端做。
	desktop  DesktopStore
	notifier ProviderNotifier
	replayer ShadowReplayer
	audit    AuditConfig
	metrics  Metrics
	kinds    *KindRegistry
	// config 是**配置文件给的那份**，只当默认值用。
	// 读参数一律走 cfg() —— 它叠加了后台改过的项，见 settings.go。
	config Config
	// settings 后台可调参数的进程内快照。用指针是为了让事务里的那个副本
	// （scopedTo）和本体共用同一份 —— 副本自己再去查一遍，那次查询会落在
	// 正开着的事务里。
	settings *settingsCache
	// cipher 加密存储密钥明文。没配 KeyCipherSecret 时是 nil，取回明文的接口会明说原因。
	cipher *keyCipher
	// groupCache 模型分组的进程内快照。每一次中转都要解「这一单落哪个分组」，
	// 按条查库就是把同一张小表查成每秒几十次。见 modelgroup.go。
	groupCache *groupCache
	// hardPinFallbacks 与 settings 一样用指针：事务里的 scoped service 是浅拷贝，
	// 必须和本体共享这份「旧会话可以迁移」的短期状态。
	hardPinFallbacks *hardPinFallbacks

	// waiting 是等待队列深度的进程内计数。P0 单实例，等待发生在持有消费者连接的
	// 那个进程里，不需要把 rid 放进 Redis 再被别人唤醒。
	waiting struct {
		sync.Mutex
		byKind map[string]int
	}
}

// New 装配共享池核心。Signer 与 Notifier 可以为 nil：
// 没接 OSS 时产物接口返回明确错误，没接通知时预警只落库。
func New(database *gorm.DB, ports Ports, kinds *KindRegistry, config Config) Service {
	repo := &repository.GalaxyRepository{}
	repo.SetDb(database)
	if kinds == nil {
		kinds = NewKindRegistry()
	}
	audit := ports.Audit
	if audit.Ratio <= 0 && audit.DailyCap == 0 {
		audit = DefaultAuditConfig()
	}
	// 抽检比例封在 1%：这是对提供者的承诺，不是可调到 100% 的开关。
	if audit.Ratio > 0.01 {
		audit.Ratio = 0.01
	}
	metrics := ports.Metrics
	if metrics == nil {
		metrics = noopMetrics{}
	}
	svc := &service{
		metrics:          metrics,
		repository:       repo,
		control:          ports.Control,
		signer:           ports.Signer,
		uploader:         ports.Uploader,
		desktop:          ports.Desktop,
		notifier:         ports.Notifier,
		replayer:         ports.Replayer,
		audit:            audit,
		kinds:            kinds,
		config:           config.withDefaults(),
		settings:         &settingsCache{},
		groupCache:       &groupCache{},
		hardPinFallbacks: &hardPinFallbacks{until: map[string]time.Time{}},
		cipher:           newKeyCipher(config.KeyCipherSecret),
	}
	svc.waiting.byKind = map[string]int{}
	return svc
}

// Migrate 建表。与 delivery 一致，由显式的初始化命令调用，不在进程启动时跑。
func Migrate(database *gorm.DB) error {
	repo := &repository.GalaxyRepository{}
	repo.SetDb(database)
	return repo.AutoMigrate()
}

func (s *service) Kinds() []contract.KindSpec { return s.kinds.List() }

// Config 当前生效的参数，**含后台改过的那些**。
// 回 s.config（配置文件那份）会让门户和控制台显示一套和实际执行不一样的值。
func (s *service) Config() Config { return s.cfg() }

const bizLine = string(contract.GalaxyBizLine)

func notFound(err error) bool { return errors.Is(err, gorm.ErrRecordNotFound) }

func splitList(value string) []string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
