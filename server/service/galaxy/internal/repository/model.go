// Package repository 只能被 service/galaxy 目录树引用（Go internal 规则）。
//
// zt_galaxy_* 全部表的写入口都在这个包里，因此「共享池数据只由 galaxy 层写」
// 是编译期事实而非约定。
//
// 三条铁律照 server/SCHEMA.md：跨层不建外键；跨层引用用字符串业务键；
// 每张表带 biz_line 且所有索引以它打头。共享池按平台维度运行，池内表的
// biz_line 固定为 galaxy（决策 D-05）。
package repository

// 时间列一律写 `type:timestamp null default null`。
//
// `;null` 是个空写法：GORM 不认识这个标签元素，发出去的 DDL 里没有 NULL。而 MySQL 在
// explicit_defaults_for_timestamp=OFF 时（5.7 默认，8.x 也可能被配成这样）会对没有显式
// NULL / DEFAULT 的 TIMESTAMP 列做两件事：
//
//   每张表的第一个   → 静默补上 NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
//   第二个及以后     → 补上 DEFAULT '0000-00-00'，被 NO_ZERO_DATE 拒绝，建表直接报 1067
//
// 报错那半反而是好事，静默那半才要命：zt_galaxy_price.effective_from 在唯一键里，
// 一旦带上 ON UPDATE，任何一次 UPDATE 都会改写它，定价历史当场就乱了。
//
// **光写 `null` 压不住它。** 这是踩过之后补上的：`type:timestamp null` 建出来的列
// 实测仍然是 null=NO、default=CURRENT_TIMESTAMP、extra="on update CURRENT_TIMESTAMP"
// —— MySQL 对每张表第一个 TIMESTAMP 列的这条隐式规则，只有显式给 DEFAULT 才能关掉。
// 症状是 zt_galaxy_node.last_beat_at 被 sweep 的 UPDATE 顺手刷新，
// 界面上出现「离线，最近心跳 51 秒前」这种自相矛盾的一行。
// 已经建好的库要跑 server/migrations/20260908_timestamp_no_auto_update.sql 修回来。

import "time"

// GalaxyNode 一台提供者机器。token 只存 sha256，明文在配对那一刻返回一次。
type GalaxyNode struct {
	ID      int64  `gorm:"column:id;primaryKey;autoIncrement" description:"主键"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_node_id,priority:1;index:idx_gx_node_owner,priority:1;index:idx_gx_node_token,priority:1;index:idx_gx_node_fingerprint,priority:1" description:"业务线，池内固定 galaxy"`
	NodeID  string `gorm:"column:node_id;type:varchar(64);uniqueIndex:uk_gx_node_id,priority:2" description:"节点业务键"`

	OwnerUserID string `gorm:"column:owner_user_id;type:varchar(64);index:idx_gx_node_owner,priority:2" description:"提供者用户标识"`
	DisplayName string `gorm:"column:display_name;type:varchar(128)" description:"主人给机器起的名字"`
	// TokenHash 是 node token 的 sha256 十六进制。撤销即置空，节点下次请求 401。
	TokenHash       string `gorm:"column:token_hash;type:varchar(64);index:idx_gx_node_token,priority:2" description:"节点令牌 sha256"`
	BridgeVersion   string `gorm:"column:bridge_version;type:varchar(32)" description:"ai-bridge 版本"`
	ContractVersion int    `gorm:"column:contract_version" description:"节点声明的契约版本"`

	// BridgePlatform / BridgeDistribution / UpgradeBlocker 是节点在 hello 里自报的
	// 「我是什么、能不能被远程升级」。老版本节点不报，三个都是空串 —— 那种机器
	// 只能手动装一次新版，控制台上的升级按钮会说清楚这一点。
	BridgePlatform     string `gorm:"column:bridge_platform;type:varchar(32)" description:"节点自报的平台名，如 linux-x64"`
	BridgeDistribution string `gorm:"column:bridge_distribution;type:varchar(16)" description:"cli=独立部署的命令行，能自升级；nova=随 Nova 应用分发"`
	// UpgradeBlocker 节点自己算出来的「此刻为什么升不了」（没内置发布公钥、
	// 可执行文件所在目录不可写……）。人话，控制台原样展示 —— 让主人在点之前
	// 就看到原因，比点完等三分钟再看到一条失败强。
	UpgradeBlocker string `gorm:"column:upgrade_blocker;type:varchar(255)" description:"节点自报的不能远程升级的原因，空表示可以"`

	// 最近一次远程升级。同一台机器同时只有一次升级在跑，所以挂在节点这一行上
	// 而不是单开一张指令表：心跳本来就要读这一行，挂上去不多一次查询。
	UpgradeID          string     `gorm:"column:upgrade_id;type:varchar(40)" description:"升级指令 id，节点按它回报，对不上的回报一律忽略"`
	UpgradeVersion     string     `gorm:"column:upgrade_version;type:varchar(32)" description:"这次升级的目标版本"`
	UpgradeFromVersion string     `gorm:"column:upgrade_from_version;type:varchar(32)" description:"发起时机器上的版本"`
	UpgradeStatus      string     `gorm:"column:upgrade_status;type:varchar(16)" description:"pending/downloading/installing/restarting/succeeded/failed"`
	UpgradeMessage     string     `gorm:"column:upgrade_message;type:varchar(255)" description:"说明或失败原因，人话，直接展示"`
	UpgradeRequestedAt *time.Time `gorm:"column:upgrade_requested_at;type:timestamp null default null" description:"控制台点「升级」的时刻"`
	UpgradeUpdatedAt   *time.Time `gorm:"column:upgrade_updated_at;type:timestamp null default null" description:"升级状态最近一次变化的时刻"`

	// AccessMode 这台机器和 Hub 之间是怎么通信的：
	//   poll   节点长轮询领活，Hub 永不主动连它（可视化客户端唯一支持的方式）
	//   export 节点把自己暴露在公网上，Hub 拿 endpoint + secret 主动回连
	// 它是**传输层**属性，所以挂在节点上而不是贡献上：一台机器上的所有贡献必然共用同一条通道。
	AccessMode string `gorm:"column:access_mode;type:varchar(16);default:poll" description:"poll=节点长轮询领活；export=Hub 回连节点公网地址"`
	// EndpointURL export 模式下 Hub 回连的公网基地址（http(s)://host:port）。
	EndpointURL string `gorm:"column:endpoint_url;type:varchar(255)" description:"export：Hub 回连的公网基地址"`
	// EndpointSecret 回连密钥，**明文**。
	//
	// 与 TokenHash 存哈希的方向正好相反，因为这里 Hub 是**客户端**：它要把这串东西
	// 出示给节点，存哈希就永远出示不出来。所以它绝不能出现在任何对外视图、日志或
	// 错误信息里 —— 视图里给的是掩码，见 dto.NodeView.EndpointMasked。
	EndpointSecret string `gorm:"column:endpoint_secret;type:varchar(128)" description:"export：回连密钥明文，Hub 出示给节点"`
	// EndpointStatus 最近一次回连的结果。ok / unreachable，没探过是空串。
	EndpointStatus    string     `gorm:"column:endpoint_status;type:varchar(16)" description:"export：最近一次回连探测结果"`
	EndpointError     string     `gorm:"column:endpoint_error;type:varchar(255)" description:"export：最近一次回连失败的原因"`
	EndpointCheckedAt *time.Time `gorm:"column:endpoint_checked_at;type:timestamp null default null" description:"export：最近一次回连探测时刻"`

	ResourcesJSON string `gorm:"column:resources_json;type:text" description:"探测到的本机资源，仅供放置的资源需求过滤"`

	// MachineFingerprint 节点侧算的设备指纹（sha256 十六进制），Hub 看不到原始硬件 id。
	// 工作室的信誉按它记（见 GalaxyReputation）。老版本节点不报，空着；只补不改，见 FillNodeFingerprint。
	// 平台封禁也按它记（见 GalaxyMachineBan），索引是给封禁时按设备改节点行用的。
	MachineFingerprint string `gorm:"column:machine_fingerprint;type:varchar(64);index:idx_gx_node_fingerprint,priority:2" description:"设备指纹 sha256，工作室的信誉跟着它走"`

	Status     string     `gorm:"column:status;type:varchar(16);index:idx_gx_node_owner,priority:3" description:"active/offline/revoked"`
	Banned     bool       `gorm:"column:banned;default:false" description:"平台封禁"`
	LastBeatAt *time.Time `gorm:"column:last_beat_at;type:timestamp null default null" description:"最近一次心跳"`
	// OnlineSince 本轮连续在线的起点。掉线降级后再上来会重新记 ——
	// 「已连续共享 6 天」要是把中间断掉的两天也算进去，那句话就是假的。
	OnlineSince *time.Time `gorm:"column:online_since;type:timestamp null default null" description:"本轮连续在线起点"`

	CreatedTime time.Time `gorm:"column:created_time;autoCreateTime" description:"创建时间"`
	UpdatedTime time.Time `gorm:"column:updated_time;autoUpdateTime" description:"更新时间"`
}

func (r *GalaxyNode) TableName() string { return "zt_galaxy_node" }
func (r *GalaxyNode) Init()             {}

// 账号的两端。和 dto.SideProvider / dto.SideConsumer 是同一组值，这里各写一份：
// repository 不依赖 dto，反过来让 dto 依赖持久化层更不合适。
const (
	SideProvider = "provider"
	SideConsumer = "consumer"
)

