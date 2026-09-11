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
	BindIdleTTL       time.Duration
	SpillWait         time.Duration
	MaxWait           time.Duration
	HeartbeatTimeout  time.Duration
	BodyTTL           time.Duration
	MaxPlaceAttempts  int
	Weights           ScoreWeights

	// 密钥有效期与冻结期。
	KeyTTL         time.Duration
	KeyFreeze      time.Duration
	KeyConcurrency int
	KeyRPM         int

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

	// UsageMismatchRatio 节点自报与 Hub 解析的偏差告警阈值。
	UsageMismatchRatio float64

	// ReputationRecoveryPerDay 机器信誉每天回升多少，封顶 1。
	ReputationRecoveryPerDay float64

	PresignPutTTL time.Duration
	PresignGetTTL time.Duration

	// SessionIdleTTL 会话多久没有新回合就自动关闭并释放座位。
	SessionIdleTTL time.Duration

	// PayoutRate 多少积分兑一块钱。默认 100 —— 界面上的「≈ ¥12.84」就是按它折的，
	// 折算口径只有这一处，前端不自己乘。
	PayoutRate int
	// PayoutMinCredits 单次提现的起提积分。低于它的申请直接拒 ——
	// 一笔一块钱的提现，人工处理成本远高于金额本身。
	PayoutMinCredits int64
	// PayoutHoldDays 争议期。这段时间内结算的积分算「待结算」，提不出来。
	PayoutHoldDays int

	// PortalAvailability 门户上那句可用性承诺（例如 "99.9%"）。
	//
	// 它是**部署方的承诺**，不是算出来的指标 —— 所以没配就是空串，门户那一格
	// 直接不显示。默认给一个好看的数字等于替部署方许了一个他没许的诺。
	PortalAvailability string
}

func DefaultConfig() Config {
	return Config{
		ContractVersion:          1,
		PlatformSeatLimit:        10,
		BindIdleTTL:              30 * time.Minute,
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
		PayoutRate:               100,
		PayoutMinCredits:         1000,
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
	SetContributionStatus(ctx context.Context, ownerUserID, nodeID, cid, status string) error
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
	IssueKey(ctx context.Context, req dto.IssueKeyRequest) (dto.IssuedKeyView, error)
	AuthenticateKey(ctx context.Context, secret string) (dto.Caller, error)
	DescribeKey(ctx context.Context, keyID string) (dto.ConsumerKeyView, error)
	ListKeys(ctx context.Context, ownerUserID string) ([]dto.ConsumerKeyView, error)
	RevokeKey(ctx context.Context, ownerUserID, keyID string) error
	// RenewKey 续期换发：新密钥继承余额与允许范围，旧密钥立刻作废。
	RenewKey(ctx context.Context, req dto.RenewKeyRequest) (dto.IssuedKeyView, error)
	Usage(ctx context.Context, query dto.UsageQuery) (dto.UsageReport, error)

	// ---------- 额度商品与订单（P1） ----------
	ListPackages(ctx context.Context, listedOnly bool) ([]dto.PackageView, error)
	SavePackage(ctx context.Context, req dto.SavePackageRequest) error
	CreateOrder(ctx context.Context, req dto.CreateOrderRequest) (dto.OrderView, error)
	// PayOrder 支付回调。重放安全：同一订单只履约一次。
	PayOrder(ctx context.Context, req dto.PayOrderRequest) (dto.OrderView, error)
	// PayOrderByCallback 支付渠道回调这条路：先验签，再核对金额，最后才履约。
	// 没配 PaymentVerifier 时直接拒绝 —— 不验签的回调等于把发额度的权限挂在公网上。
	PayOrderByCallback(ctx context.Context, callback PaymentCallback) (dto.OrderView, error)
	// PaymentEnabled 说明这套部署有没有可接收外部回调的已验签渠道，
	// 供路由决定要不要挂回调。沙箱渠道不算数。
	PaymentEnabled() bool
	// PaymentChannels 这套部署接了哪些渠道，供控制台渲染收银台。
	PaymentChannels() []PaymentChannel
	// PaySandbox 沙箱支付：没有收银台可验签，靠「渠道被显式标成沙箱 + 订单是本人的」
	// 两道闸兜住。真渠道一律走 PayOrderByCallback。
	PaySandbox(ctx context.Context, req dto.PaySandboxRequest) (dto.OrderView, error)
	ListOrders(ctx context.Context, userID string, limit int) ([]dto.OrderView, error)
	CancelOrder(ctx context.Context, userID, orderID string) error

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

	// ---------- 平台运营（manager 后台） ----------
	AdminNodes(ctx context.Context, limit int) ([]dto.AdminNodeView, error)
	// BanNode 平台封禁。和主人自己撤销的区别：封禁主人解不开。
	BanNode(ctx context.Context, req dto.BanNodeRequest) error
	// SetProviderType 把账号设成工作室 / 改回散户。注册默认是散户，只有管理端能改。
	SetProviderType(ctx context.Context, req dto.SetProviderTypeRequest) error
	AdminProbes(ctx context.Context, cid string, limit int) ([]dto.AuditProbeView, error)
	AdminUsage(ctx context.Context, query dto.UsageQuery) (dto.UsageReport, error)

	// ---------- 运维 ----------
	PoolStatus(ctx context.Context) (dto.PoolStatus, error)
	Sweep(ctx context.Context) error
	// RunProbes 跑一批待比对的抽检。定时任务调用，不在请求路径上。
	RunProbes(ctx context.Context, limit int) (int, error)
	// SeedPrices 写入某个 kind 的「单位 → 单价」表。定价是运营动作，由初始化命令调用。
	SeedPrices(ctx context.Context, kind string, prices map[contract.MeterUnit]int64, providerShare float64) error
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
	// Payment 没配时支付回调接口整体关闭（内测期只有管理员手工确认到账这条路）。
	// 不验签的回调等于把发额度的权限挂在公网上。
	Payment PaymentVerifier
}

type service struct {
	repository *repository.GalaxyRepository
	control    ControlPlane
	signer     ObjectSigner
	notifier   ProviderNotifier
	replayer   ShadowReplayer
	payment    PaymentVerifier
	audit      AuditConfig
	metrics    Metrics
	kinds      *KindRegistry
	config     Config

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
		metrics:    metrics,
		repository: repo,
		control:    ports.Control,
		signer:     ports.Signer,
		notifier:   ports.Notifier,
		replayer:   ports.Replayer,
		payment:    ports.Payment,
		audit:      audit,
		kinds:      kinds,
		config:     config.withDefaults(),
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
func (s *service) Config() Config             { return s.config }

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