// GalaxyUser Galaxy 自己的账号。和任务宇宙的 zt_identity_user 没有任何关系：
// 不同的表、不同的令牌，谁也不认识谁。
//
// 共享端（提供者，用 Nova）和使用端（消费者，用 Orbit）是两批人，**库里也是两张表**：
// GalaxyProviderUser / GalaxyConsumerUser。两端账号的列一模一样，所以只有这一份定义，
// 那两个类型由它派生；这个类型自己不对应任何一张表，落到哪张表由 Side 决定。
//
// 分表不是为了两套读法，是为了两端在库里没有交集：不会再有「漏写 side 条件」的查询
// 把另一端的人捞出来，用户名在一端内唯一也不用靠复合索引里的 side 撑着。
//
// UserID 照旧带端的前缀（pu_ / cu_）：池内表的 owner_user_id / user_id / provider_user_id
// 是一列混着两端的引用（争议表两端都记），前缀让人一眼看出这一行说的是谁。
//
// 散户 / 工作室不在账号表上，在 GalaxyProvider：那是只有共享端才有、只由运营改的属性。
type GalaxyUser struct {
	ID      int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_user_id,priority:1;uniqueIndex:uk_gx_user_name,priority:1;index:idx_gx_user_status,priority:1"`
	UserID  string `gorm:"column:user_id;type:varchar(40);uniqueIndex:uk_gx_user_id,priority:2" description:"账号业务键，共享端 pu_…，使用端 cu_…"`
	// Side 不是库里的一列 —— 它由这一行来自哪张表决定，读出来时由 repository 填上。
	Side string `gorm:"-" description:"provider=共享端；consumer=使用端"`
	// Username 存小写。唯一性按表算：两端是两张表，同名各是各的人。
	Username     string `gorm:"column:username;type:varchar(64);uniqueIndex:uk_gx_user_name,priority:2" description:"登录名，小写，本端内唯一"`
	DisplayName  string `gorm:"column:display_name;type:varchar(128)"`
	PasswordHash string `gorm:"column:password_hash;type:varchar(255)" description:"bcrypt"`
	Status       string `gorm:"column:status;type:varchar(16);index:idx_gx_user_status,priority:2" description:"active/disabled"`
	// MustChangePassword 运营重置过密码的账号为真：改掉之前只能调 me 和改密码。
	MustChangePassword bool `gorm:"column:must_change_password;default:false"`
	// TokenVersion 签进令牌里。改密码、重置、停用都加一，已经发出去的令牌当场作废。
	TokenVersion int        `gorm:"column:token_version;default:1"`
	LastLoginAt  *time.Time `gorm:"column:last_login_at;type:timestamp null default null"`
	// UpdatedBy 最近一次由运营处置（停用、启用、重置密码）的管理端账号。本人改密码不写。
	UpdatedBy string `gorm:"column:updated_by;type:varchar(64)" description:"最近一次处置这个账号的管理端账号"`

	CreatedTime time.Time `gorm:"column:created_time;autoCreateTime"`
	UpdatedTime time.Time `gorm:"column:updated_time;autoUpdateTime"`
}

// GalaxyProviderUser 共享端（Nova）的账号表。
//
// 写成 GalaxyUser 的派生类型而不是嵌一层：底层类型相同，两者可以直接互转，
// 上层构造和读取用的都还是 GalaxyUser，只有 repository 在贴着库的那一层认这两个类型。
type GalaxyProviderUser GalaxyUser

func (r *GalaxyProviderUser) TableName() string { return "zt_galaxy_provider_user" }
func (r *GalaxyProviderUser) Init()             {}

// GalaxyConsumerUser 使用端（Orbit）的账号表。
type GalaxyConsumerUser GalaxyUser

func (r *GalaxyConsumerUser) TableName() string { return "zt_galaxy_consumer_user" }
func (r *GalaxyConsumerUser) Init()             {}

// GalaxyProvider 共享端账号的身份：散户 / 工作室。OwnerUserID 是 GalaxyUser.UserID（pu_…）。
//
// 没有行就是散户 —— 注册出来默认是散户，不必预先插一条。只有管理端把账号设成工作室
// （或者再改回散户）时才有行。
type GalaxyProvider struct {
	ID          int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine     string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_provider_owner,priority:1"`
	OwnerUserID string `gorm:"column:owner_user_id;type:varchar(64);uniqueIndex:uk_gx_provider_owner,priority:2" description:"提供者用户标识"`
	// ProviderType individual=散户（信誉跟着账号走）；studio=工作室（信誉跟着设备走）。
	ProviderType string `gorm:"column:provider_type;type:varchar(16)" description:"individual=散户，信誉跟着账号；studio=工作室，信誉跟着设备"`
	// UpdatedBy 最近一次改身份的管理端账号，取自凭证。
	UpdatedBy string `gorm:"column:updated_by;type:varchar(64)" description:"最近一次改身份的管理端账号"`

	CreatedTime time.Time `gorm:"column:created_time;autoCreateTime"`
	UpdatedTime time.Time `gorm:"column:updated_time;autoUpdateTime"`
}

func (r *GalaxyProvider) TableName() string { return "zt_galaxy_provider" }
func (r *GalaxyProvider) Init()             {}

// GalaxyReputation 一份信誉记录。主体有三种：
//
//	account:<ownerUserId>  账号 —— 散户读这一份
//	device:<设备指纹>       设备 —— 工作室读这一份
//	node:<nodeId>          没报指纹的老节点，当设备用
//
// 扣分同时记在账号和设备上，读哪一份看账号当下的身份。所以管理端改身份不会让分数清零：
// 另一份一直在记。
//
// 行只在第一次扣分时建：没有行就是满分。
type GalaxyReputation struct {
	ID      int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_reputation_subject,priority:1"`
	Subject string `gorm:"column:subject;type:varchar(96);uniqueIndex:uk_gx_reputation_subject,priority:2" description:"account:<账号> / device:<设备指纹> / node:<nodeId>"`

	// Reputation 是 ReputationAt 那一刻的分数，此刻的分数按回升速率现算（galaxy.EffectiveReputation）。
	// **不要加 default 标签**：扣到 0 时 GORM 会把这一列从 INSERT 里省掉，数据库默认值把它写回满分。
	Reputation   float64   `gorm:"column:reputation" description:"信誉分 0..1，截至 reputation_at；此后按天回升"`
	ReputationAt time.Time `gorm:"column:reputation_at;type:timestamp null default null" description:"reputation 的结算时刻"`

	CreatedTime time.Time `gorm:"column:created_time;autoCreateTime"`
	UpdatedTime time.Time `gorm:"column:updated_time;autoUpdateTime"`
}

func (r *GalaxyReputation) TableName() string { return "zt_galaxy_reputation" }
func (r *GalaxyReputation) Init()             {}

// GalaxyMachineBan 平台对一台设备的封禁，按设备指纹记，和提供者是散户还是工作室无关。
//
// 不能只记在节点记录上：每配一次对就是一个新 nodeId，被封的机器解绑重配、换个账号去配，
// 回来的就是一条干净的记录。请求路径看的仍然是 GalaxyNode.Banned —— 封禁 / 解封时把带这个指纹的
// 节点一起改（SetMachineBanned），新配出来的记录在 hello 报上指纹时补标（BanNodeIfMachineBanned）。
//
// 解封不删行，Banned 改回 false：谁、为什么封过要查得到。
type GalaxyMachineBan struct {
	ID                 int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine            string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_machine_ban_fingerprint,priority:1"`
	MachineFingerprint string `gorm:"column:machine_fingerprint;type:varchar(64);uniqueIndex:uk_gx_machine_ban_fingerprint,priority:2" description:"设备指纹 sha256，同 zt_galaxy_node.machine_fingerprint"`

	// Banned 不加 default 标签：每次写入都带着明确的值，而 GORM 插入时会把零值换成 default 的值 ——
	// 解封写的恰恰是零值 false，默认值一旦不是 false，解封就被写成了别的。
	Banned bool `gorm:"column:banned" description:"是否封禁中；解封改回 false，不删行"`
	// Reason / UpdatedBy 记的是最近一次操作，封禁和解封都会覆盖。UpdatedBy 取自凭证。
	Reason    string `gorm:"column:reason;type:varchar(255)" description:"最近一次封禁 / 解封填的原因"`
	UpdatedBy string `gorm:"column:updated_by;type:varchar(64)" description:"最近一次操作的管理端账号"`

	CreatedTime time.Time `gorm:"column:created_time;autoCreateTime"`
	UpdatedTime time.Time `gorm:"column:updated_time;autoUpdateTime"`
}

func (r *GalaxyMachineBan) TableName() string { return "zt_galaxy_machine_ban" }
func (r *GalaxyMachineBan) Init()             {}

// GalaxyPairingCode 一次性配对码。只对已记录当前条款版本同意的提供者签发（P-16）。
type GalaxyPairingCode struct {
	ID      int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_pairing_code,priority:1;index:idx_gx_pairing_owner,priority:1"`
	Code    string `gorm:"column:code;type:varchar(32);uniqueIndex:uk_gx_pairing_code,priority:2" description:"配对码明文，10 分钟有效"`

	OwnerUserID  string     `gorm:"column:owner_user_id;type:varchar(64);index:idx_gx_pairing_owner,priority:2"`
	TermsVersion string     `gorm:"column:terms_version;type:varchar(32)" description:"签发时的条款版本，pair 时再校验一次"`
	ExpiresAt    time.Time  `gorm:"column:expires_at;type:timestamp null default null" description:"过期时刻"`
	ConsumedAt   *time.Time `gorm:"column:consumed_at;type:timestamp null default null" description:"被兑换的时刻，非空即失效"`
	NodeID       string     `gorm:"column:node_id;type:varchar(64)" description:"兑换出的节点"`
	CreatedTime  time.Time  `gorm:"column:created_time;autoCreateTime"`
}

func (r *GalaxyPairingCode) TableName() string { return "zt_galaxy_pairing_code" }
func (r *GalaxyPairingCode) Init()             {}

// GalaxyProviderKey 提供者接入密钥。单独部署的 rust bridge 用它自助注册节点。
//
// 为什么不复用配对码：配对码是一次性的、10 分钟有效，前提是「有个人正看着两块屏幕」。
// 放在机房里的机器没有这个人 —— 它重启一次就得有人值班去点一下「生成配对码」，
// 那种接入方式对无人值守的部署根本不成立。接入密钥是长期的，写进那台机器的配置里，
// 它自己起来就能重新注册。
//
// 明文只在签发那一刻返回一次，库里存 sha256，与算力密钥同一套做法。
type GalaxyProviderKey struct {
	ID      int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_provider_key_id,priority:1;uniqueIndex:uk_gx_provider_key_hash,priority:1;index:idx_gx_provider_key_owner,priority:1"`
	KeyID   string `gorm:"column:key_id;type:varchar(64);uniqueIndex:uk_gx_provider_key_id,priority:2" description:"匿名标识 gpk_…"`
	KeyHash string `gorm:"column:key_hash;type:varchar(64);uniqueIndex:uk_gx_provider_key_hash,priority:2" description:"gpk- 明文的 sha256"`

	OwnerUserID string `gorm:"column:owner_user_id;type:varchar(64);index:idx_gx_provider_key_owner,priority:2" description:"归属的提供者：用这把密钥注册的机器算他的"`
	Alias       string `gorm:"column:alias;type:varchar(64)"`
	// TermsVersion 签发时的条款版本。注册时再校验一次 —— 密钥是长期的，
	// 条款很可能在它签发之后升过版。
	TermsVersion string `gorm:"column:terms_version;type:varchar(32)"`

	Status     string     `gorm:"column:status;type:varchar(16);index:idx_gx_provider_key_owner,priority:3" description:"active/revoked"`
	LastUsedAt *time.Time `gorm:"column:last_used_at;type:timestamp null default null"`
	LastNodeID string     `gorm:"column:last_node_id;type:varchar(64)"`
	ExpiresAt  *time.Time `gorm:"column:expires_at;type:timestamp null default null" description:"空表示不过期"`

	CreatedTime time.Time `gorm:"column:created_time;autoCreateTime"`
	UpdatedTime time.Time `gorm:"column:updated_time;autoUpdateTime"`
}

func (r *GalaxyProviderKey) TableName() string { return "zt_galaxy_provider_key" }
func (r *GalaxyProviderKey) Init()             {}

// GalaxyContribution 供给的最小单元。座位、额度、队列、绑定、限流全部以它为主键。
type GalaxyContribution struct {
	ID      int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_contribution_cid,priority:1;index:idx_gx_contribution_node,priority:1;index:idx_gx_contribution_lane,priority:1"`
	CID     string `gorm:"column:cid;type:varchar(96);uniqueIndex:uk_gx_contribution_cid,priority:2" description:"贡献业务键，全局唯一"`

	NodeID      string `gorm:"column:node_id;type:varchar(64);index:idx_gx_contribution_node,priority:2"`
	OwnerUserID string `gorm:"column:owner_user_id;type:varchar(64)"`

	Kind        string `gorm:"column:kind;type:varchar(64);index:idx_gx_contribution_lane,priority:2" description:"能力注册名，如 llm.chat"`
	KindVersion int    `gorm:"column:kind_version"`
	Provider    string `gorm:"column:provider;type:varchar(64);index:idx_gx_contribution_lane,priority:3" description:"路由键，选节点 provider"`

	ModelsAllowJSON string `gorm:"column:models_allow_json;type:varchar(1024)" description:"模型白名单模式数组"`
	// ModelsAvailableJSON 是**节点报上来的事实**：上游现在有哪些模型。
	// 和 ModelsAllow/Deny 是两回事 —— 那两个是主人定的规则（还支持 claude-sonnet-* 这种
	// 通配），这个只是给控制台当候选项，免得主人得自己记住上游有什么。
	ModelsAvailableJSON string `gorm:"column:models_available_json;type:varchar(4096)" description:"节点上报的上游可用模型名"`
	ModelsDenyJSON      string `gorm:"column:models_deny_json;type:varchar(1024)" description:"模型黑名单模式数组"`
	Seats               int    `gorm:"column:seats;default:3" description:"同时服务的消费者数量上限"`
	SeatConcurrency     int    `gorm:"column:seat_concurrency;default:2" description:"单座位并发上限"`
	ScheduleJSON        string `gorm:"column:schedule_json;type:varchar(512)" description:"挂机时段"`

	Status string `gorm:"column:status;type:varchar(16);index:idx_gx_contribution_node,priority:3" description:"active/draining/paused/disabled"`
	// 信誉不在这里：贡献 id 带着 nodeId，重新配对就是一条新贡献。见 GalaxyMachine。

	// Available / UnavailableReason 是**节点报上来的事实**，和 Status 是两回事：
	// Status 说的是「主人愿不愿意共享」，这两个说的是「这台机器现在能不能干」。
	// 分开存是因为它们会独立变化 —— Claude 登录态过期时能力不可用，但主人的
	// 勾选不该被清掉，登录回来就该自动恢复，而不是让他重新配一遍。
	// UnavailableReason 原样展示给主人（「请运行 claude auth login」这种），
	// 所以它必须是人话，不是错误码。
	// **不要给它加 default 标签。** GORM 对带 default 的字段，在值为零值（false）时
	// 会把这一列从 INSERT 里整个省掉、让数据库默认值生效；而 SyncContributionInventory
	// 的 upsert 用的是 ON DUPLICATE KEY UPDATE available=VALUES(available)，
	// VALUES(available) 于是取到默认值 1 —— 结果就是 available=false **永远写不进去**。
	//
	// 表现极具迷惑性：节点如实上报「Claude 登录态失效」，库里却一直是「可用」，
	// effectiveContributions 照常把它下发，节点给一个用不了的上游建通道，
	// 派到它头上的请求全部失败。而界面上它显示「共享中 / 在线」，一切正常。
	//
	// 建表语句里的 NOT NULL DEFAULT 1 保留：那是给迁移时的存量行用的，
	// 新写入一律由 Hello 显式给值（那也是唯一创建这张表行的地方）。
	Available         bool   `gorm:"column:available" description:"节点最近一次上报说这个能力本机可不可用"`
	UnavailableReason string `gorm:"column:unavailable_reason;type:varchar(256)" description:"不可用的原因，人话，直接展示给主人"`

	CreatedTime time.Time `gorm:"column:created_time;autoCreateTime"`
	UpdatedTime time.Time `gorm:"column:updated_time;autoUpdateTime"`
}

func (r *GalaxyContribution) TableName() string { return "zt_galaxy_contribution" }
func (r *GalaxyContribution) Init()             {}

// GalaxyQuotaGrant 一条授权行 (cid, unit, limit, window, resetAt)。
// 额度以 Hub 为权威，节点本地只留展示副本（三维额度规则第 8 条）。
type GalaxyQuotaGrant struct {
	ID      int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_quota_grant,priority:1"`
	CID     string `gorm:"column:cid;type:varchar(96);uniqueIndex:uk_gx_quota_grant,priority:2"`
	Unit    string `gorm:"column:unit;type:varchar(48);uniqueIndex:uk_gx_quota_grant,priority:3" description:"计量单位"`

	LimitValue  int64     `gorm:"column:limit_value" description:"窗口内上限"`
	Window      string    `gorm:"column:window;type:varchar(16)" description:"day/week/month/total"`
	ResetAt     string    `gorm:"column:reset_at;type:varchar(16)" description:"归零时刻与时区偏移，如 00:00+08:00"`
	UpdatedTime time.Time `gorm:"column:updated_time;autoUpdateTime"`
}

func (r *GalaxyQuotaGrant) TableName() string { return "zt_galaxy_quota_grant" }
func (r *GalaxyQuotaGrant) Init()             {}

// GalaxyQuotaWindow 每分钟从 Redis 计数器快照一次，供对账与控制台展示。
// 对账以 meter_record 求和为准，这张表只是加速读。
type GalaxyQuotaWindow struct {
	ID        int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine   string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_quota_window,priority:1"`
	CID       string `gorm:"column:cid;type:varchar(96);uniqueIndex:uk_gx_quota_window,priority:2"`
	Unit      string `gorm:"column:unit;type:varchar(48);uniqueIndex:uk_gx_quota_window,priority:3"`
	WindowKey string `gorm:"column:window_key;type:varchar(24);uniqueIndex:uk_gx_quota_window,priority:4"`

	Used       int64     `gorm:"column:used"`
	Reserved   int64     `gorm:"column:reserved"`
	SnapshotAt time.Time `gorm:"column:snapshot_at;type:timestamp null default null"`
}

func (r *GalaxyQuotaWindow) TableName() string { return "zt_galaxy_quota_window" }
func (r *GalaxyQuotaWindow) Init()             {}

// GalaxySeatBinding 座位绑定的持久化快照。权威在 Redis（带 TTL），这里留痕供审计。
type GalaxySeatBinding struct {
	ID      int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_seat_binding,priority:1"`
	CID     string `gorm:"column:cid;type:varchar(96);uniqueIndex:uk_gx_seat_binding,priority:2"`
	// ConsumerKey 是匿名标识 ck_…，不是 sk- 明文。
	ConsumerKey string `gorm:"column:consumer_key;type:varchar(64);uniqueIndex:uk_gx_seat_binding,priority:3"`
	Lane        string `gorm:"column:lane;type:varchar(128);uniqueIndex:uk_gx_seat_binding,priority:4"`

	BoundAt    time.Time  `gorm:"column:bound_at;type:timestamp null default null"`
	LastUsedAt time.Time  `gorm:"column:last_used_at;type:timestamp null default null"`
	ReleasedAt *time.Time `gorm:"column:released_at;type:timestamp null default null"`
}

func (r *GalaxySeatBinding) TableName() string { return "zt_galaxy_seat_binding" }
func (r *GalaxySeatBinding) Init()             {}

// GalaxyUnit 一次请求 / 一个回合 / 一个任务的权威记录。
type GalaxyUnit struct {
	ID      int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_unit_id,priority:1;index:idx_gx_unit_consumer,priority:1;index:idx_gx_unit_contribution,priority:1;index:idx_gx_unit_session,priority:1"`
	UnitID  string `gorm:"column:unit_id;type:varchar(40);uniqueIndex:uk_gx_unit_id,priority:2" description:"ULID，全局唯一"`

	Kind        string `gorm:"column:kind;type:varchar(64);index:idx_gx_unit_consumer,priority:3"`
	KindVersion int    `gorm:"column:kind_version"`
	Primitive   string `gorm:"column:primitive;type:varchar(16)"`
	Family      string `gorm:"column:family;type:varchar(32)"`
	Provider    string `gorm:"column:provider;type:varchar(64)"`
	Model       string `gorm:"column:model;type:varchar(96)"`

	ConsumerKey string `gorm:"column:consumer_key;type:varchar(64);index:idx_gx_unit_consumer,priority:2"`
	// Space 是业务自己的空间。池内 biz_line 固定 galaxy，业务空间单独一列：
	// 既不破坏池内索引，也能按空间回查（O-02）。
	Space   string `gorm:"column:space;type:varchar(64)"`
	SID     string `gorm:"column:sid;type:varchar(40);index:idx_gx_unit_session,priority:2" description:"session 原语的会话 id"`
	Op      string `gorm:"column:op;type:varchar(16)" description:"open/resume/turn/close"`
	CID     string `gorm:"column:cid;type:varchar(96);index:idx_gx_unit_contribution,priority:2"`
	Seq     int    `gorm:"column:seq;default:0" description:"session 回合序号"`
	Attempt int    `gorm:"column:attempt;default:1" description:"job 重跑次数"`

	State      string `gorm:"column:state;type:varchar(16);index:idx_gx_unit_contribution,priority:3;index:idx_gx_unit_sweep,priority:1"`
	ErrorClass string `gorm:"column:error_class;type:varchar(24)"`
	ErrorCode  string `gorm:"column:error_code;type:varchar(48)"`
	ErrorMsg   string `gorm:"column:error_message;type:varchar(512)" description:"面向消费者的简明错误，不含请求内容"`

	FirstByteAt *time.Time `gorm:"column:first_byte_at;type:timestamp null default null" description:"首字节时刻，决定失败语义"`
	StartedAt   *time.Time `gorm:"column:started_at;type:timestamp null default null"`
	FinishedAt  *time.Time `gorm:"column:finished_at;type:timestamp null default null"`

	EstimateJSON string `gorm:"column:estimate_json;type:varchar(512)"`
	ActualJSON   string `gorm:"column:actual_json;type:varchar(512)"`
	Instance     string `gorm:"column:instance;type:varchar(128)" description:"持有消费者连接的 Hub 实例"`

	CreatedTime time.Time `gorm:"column:created_time;autoCreateTime;index:idx_gx_unit_consumer,priority:4"`
	UpdatedTime time.Time `gorm:"column:updated_time;autoUpdateTime;index:idx_gx_unit_sweep,priority:2"`
}

func (r *GalaxyUnit) TableName() string { return "zt_galaxy_unit" }
func (r *GalaxyUnit) Init()             {}

// GalaxyUnitEvent 单元事件流。只记结构化事实，不记 body、不记凭据。
type GalaxyUnitEvent struct {
	ID      int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);index:idx_gx_unit_event_stream,priority:1"`
	UnitID  string `gorm:"column:unit_id;type:varchar(40);index:idx_gx_unit_event_stream,priority:2"`
	// Seq 是事件在这个单元里的序号。消费者断线重连时按它续读，
	// 自增主键做不到这件事 —— 它是全表递增的，跨单元不连续。
	Seq       int       `gorm:"column:seq;default:0;index:idx_gx_unit_event_stream,priority:3"`
	Kind      string    `gorm:"column:kind;type:varchar(32)" description:"placed/claimed/first_byte/completed/reassigned 等"`
	Message   string    `gorm:"column:message;type:varchar(512)"`
	DataJSON  string    `gorm:"column:data_json;type:text"`
	CreatedAt time.Time `gorm:"column:created_at;autoCreateTime"`
}

func (r *GalaxyUnitEvent) TableName() string { return "zt_galaxy_unit_event" }
func (r *GalaxyUnitEvent) Init()             {}

// GalaxyMeterRecord 计量流水，双账本与额度对账的唯一权威。
type GalaxyMeterRecord struct {
	ID      int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_meter_record,priority:1;index:idx_gx_meter_consumer,priority:1;index:idx_gx_meter_contribution,priority:1"`
	UnitID  string `gorm:"column:unit_id;type:varchar(40);uniqueIndex:uk_gx_meter_record,priority:2"`
	Attempt int    `gorm:"column:attempt;uniqueIndex:uk_gx_meter_record,priority:3" description:"结算幂等键的一半：rid + attempt"`
	Unit    string `gorm:"column:unit;type:varchar(48);uniqueIndex:uk_gx_meter_record,priority:4"`

	CID         string    `gorm:"column:cid;type:varchar(96);index:idx_gx_meter_contribution,priority:2"`
	ConsumerKey string    `gorm:"column:consumer_key;type:varchar(64);index:idx_gx_meter_consumer,priority:2"`
	Kind        string    `gorm:"column:kind;type:varchar(64);index:idx_gx_meter_consumer,priority:3"`
	Amount      int64     `gorm:"column:amount"`
	Source      string    `gorm:"column:source;type:varchar(8)" description:"hub/stream/node"`
	CreatedAt   time.Time `gorm:"column:created_at;autoCreateTime;index:idx_gx_meter_consumer,priority:4;index:idx_gx_meter_contribution,priority:3"`
}

func (r *GalaxyMeterRecord) TableName() string { return "zt_galaxy_meter_record" }
func (r *GalaxyMeterRecord) Init()             {}

// GalaxyUsageMismatch 节点自报与 Hub 解析偏差超过阈值的记录，累计影响信誉。
type GalaxyUsageMismatch struct {
	ID        int64     `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine   string    `gorm:"column:biz_line;type:varchar(32);index:idx_gx_usage_mismatch,priority:1"`
	UnitID    string    `gorm:"column:unit_id;type:varchar(40);index:idx_gx_usage_mismatch,priority:2"`
	CID       string    `gorm:"column:cid;type:varchar(96)"`
	Unit      string    `gorm:"column:unit;type:varchar(48)"`
	HubValue  int64     `gorm:"column:hub_value"`
	NodeValue int64     `gorm:"column:node_value"`
	Ratio     float64   `gorm:"column:ratio"`
	CreatedAt time.Time `gorm:"column:created_at;autoCreateTime;index:idx_gx_usage_mismatch,priority:3"`
}

func (r *GalaxyUsageMismatch) TableName() string { return "zt_galaxy_usage_mismatch" }
func (r *GalaxyUsageMismatch) Init()             {}

// GalaxyConsumerKey 算力密钥。鉴权只按 sha256 查；明文另外加密存一份，供本人「使用」
// 与运营转交时取回（2026-09-12 起，之前签发的只有哈希，取不回）。
type GalaxyConsumerKey struct {
	ID      int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_consumer_key_id,priority:1;uniqueIndex:uk_gx_consumer_key_hash,priority:1;index:idx_gx_consumer_key_owner,priority:1"`
	KeyID   string `gorm:"column:key_id;type:varchar(64);uniqueIndex:uk_gx_consumer_key_id,priority:2" description:"匿名标识 ck_…，节点看到的就是它"`
	KeyHash string `gorm:"column:key_hash;type:varchar(64);uniqueIndex:uk_gx_consumer_key_hash,priority:2" description:"sk- 明文的 sha256"`
	// SecretCipher 明文的 AES-GCM 密文，密钥来自 galaxy.key_cipher_secret，不在库里。
	// 空串表示取不回：老密钥，或签发时服务端没配加密密钥。
	SecretCipher string `gorm:"column:secret_cipher;type:varchar(256)" description:"sk- 明文的 AES-GCM 密文，空表示取不回"`

	Alias       string `gorm:"column:alias;type:varchar(64)" description:"日志与账单里的可读名"`
	OwnerUserID string `gorm:"column:owner_user_id;type:varchar(64);index:idx_gx_consumer_key_owner,priority:2"`
	OrderID     string `gorm:"column:order_id;type:varchar(64)"`
	// ModelID 买的是哪个模型的套餐。只用来认类别（Claude / Codex）和展示，不参与鉴权 ——
	// 能调哪些模型仍然只看 ModelTierJSON。
	ModelID string `gorm:"column:model_id;type:varchar(96)" description:"来源套餐绑定的模型，只用于认类别与展示"`

	AllowedKindsJSON     string `gorm:"column:allowed_kinds_json;type:varchar(512)" description:"空数组表示不限"`
	AllowedProvidersJSON string `gorm:"column:allowed_providers_json;type:varchar(512)"`
	ModelTierJSON        string `gorm:"column:model_tier_json;type:varchar(1024)" description:"允许的模型模式"`
	Concurrency          int    `gorm:"column:concurrency;default:4"`
	RPM                  int    `gorm:"column:rpm;default:120"`

	Status      string     `gorm:"column:status;type:varchar(16);index:idx_gx_consumer_key_owner,priority:3" description:"active/expired/frozen/revoked"`
	IssuedAt    time.Time  `gorm:"column:issued_at;type:timestamp null default null"`
	ExpiresAt   time.Time  `gorm:"column:expires_at;type:timestamp null default null" description:"到期后请求返回 key_expired"`
	FrozenUntil *time.Time `gorm:"column:frozen_until;type:timestamp null default null" description:"冻结期内可续期换发"`
	RenewedFrom string     `gorm:"column:renewed_from_key_id;type:varchar(64)"`

	// 数据告知：密钥签发时必须记录消费者确认（C-13）。
	NoticeVersion string    `gorm:"column:notice_version;type:varchar(32)"`
	NoticeAckAt   time.Time `gorm:"column:notice_ack_at;type:timestamp null default null"`

	CreatedTime time.Time `gorm:"column:created_time;autoCreateTime"`
	UpdatedTime time.Time `gorm:"column:updated_time;autoUpdateTime"`
}

func (r *GalaxyConsumerKey) TableName() string { return "zt_galaxy_consumer_key" }
func (r *GalaxyConsumerKey) Init()             {}

// GalaxyConsumerBalance 密钥的单位余额。P0 只记账不扣款，扣减在 P1 接支付后生效。
type GalaxyConsumerBalance struct {
	ID          int64     `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine     string    `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_consumer_balance,priority:1"`
	KeyID       string    `gorm:"column:key_id;type:varchar(64);uniqueIndex:uk_gx_consumer_balance,priority:2"`
	Unit        string    `gorm:"column:unit;type:varchar(48);uniqueIndex:uk_gx_consumer_balance,priority:3"`
	Balance     int64     `gorm:"column:balance"`
	Frozen      int64     `gorm:"column:frozen"`
	UpdatedTime time.Time `gorm:"column:updated_time;autoUpdateTime"`
}

func (r *GalaxyConsumerBalance) TableName() string { return "zt_galaxy_consumer_balance" }
func (r *GalaxyConsumerBalance) Init()             {}

// GalaxyConsentRecord 同意记录。提供者加入与消费者密钥签发都是硬前置，缺失即拒绝。
type GalaxyConsentRecord struct {
	ID           int64     `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine      string    `gorm:"column:biz_line;type:varchar(32);index:idx_gx_consent_subject,priority:1"`
	SubjectType  string    `gorm:"column:subject_type;type:varchar(16);index:idx_gx_consent_subject,priority:2" description:"provider/consumer"`
	UserID       string    `gorm:"column:user_id;type:varchar(64);index:idx_gx_consent_subject,priority:3"`
	TermsVersion string    `gorm:"column:terms_version;type:varchar(32);index:idx_gx_consent_subject,priority:4"`
	AcceptedAt   time.Time `gorm:"column:accepted_at;type:timestamp null default null"`
	IP           string    `gorm:"column:ip;type:varchar(64)"`
	UserAgent    string    `gorm:"column:user_agent;type:varchar(256)"`
	CreatedTime  time.Time `gorm:"column:created_time;autoCreateTime"`
}

func (r *GalaxyConsentRecord) TableName() string { return "zt_galaxy_consent_record" }
func (r *GalaxyConsentRecord) Init()             {}

// GalaxyPrice kind 的「单位 → 单价」表。中转站按 token 计价，input 与 output 分别定价（D-02）。
type GalaxyPrice struct {
	ID            int64     `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine       string    `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_price,priority:1"`
	Kind          string    `gorm:"column:kind;type:varchar(64);uniqueIndex:uk_gx_price,priority:2"`
	Unit          string    `gorm:"column:unit;type:varchar(48);uniqueIndex:uk_gx_price,priority:3"`
	EffectiveFrom time.Time `gorm:"column:effective_from;type:timestamp null default null;uniqueIndex:uk_gx_price,priority:4"`
	// Price 是每百万单位的价格（微分），避免浮点累积误差。
	Price         int64   `gorm:"column:price" description:"每百万单位价格，单位微分"`
	Currency      string  `gorm:"column:currency;type:varchar(8);default:'CNY'"`
	ProviderShare float64 `gorm:"column:provider_share;default:0.7" description:"提供者分成比例"`
}

func (r *GalaxyPrice) TableName() string { return "zt_galaxy_price" }
func (r *GalaxyPrice) Init()             {}

// GalaxyArtifact 产物元数据。字节在 OSS，Hub 只签 URL。
type GalaxyArtifact struct {
	ID          int64      `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine     string     `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_artifact_key,priority:1"`
	ObjectKey   string     `gorm:"column:object_key;type:varchar(256);uniqueIndex:uk_gx_artifact_key,priority:2" description:"对象键不含任何用户或节点信息"`
	UnitID      string     `gorm:"column:unit_id;type:varchar(40)"`
	OwnerKey    string     `gorm:"column:owner_key;type:varchar(64)" description:"归属密钥的匿名标识"`
	Kind        string     `gorm:"column:kind;type:varchar(64)"`
	Size        int64      `gorm:"column:size"`
	SHA256      string     `gorm:"column:sha256;type:varchar(64)"`
	ContentType string     `gorm:"column:content_type;type:varchar(128)"`
	ExpiresAt   *time.Time `gorm:"column:expires_at;type:timestamp null default null" description:"按 kind 保留期清理"`
	Deleted     bool       `gorm:"column:deleted;default:false"`
	CreatedTime time.Time  `gorm:"column:created_time;autoCreateTime"`
}

func (r *GalaxyArtifact) TableName() string { return "zt_galaxy_artifact" }
func (r *GalaxyArtifact) Init()             {}

// GalaxyCreditAccount 提供者积分账户（决策 D-04）。P1 记账，P2 接提现。
type GalaxyCreditAccount struct {
	ID          int64     `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine     string    `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_credit_account,priority:1"`
	OwnerUserID string    `gorm:"column:owner_user_id;type:varchar(64);uniqueIndex:uk_gx_credit_account,priority:2"`
	Balance     int64     `gorm:"column:balance"`
	Frozen      int64     `gorm:"column:frozen"`
	UpdatedTime time.Time `gorm:"column:updated_time;autoUpdateTime"`
}

func (r *GalaxyCreditAccount) TableName() string { return "zt_galaxy_credit_account" }
func (r *GalaxyCreditAccount) Init()             {}

// GalaxyConsumerLedger 消费侧账本：购买 / 消费 / 冻结 / 退款 / 过期。
type GalaxyConsumerLedger struct {
	ID           int64     `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine      string    `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_consumer_ledger,priority:1;index:idx_gx_consumer_ledger_key,priority:1"`
	TxnID        string    `gorm:"column:txn_id;type:varchar(96);uniqueIndex:uk_gx_consumer_ledger,priority:2" description:"幂等键 rid+attempt+unit"`
	KeyID        string    `gorm:"column:key_id;type:varchar(64);index:idx_gx_consumer_ledger_key,priority:2"`
	Type         string    `gorm:"column:type;type:varchar(16)" description:"topup/reserve/settle/refund/expire"`
	Unit         string    `gorm:"column:unit;type:varchar(48)"`
	Amount       int64     `gorm:"column:amount"`
	Price        int64     `gorm:"column:price" description:"结算时点的单价快照"`
	BalanceAfter int64     `gorm:"column:balance_after"`
	UnitID       string    `gorm:"column:unit_id;type:varchar(40)"`
	CreatedAt    time.Time `gorm:"column:created_at;autoCreateTime;index:idx_gx_consumer_ledger_key,priority:3"`
}

func (r *GalaxyConsumerLedger) TableName() string { return "zt_galaxy_consumer_ledger" }
func (r *GalaxyConsumerLedger) Init()             {}

// GalaxyProviderLedger 供给侧积分账本：贡献 / 待结算 / 已结算 / 追回。
type GalaxyProviderLedger struct {
	ID          int64     `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine     string    `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_provider_ledger,priority:1;index:idx_gx_provider_ledger_cid,priority:1"`
	TxnID       string    `gorm:"column:txn_id;type:varchar(96);uniqueIndex:uk_gx_provider_ledger,priority:2"`
	CID         string    `gorm:"column:cid;type:varchar(96);index:idx_gx_provider_ledger_cid,priority:2"`
	OwnerUserID string    `gorm:"column:owner_user_id;type:varchar(64)"`
	Type        string    `gorm:"column:type;type:varchar(16)" description:"contribute/settle/payout/clawback/referral/ref_clawback"`
	// Unit 这笔积分是**哪种计量单位**挣来的（settle / clawback），或者 credit（提现、邀请奖励）。
	Unit string `gorm:"column:unit;type:varchar(48)"`
	// Amount 一律是**微积分**（1,000,000 = 1 积分 = ¥1），和信用账户余额同一量纲。
	//
	// 不是计量数：原先 settle 行记的是 token 数，于是收益页上「今天赚了多少」加的是 token、
	// 「可提现」用的是余额里的钱，两个口径根本不是一个东西。原始计量数在
	// zt_galaxy_meter_record 里（对账以它求和为准），这一列只回答「这笔挣了多少」。
	Amount int64 `gorm:"column:amount" description:"微积分，1,000,000 = 1 积分 = ¥1"`
	Price       int64     `gorm:"column:price"`
	UnitID      string    `gorm:"column:unit_id;type:varchar(40)"`
	// RelatedUserID 邀请奖励是谁跑出来的（被邀请人 pu_…）。其它类型为空。
	// 邀请页按它汇总「每个好友给你带来多少」，不另设计数器 —— 账本是唯一权威。
	RelatedUserID string    `gorm:"column:related_user_id;type:varchar(64)" description:"邀请奖励对应的被邀请人"`
	CreatedAt     time.Time `gorm:"column:created_at;autoCreateTime;index:idx_gx_provider_ledger_cid,priority:3"`
}

func (r *GalaxyProviderLedger) TableName() string { return "zt_galaxy_provider_ledger" }
func (r *GalaxyProviderLedger) Init()             {}

// GalaxyPlatformLedger 平台抽成与坏账单独记，让两侧账本可对平。
type GalaxyPlatformLedger struct {
	ID        int64     `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine   string    `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_platform_ledger,priority:1"`
	TxnID     string    `gorm:"column:txn_id;type:varchar(96);uniqueIndex:uk_gx_platform_ledger,priority:2"`
	Type      string    `gorm:"column:type;type:varchar(16)" description:"fee/baddebt"`
	Amount    int64     `gorm:"column:amount"`
	UnitID    string    `gorm:"column:unit_id;type:varchar(40)"`
	CreatedAt time.Time `gorm:"column:created_at;autoCreateTime"`
}

func (r *GalaxyPlatformLedger) TableName() string { return "zt_galaxy_platform_ledger" }
func (r *GalaxyPlatformLedger) Init()             {}

// GalaxyPayout 一次提现申请。
//
// 积分账本（zt_galaxy_provider_ledger）记的是「钱怎么动的」，它只前进不回退，
// 一笔 payout 流水写下去就是既成事实。但提现在钱真的打出去之前还有一段人工过程：
// 待打款、被驳回、重试。把这段状态塞进账本会让账本变得可修改，对不平；
// 所以申请单独一张表，账本上只在**受理**那一刻记一笔 payout。
//
// 驳回时反向记一笔 refund 把积分还回账户，而不是删掉原来那笔 ——
// 删了就对不出「这笔钱申请过又退回来了」。
type GalaxyPayout struct {
	ID          int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine     string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_payout,priority:1;index:idx_gx_payout_owner,priority:1"`
	PayoutID    string `gorm:"column:payout_id;type:varchar(64);uniqueIndex:uk_gx_payout,priority:2"`
	OwnerUserID string `gorm:"column:owner_user_id;type:varchar(64);index:idx_gx_payout_owner,priority:2"`

	// Credits 提现的积分数；Amount 是按兑换比折出的钱（微分），下单那一刻快照进来，
	// 之后改比例不影响已受理的申请。
	Credits  int64  `gorm:"column:credits"`
	Amount   int64  `gorm:"column:amount"`
	Currency string `gorm:"column:currency;type:varchar(8);default:'CNY'"`
	Fee      int64  `gorm:"column:fee" description:"手续费，微分"`

	Method  string `gorm:"column:method;type:varchar(16)" description:"alipay/wechat/bank"`
	Account string `gorm:"column:account;type:varchar(128)" description:"收款账号，展示时打码"`

	Status string `gorm:"column:status;type:varchar(16);index:idx_gx_payout_owner,priority:3" description:"pending/paid/rejected"`
	Note   string `gorm:"column:note;type:varchar(256)" description:"驳回原因等，面向申请人"`

	HandledBy   string     `gorm:"column:handled_by;type:varchar(64)"`
	HandledAt   *time.Time `gorm:"column:handled_at;type:timestamp null default null"`
	CreatedTime time.Time  `gorm:"column:created_time;autoCreateTime;index:idx_gx_payout_owner,priority:4"`
	UpdatedTime time.Time  `gorm:"column:updated_time;autoUpdateTime"`
}

func (r *GalaxyPayout) TableName() string { return "zt_galaxy_payout" }
func (r *GalaxyPayout) Init()             {}

// GalaxyAuditProbe 抽检记录：以 Hub 自有账号影子重放，比对结构相似度。
//
// 隐私上的取舍要说清楚：为了能重放，这张表**短期保留**被抽中那次请求的原文
// （比例上限 1%/贡献/日），但只保留节点响应的**结构签名**而不是响应本身。
// 跑完抽检就把原文清空 —— 保留它的唯一理由是「重放一次」，理由消失就该删。
type GalaxyAuditProbe struct {
	ID      int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_audit_probe,priority:1;index:idx_gx_audit_probe_cid,priority:1;index:idx_gx_audit_probe_pending,priority:1"`
	ProbeID string `gorm:"column:probe_id;type:varchar(40);uniqueIndex:uk_gx_audit_probe,priority:2"`
	CID     string `gorm:"column:cid;type:varchar(96);index:idx_gx_audit_probe_cid,priority:2"`
	UnitID  string `gorm:"column:unit_id;type:varchar(40)"`

	Family string `gorm:"column:family;type:varchar(32)"`
	Path   string `gorm:"column:path;type:varchar(64)"`
	Model  string `gorm:"column:model;type:varchar(96)"`
	// RequestBody 被抽中那次请求的原文，只为重放而留，跑完即清空。
	RequestBody string `gorm:"column:request_body;type:mediumtext" description:"仅为重放保留的请求原文，比对完立即清空，超 24 小时未跑也清空"`
	// NodeSignature 是节点响应的结构签名（事件序列 + 形状），不是响应内容。
	NodeSignature   string `gorm:"column:node_signature;type:varchar(1024)" description:"节点响应的结构签名，不是响应内容"`
	ShadowSignature string `gorm:"column:shadow_signature;type:varchar(1024)" description:"影子重放的结构签名，同样不含响应内容"`

	ShadowUnitID string     `gorm:"column:shadow_unit_id;type:varchar(40)"`
	Similarity   float64    `gorm:"column:similarity"`
	Verdict      string     `gorm:"column:verdict;type:varchar(16);index:idx_gx_audit_probe_pending,priority:2" description:"pending/ready/pass/suspect/forged/skipped"`
	Detail       string     `gorm:"column:detail;type:varchar(512)"`
	CreatedAt    time.Time  `gorm:"column:created_at;autoCreateTime;index:idx_gx_audit_probe_cid,priority:3;index:idx_gx_audit_probe_pending,priority:3"`
	CheckedAt    *time.Time `gorm:"column:checked_at;type:timestamp null default null"`
}

func (r *GalaxyAuditProbe) TableName() string { return "zt_galaxy_audit_probe" }
func (r *GalaxyAuditProbe) Init()             {}

// GalaxyPackage 额度商品：一份「多少钱换多少额度、有效期多久」的定义。
// 商品是运营配置，不是代码常量 —— 调价与上下架不该走发版。
type GalaxyPackage struct {
	ID          int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine     string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_package,priority:1;index:idx_gx_package_listed,priority:1"`
	PackageCode string `gorm:"column:package_code;type:varchar(64);uniqueIndex:uk_gx_package,priority:2"`

	Title string `gorm:"column:title;type:varchar(128)"`
	// UnitsJSON 是这份商品给的额度：单位 → 数量。
	UnitsJSON string `gorm:"column:units_json;type:varchar(1024)"`
	// Amount 售价，单位微分；与 price 表同一量纲，便于对账。
	Amount   int64  `gorm:"column:amount"`
	Currency string `gorm:"column:currency;type:varchar(8);default:'CNY'"`
	// TTLDays 这份商品签发出的密钥有效期。
	TTLDays          int    `gorm:"column:ttl_days;default:30"`
	AllowedKindsJSON string `gorm:"column:allowed_kinds_json;type:varchar(512)"`
	ModelTierJSON    string `gorm:"column:model_tier_json;type:varchar(1024)"`
	Concurrency      int    `gorm:"column:concurrency;default:4"`
	RPM              int    `gorm:"column:rpm;default:120"`
	// ModelID 这个套餐属于模型目录里的哪个模型。分享返现按这个模型的比例算；
	// 空表示通用套餐，返现走全局默认比例。
	ModelID string `gorm:"column:model_id;type:varchar(96)" description:"绑定的模型（zt_galaxy_model.model_id），空为通用套餐"`

	Listed      bool      `gorm:"column:listed;default:true;index:idx_gx_package_listed,priority:2"`
	SortOrder   int       `gorm:"column:sort_order;default:0"`
	CreatedTime time.Time `gorm:"column:created_time;autoCreateTime"`
	UpdatedTime time.Time `gorm:"column:updated_time;autoUpdateTime"`
}

func (r *GalaxyPackage) TableName() string { return "zt_galaxy_package" }
func (r *GalaxyPackage) Init()             {}

// GalaxyOrder 一次购买。支付成功后签发新密钥或给指定密钥充值。
//
// 状态只前进不回退：pending → paid → fulfilled，或 pending → cancelled。
// 履约（签发/充值）与支付分开两步，是为了让支付回调可以安全重放 ——
// 回调只把订单推到 paid，履约由幂等的 fulfil 负责。
type GalaxyOrder struct {
	ID      int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_order,priority:1;index:idx_gx_order_user,priority:1"`
	OrderID string `gorm:"column:order_id;type:varchar(64);uniqueIndex:uk_gx_order,priority:2"`

	UserID      string `gorm:"column:user_id;type:varchar(64);index:idx_gx_order_user,priority:2"`
	PackageCode string `gorm:"column:package_code;type:varchar(64)"`
	Amount      int64  `gorm:"column:amount"`
	Currency    string `gorm:"column:currency;type:varchar(8);default:'CNY'"`
	// UnitsJSON 下单那一刻的额度快照。商品改了不影响已下的单。
	UnitsJSON string `gorm:"column:units_json;type:varchar(1024)"`
	// TargetKeyID 非空表示给这把已有密钥充值，空表示签发新密钥。
	TargetKeyID string `gorm:"column:target_key_id;type:varchar(64)" description:"非空表示给这把已有密钥充值，空表示签发新密钥"`
	KeyID       string `gorm:"column:key_id;type:varchar(64)" description:"履约后落到哪把密钥"`

	// ModelID 下单那一刻套餐绑定的模型。套餐之后改绑不影响这一单的返现口径。
	ModelID string `gorm:"column:model_id;type:varchar(96)" description:"下单时套餐绑定的模型快照"`

	Status string `gorm:"column:status;type:varchar(16);index:idx_gx_order_user,priority:3" description:"pending/paid/fulfilled/cancelled"`
	// PayMethod 怎么付的：points=积分；channel=支付渠道（含沙箱与人工确认到账）。
	PayMethod string `gorm:"column:pay_method;type:varchar(16)" description:"points=积分；channel=支付渠道"`
	// PaymentRef 支付渠道的流水号，同时是回调幂等键。
	PaymentRef  string     `gorm:"column:payment_ref;type:varchar(128)"`
	PaidAt      *time.Time `gorm:"column:paid_at;type:timestamp null default null"`
	FulfilledAt *time.Time `gorm:"column:fulfilled_at;type:timestamp null default null"`
	CreatedTime time.Time  `gorm:"column:created_time;autoCreateTime;index:idx_gx_order_user,priority:4"`
	UpdatedTime time.Time  `gorm:"column:updated_time;autoUpdateTime"`
}

func (r *GalaxyOrder) TableName() string { return "zt_galaxy_order" }
func (r *GalaxyOrder) Init()             {}

// ---------- 上下文账本 ----------
//
// 服务端账本是业务真相，节点 thread 只是执行缓存（架构第 9 节）。
// 每个回合结束节点把 contextDelta 交上来，节点死了服务端仍拥有完整业务上下文。

// GalaxyLedgerSession 一次有状态会话。
//
// Space 是业务自己的空间（任务宇宙的 bizLine 之类）。共享池按平台维度运行，
// biz_line 固定 galaxy；业务空间单独一列，既不破坏池内索引，也能按空间回查（O-02）。
type GalaxyLedgerSession struct {
	ID      int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_ledger_session,priority:1;index:idx_gx_ledger_session_key,priority:1"`
	SID     string `gorm:"column:sid;type:varchar(40);uniqueIndex:uk_gx_ledger_session,priority:2"`

	Kind        string `gorm:"column:kind;type:varchar(64)"`
	KindVersion int    `gorm:"column:kind_version"`
	Provider    string `gorm:"column:provider;type:varchar(64)"`
	ConsumerKey string `gorm:"column:consumer_key;type:varchar(64);index:idx_gx_ledger_session_key,priority:2"`
	Space       string `gorm:"column:space;type:varchar(64)"`
	ProgramRef  string `gorm:"column:program_ref;type:varchar(128)"`

	// CID 是会话钉住的贡献。session 是硬亲和：活着的时候一直落在同一台机器上。
	CID     string `gorm:"column:cid;type:varchar(96)"`
	State   string `gorm:"column:state;type:varchar(16);index:idx_gx_ledger_session_key,priority:3" description:"open/pinned/migrating/closed"`
	LastSeq int    `gorm:"column:last_seq;default:0"`

	ContextSchemaVersion string `gorm:"column:context_schema_version;type:varchar(64)"`
	WorkspaceRefJSON     string `gorm:"column:workspace_ref_json;type:varchar(1024)" description:"工作区分支与 commit，跨节点续接靠它"`
	CloseReason          string `gorm:"column:close_reason;type:varchar(128)"`

	CreatedTime time.Time  `gorm:"column:created_time;autoCreateTime"`
	LastTurnAt  *time.Time `gorm:"column:last_turn_at;type:timestamp null default null"`
	UpdatedTime time.Time  `gorm:"column:updated_time;autoUpdateTime"`
}

func (r *GalaxyLedgerSession) TableName() string { return "zt_galaxy_ledger_session" }
func (r *GalaxyLedgerSession) Init()             {}

// GalaxyLedgerTurn 一个回合的结构化摘要。(sid, seq) 是幂等键：
// 重复提交同一个 seq 直接返回已有结果，不重跑。
type GalaxyLedgerTurn struct {
	ID      int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_ledger_turn,priority:1"`
	SID     string `gorm:"column:sid;type:varchar(40);uniqueIndex:uk_gx_ledger_turn,priority:2"`
	Seq     int    `gorm:"column:seq;uniqueIndex:uk_gx_ledger_turn,priority:3"`

	UnitID           string `gorm:"column:unit_id;type:varchar(40)"`
	CID              string `gorm:"column:cid;type:varchar(96)"`
	InputJSON        string `gorm:"column:input_json;type:mediumtext"`
	OutputSummary    string `gorm:"column:output_summary;type:text"`
	ToolCallsJSON    string `gorm:"column:tool_calls_json;type:mediumtext"`
	ChangedFilesJSON string `gorm:"column:changed_files_json;type:mediumtext"`
	ArtifactsJSON    string `gorm:"column:artifacts_json;type:mediumtext"`
	UsageJSON        string `gorm:"column:usage_json;type:varchar(512)"`
	ExternalThreadID string `gorm:"column:external_thread_id;type:varchar(128)" description:"节点侧 CLI thread，换节点后失效"`
	State            string `gorm:"column:state;type:varchar(16)"`
	// WorkspaceLost 记录续接时丢掉了未推送的改动。这件事必须让用户看见，
	// 不能悄悄发生（T-09）。
	WorkspaceLost bool       `gorm:"column:workspace_lost;default:false"`
	StartedAt     time.Time  `gorm:"column:started_at;type:timestamp null default null"`
	EndedAt       *time.Time `gorm:"column:ended_at;type:timestamp null default null"`
}

func (r *GalaxyLedgerTurn) TableName() string { return "zt_galaxy_ledger_turn" }
func (r *GalaxyLedgerTurn) Init()             {}

// GalaxyLedgerCheckpoint 节点侧 CLI 的高保真快照。绑 CLI 版本：
// 版本对不上就只能靠账本摘要重建 thread，那是有损的。
type GalaxyLedgerCheckpoint struct {
	ID      int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_ledger_checkpoint,priority:1"`
	SID     string `gorm:"column:sid;type:varchar(40);uniqueIndex:uk_gx_ledger_checkpoint,priority:2"`
	Seq     int    `gorm:"column:seq;uniqueIndex:uk_gx_ledger_checkpoint,priority:3"`

	Provider   string    `gorm:"column:provider;type:varchar(64)"`
	CLIVersion string    `gorm:"column:cli_version;type:varchar(32)"`
	ObjectKey  string    `gorm:"column:object_key;type:varchar(256)"`
	Size       int64     `gorm:"column:size"`
	CreatedAt  time.Time `gorm:"column:created_at;autoCreateTime"`
}

func (r *GalaxyLedgerCheckpoint) TableName() string { return "zt_galaxy_ledger_checkpoint" }
func (r *GalaxyLedgerCheckpoint) Init()             {}

// GalaxyDispute 争议工单（S-09）。
//
// 消费者与提供者互不可见，出了问题两边没法直接对话 —— 平台是唯一能同时看到
// 单元、计量与两本账的一方，所以争议只能由平台居中处理，工单就是这条通道。
//
// 一条工单钉在 (unit_id, attempt) 上而不是只钉 unit_id：结算幂等键就是这两个，
// 重跑过的单元每次尝试各自结算，追回也得按尝试来，否则一次退款会退掉两次的钱。
type GalaxyDispute struct {
	ID        int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine   string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_dispute_id,priority:1;uniqueIndex:uk_gx_dispute_unit,priority:1;index:idx_gx_dispute_owner,priority:1;index:idx_gx_dispute_status,priority:1;index:idx_gx_dispute_contribution,priority:1"`
	DisputeID string `gorm:"column:dispute_id;type:varchar(40);uniqueIndex:uk_gx_dispute_id,priority:2" description:"dp_ + ULID"`

	// (unit_id, attempt) 唯一：同一次执行只能有一张工单，避免同一笔钱被退两次。
	UnitID  string `gorm:"column:unit_id;type:varchar(40);uniqueIndex:uk_gx_dispute_unit,priority:2"`
	Attempt int    `gorm:"column:attempt;uniqueIndex:uk_gx_dispute_unit,priority:3"`

	Kind        string `gorm:"column:kind;type:varchar(64)"`
	KeyID       string `gorm:"column:key_id;type:varchar(64)" description:"花钱的那把算力密钥"`
	OwnerUserID string `gorm:"column:owner_user_id;type:varchar(64);index:idx_gx_dispute_owner,priority:2" description:"申诉人，即消费者"`
	CID         string `gorm:"column:cid;type:varchar(96);index:idx_gx_dispute_contribution,priority:2"`
	// ProviderUserID 在建单那一刻定死。贡献可能被删、可能改主人，
	// 而追回要打在「当时跑这单的那个人」头上。
	ProviderUserID string `gorm:"column:provider_user_id;type:varchar(64)" description:"建单那一刻的贡献主人；追回打在他头上"`

	Reason string `gorm:"column:reason;type:varchar(32)" description:"not_delivered/wrong_output/overcharged/forged/other"`
	// Detail 是申诉人自述。刻意限长且只在工单里可见 —— 它可能被写进请求内容，
	// 而请求内容平台不留存（C-12）。
	Detail string `gorm:"column:detail;type:varchar(512)" description:"申诉人自述。界面明确劝阻粘贴请求内容 —— 那些平台本就不留存"`
	Status string `gorm:"column:status;type:varchar(16);index:idx_gx_dispute_status,priority:2;index:idx_gx_dispute_contribution,priority:3" description:"open/reviewing/upheld/rejected/withdrawn"`

	Resolution string `gorm:"column:resolution;type:varchar(512)" description:"运营的处理说明，会原样给到申诉人"`
	// RefundJSON 实际退回的量，按计量单位。空表示判定成立但没有可退的钱
	// （比如那次执行本来就没产生计费单位）。
	RefundJSON     string     `gorm:"column:refund_json;type:varchar(512)" description:"实际退回的量，按计量单位。空表示成立但没有可退的钱"`
	ClawbackAmount int64      `gorm:"column:clawback_amount;default:0" description:"从提供者积分里扣回的金额"`
	HandledBy      string     `gorm:"column:handled_by;type:varchar(64)"`
	HandledAt      *time.Time `gorm:"column:handled_at;type:timestamp null default null"`

	// created_time 进这两个索引的末位：两个列表查询都是「按状态 / 按人过滤，
	// 再按时间倒序取前 N 条」。不带它，MySQL 取到行之后还要 filesort 一遍。
	CreatedTime time.Time `gorm:"column:created_time;autoCreateTime;index:idx_gx_dispute_owner,priority:3,sort:desc;index:idx_gx_dispute_status,priority:3,sort:desc"`
	UpdatedTime time.Time `gorm:"column:updated_time;autoUpdateTime"`
}

func (r *GalaxyDispute) TableName() string { return "zt_galaxy_dispute" }
func (r *GalaxyDispute) Init()             {}

// GalaxyModel 门户对外展示的模型目录。
//
// 它**不是** relay 的 /v1/models 那份清单：那份是「客户端能填哪些模型名」，由部署方
// 在 galaxy.models 里声明，抖一下就会让人刚存好的配置失效；这张表是「门户上怎么把
// 这个模型讲清楚」—— 上下文长度、单价、能力标签、排序。两份东西的更新节奏完全不同，
// 合成一份的结果是运营改一句文案要重启服务。
//
// 表为空时门户回落到声明清单，只显示模型名与统一单价 —— 少写一行文案的代价是
// 少一点信息，而不是整页空白。
type GalaxyModel struct {
	ID          int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine     string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_model,priority:1;index:idx_gx_model_listed,priority:1"`
	ModelID     string `gorm:"column:model_id;type:varchar(96);uniqueIndex:uk_gx_model,priority:2" description:"对外模型名，与 /v1/models 一致"`
	DisplayName string `gorm:"column:display_name;type:varchar(96)"`
	Vendor      string `gorm:"column:vendor;type:varchar(32)" description:"anthropic/openai/google/…"`
	// Family 是门户分栏用的族名（claude/gpt/gemini/other）。派生规则放服务端，
	// 免得门户和控制台各写一份匹配规则，同一个模型落进不同栏。
	Family string `gorm:"column:family;type:varchar(32)"`
	Kind   string `gorm:"column:kind;type:varchar(64)" description:"计价所属 kind，默认 llm.chat"`

	ContextTokens   int64 `gorm:"column:context_tokens;default:0" description:"上下文窗口 token 数，0 表示未声明"`
	MaxOutputTokens int64 `gorm:"column:max_output_tokens;default:0"`

	// 三个单价都是「每百万 token 的微分」，与 zt_galaxy_price 同口径。
	// 0 表示这个模型不单独定价，按 kind 的统一价走 —— 不是「免费」。
	InputPrice  int64  `gorm:"column:input_price;default:0" description:"每百万 input token 微分，0=按 kind 统一价"`
	OutputPrice int64  `gorm:"column:output_price;default:0" description:"每百万 output token 微分，0=按 kind 统一价"`
	CachePrice  int64  `gorm:"column:cache_price;default:0" description:"每百万 cache_read token 微分，0=按 kind 统一价"`
	Currency    string `gorm:"column:currency;type:varchar(8);default:'CNY'"`

	TagsJSON string `gorm:"column:tags_json;type:varchar(512)" description:"能力标签，JSON 数组"`
	Summary  string `gorm:"column:summary;type:varchar(256)" description:"一句话说明，门户卡片上那行"`

	// ReferralBps 被邀请人买这个模型的套餐时，按实付积分返给邀请人的比例，单位万分之一。
	// NULL 表示没单独设、走全局默认；0 是「这个模型不返」，两者不是一回事，所以用指针。
	ReferralBps *int64 `gorm:"column:referral_bps" description:"分享返现比例（万分之一），NULL 走全局默认"`

	Listed      bool      `gorm:"column:listed;default:true;index:idx_gx_model_listed,priority:2"`
	Featured    bool      `gorm:"column:featured;default:false" description:"首页精选位"`
	SortOrder   int       `gorm:"column:sort_order;default:0"`
	CreatedTime time.Time `gorm:"column:created_time;autoCreateTime"`
	UpdatedTime time.Time `gorm:"column:updated_time;autoUpdateTime"`
}

func (r *GalaxyModel) TableName() string { return "zt_galaxy_model" }
func (r *GalaxyModel) Init()             {}

// GalaxyLead 门户「联系我们」留下的线索。
//
// 这是全站唯一一条**未鉴权就能写库**的路径，所以字段刻意都短：留言 1000 字封顶，
// 其余全是 varchar(128) 以内。IP 与 UA 只为限流与排查留着，不进任何对外视图。
type GalaxyLead struct {
	ID      int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_lead,priority:1;index:idx_gx_lead_status,priority:1;index:idx_gx_lead_ip,priority:1"`
	LeadID  string `gorm:"column:lead_id;type:varchar(64);uniqueIndex:uk_gx_lead,priority:2"`

	Name    string `gorm:"column:name;type:varchar(64)"`
	Contact string `gorm:"column:contact;type:varchar(128)" description:"邮箱/手机/微信，来访者自己选一种"`
	Company string `gorm:"column:company;type:varchar(128)"`
	Topic   string `gorm:"column:topic;type:varchar(32)" description:"enterprise/support/business/other"`
	Scale   string `gorm:"column:scale;type:varchar(32)" description:"预估用量档，来访者自述"`
	Message string `gorm:"column:message;type:varchar(1000)"`

	Source    string `gorm:"column:source;type:varchar(32)" description:"来源页面，默认 portal"`
	IP        string `gorm:"column:ip;type:varchar(64);index:idx_gx_lead_ip,priority:2"`
	UserAgent string `gorm:"column:user_agent;type:varchar(256)"`

	Status      string     `gorm:"column:status;type:varchar(16);index:idx_gx_lead_status,priority:2" description:"new/handled/closed"`
	HandledBy   string     `gorm:"column:handled_by;type:varchar(64)"`
	HandledAt   *time.Time `gorm:"column:handled_at;type:timestamp null default null"`
	CreatedTime time.Time  `gorm:"column:created_time;autoCreateTime;index:idx_gx_lead_status,priority:3,sort:desc;index:idx_gx_lead_ip,priority:3,sort:desc"`
	UpdatedTime time.Time  `gorm:"column:updated_time;autoUpdateTime"`
}

func (r *GalaxyLead) TableName() string { return "zt_galaxy_lead" }
func (r *GalaxyLead) Init()             {}

// ---------- 使用者积分与分享 ----------
//
// 使用者的钱只有一种形态：积分，1 积分 = ¥1。运营在管理端充进来，买套餐时花掉，
// 邀请来的人买套餐时按模型的比例返一部分进来。库里存「微积分」，和 amount / price
// 同一量纲（÷1_000_000 得到积分），所以套餐价直接就是积分价，不用再折算一次。
//
// 和提供者那本 GalaxyCreditAccount 不是一回事：那本是出算力赚的、按 PayoutRate
// 折成钱提走的；两批人、两种来路、两套规则，合在一张表里迟早有一边被另一边的规则误伤。

// GalaxyPointsAccount 使用者的积分余额。行不存在就是 0。
type GalaxyPointsAccount struct {
	ID          int64     `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine     string    `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_points_account,priority:1"`
	OwnerUserID string    `gorm:"column:owner_user_id;type:varchar(64);uniqueIndex:uk_gx_points_account,priority:2" description:"使用端账号 cu_…"`
	Balance     int64     `gorm:"column:balance" description:"微积分"`
	UpdatedTime time.Time `gorm:"column:updated_time;autoUpdateTime"`
}

func (r *GalaxyPointsAccount) TableName() string { return "zt_galaxy_points_account" }
func (r *GalaxyPointsAccount) Init()             {}

// GalaxyPointsLedger 积分流水。余额的每一次变动都有一行，而且和余额在同一个事务里写 ——
// 「余额少了但查不到为什么」是账务上最不能出现的一种状态。
//
// 管理端的「充值明细」就是这里 type=recharge 的那些行，不另建一张表：两处各记一份，
// 对不上的时候谁也说不清哪边是对的。
type GalaxyPointsLedger struct {
	ID          int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine     string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_points_ledger,priority:1;index:idx_gx_points_ledger_owner,priority:1;index:idx_gx_points_ledger_type,priority:1"`
	TxnID       string `gorm:"column:txn_id;type:varchar(96);uniqueIndex:uk_gx_points_ledger,priority:2" description:"幂等键：recharge:<请求号> / order:<订单号>:pay|refund|referral"`
	OwnerUserID string `gorm:"column:owner_user_id;type:varchar(64);index:idx_gx_points_ledger_owner,priority:2"`
	Type        string `gorm:"column:type;type:varchar(16);index:idx_gx_points_ledger_type,priority:2" description:"recharge/purchase/referral"`

	Amount       int64 `gorm:"column:amount" description:"微积分，入账为正、出账为负"`
	BalanceAfter int64 `gorm:"column:balance_after"`
	// BaseAmount 这笔是按什么算出来的：充值是实付金额（微元），返现是那笔购买实付的积分。
	BaseAmount int64 `gorm:"column:base_amount" description:"充值=实付金额（微元）；返现=那笔购买实付的积分"`
	// RateBps 返现当时用的比例。比例改了不影响已经返过的，账上要能看出当时是按多少算的。
	RateBps int64 `gorm:"column:rate_bps" description:"返现比例快照（万分之一）"`

	OrderID       string    `gorm:"column:order_id;type:varchar(64)"`
	RelatedUserID string    `gorm:"column:related_user_id;type:varchar(64)" description:"返现：下单的被邀请人"`
	ModelID       string    `gorm:"column:model_id;type:varchar(96)"`
	Remark        string    `gorm:"column:remark;type:varchar(256)"`
	Operator      string    `gorm:"column:operator;type:varchar(64)" description:"运营充值：经手的管理端账号"`
	CreatedAt     time.Time `gorm:"column:created_at;autoCreateTime;index:idx_gx_points_ledger_owner,priority:3;index:idx_gx_points_ledger_type,priority:3"`
}

func (r *GalaxyPointsLedger) TableName() string { return "zt_galaxy_points_ledger" }
func (r *GalaxyPointsLedger) Init()             {}

// GalaxyReferral 使用者的邀请码与「谁邀请了他」。一个使用端账号一行。
//
// 不挂在 zt_galaxy_consumer_user 上：邀请码要唯一索引，而老账号在第一次打开分享页
// 之前没有码，那一列会有一片空串直接撞唯一键。老账号没有行，第一次打开分享页时补上。
type GalaxyReferral struct {
	ID         int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine    string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_referral_user,priority:1;uniqueIndex:uk_gx_referral_code,priority:1;index:idx_gx_referral_inviter,priority:1"`
	UserID     string `gorm:"column:user_id;type:varchar(64);uniqueIndex:uk_gx_referral_user,priority:2" description:"使用端账号 cu_…"`
	InviteCode string `gorm:"column:invite_code;type:varchar(16);uniqueIndex:uk_gx_referral_code,priority:2" description:"这个人的邀请码，大写"`
	// InvitedBy 注册时用的是谁的邀请码。注册之后不能改：改得动的话，返现归谁就成了谁先去找运营的问题。
	InvitedBy   string    `gorm:"column:invited_by;type:varchar(64);index:idx_gx_referral_inviter,priority:2" description:"邀请人 cu_…，空表示自己注册的"`
	CreatedTime time.Time `gorm:"column:created_time;autoCreateTime;index:idx_gx_referral_inviter,priority:3"`
}

func (r *GalaxyReferral) TableName() string { return "zt_galaxy_referral" }
func (r *GalaxyReferral) Init()             {}

// GalaxySetting 运营在后台改的零散开关（目前只有全局默认返现比例）。
//
// 部署参数进 application.properties，这里只放「运营随时要改、改完不该重启」的东西。
type GalaxySetting struct {
	ID          int64     `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine     string    `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_setting,priority:1"`
	SettingKey  string    `gorm:"column:setting_key;type:varchar(64);uniqueIndex:uk_gx_setting,priority:2"`
	Value       string    `gorm:"column:value;type:varchar(1024)"`
	UpdatedBy   string    `gorm:"column:updated_by;type:varchar(64)"`
	UpdatedTime time.Time `gorm:"column:updated_time;autoUpdateTime"`
}

func (r *GalaxySetting) TableName() string { return "zt_galaxy_setting" }
func (r *GalaxySetting) Init()             {}

// ---------- ai-bridge 的版本分发 ----------

// GalaxyBridgeRelease 一个已发布的 ai-bridge 安装包（一个版本一个平台一行）。
//
// 字节在 OSS，这里只有「哪个版本、哪个平台、多大、校验值、签名」。签名是 Ed25519，
// 签的是版本 + 平台 + sha256 三样，私钥离线保管、公钥编进 ai-bridge 自己 ——
// 节点只装验得过签名的包。远程升级敢做就是因为这一条：Hub、数据库、OSS 里任何
// 一个被人改了，推下去的东西也装不上（节点不信任 Hub，见 doc/galaxy 的原则 8）。
//
// 下架不删行：机器上报的版本要能对得上它当初装的是哪一个包。
type GalaxyBridgeRelease struct {
	ID         int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine    string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_bridge_release_id,priority:1;uniqueIndex:uk_gx_bridge_release_target,priority:1;index:idx_gx_bridge_release_platform,priority:1"`
	ReleaseID  string `gorm:"column:release_id;type:varchar(40);uniqueIndex:uk_gx_bridge_release_id,priority:2" description:"业务键 br_…"`
	Version    string `gorm:"column:version;type:varchar(32);uniqueIndex:uk_gx_bridge_release_target,priority:2" description:"语义版本，如 0.2.0"`
	Platform   string `gorm:"column:platform;type:varchar(32);uniqueIndex:uk_gx_bridge_release_target,priority:3;index:idx_gx_bridge_release_platform,priority:2" description:"linux-x64 / darwin-arm64 / windows-x64 …"`
	FileName   string `gorm:"column:file_name;type:varchar(128)" description:"ai-bridge-<版本>-<平台>.tar.gz（windows 是 .zip）"`
	ObjectKey  string `gorm:"column:object_key;type:varchar(255)" description:"OSS 对象键，含部署配置的 prefix"`
	Size       int64  `gorm:"column:size" description:"字节数"`
	SHA256     string `gorm:"column:sha256;type:varchar(64)" description:"整个压缩包的 sha256，小写十六进制"`
	Signature  string `gorm:"column:signature;type:varchar(128)" description:"发布签名（Ed25519，base64）"`
	Notes      string `gorm:"column:notes;type:text" description:"版本说明"`
	Status     string `gorm:"column:status;type:varchar(16);index:idx_gx_bridge_release_platform,priority:3" description:"published/withdrawn"`
	PublishedBy string `gorm:"column:published_by;type:varchar(64)" description:"上传的管理端账号"`
	PublishedAt *time.Time `gorm:"column:published_at;type:timestamp null default null"`

	CreatedTime time.Time `gorm:"column:created_time;autoCreateTime"`
	UpdatedTime time.Time `gorm:"column:updated_time;autoUpdateTime"`
}

func (r *GalaxyBridgeRelease) TableName() string { return "zt_galaxy_bridge_release" }
func (r *GalaxyBridgeRelease) Init()             {}

// GalaxyProviderReferral 共享端的邀请码与「谁邀请了他」。一个共享端账号一行。
//
// 和使用端那张 GalaxyReferral 分开：两端是两批人（pu_ / cu_），邀请码的命名空间
// 混在一起时，一个共享端的码被填进 Orbit 的注册页会「查得到但返错人」。
// 一个人两边都玩就各有一个码，各返各的。
type GalaxyProviderReferral struct {
	ID         int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine    string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_provider_referral_user,priority:1;uniqueIndex:uk_gx_provider_referral_code,priority:1;index:idx_gx_provider_referral_inviter,priority:1"`
	UserID     string `gorm:"column:user_id;type:varchar(64);uniqueIndex:uk_gx_provider_referral_user,priority:2" description:"共享端账号 pu_…"`
	InviteCode string `gorm:"column:invite_code;type:varchar(16);uniqueIndex:uk_gx_provider_referral_code,priority:2" description:"这个人的邀请码，大写"`
	// InvitedBy 注册时用的是谁的邀请码。注册之后不能改：改得动的话，
	// 返现归谁就成了谁先去找运营的问题。
	InvitedBy   string    `gorm:"column:invited_by;type:varchar(64);index:idx_gx_provider_referral_inviter,priority:2" description:"邀请人 pu_…，空表示自己注册的"`
	CreatedTime time.Time `gorm:"column:created_time;autoCreateTime;index:idx_gx_provider_referral_inviter,priority:3"`
}

func (r *GalaxyProviderReferral) TableName() string { return "zt_galaxy_provider_referral" }
func (r *GalaxyProviderReferral) Init()             {}
