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

	// 机器上那两个**外部工具**（claude / codex）：装没装、什么版本、正在装的走到哪了。
	// 和上面那组升级列讲的不是一回事 —— 那组升的是 ai-bridge 自己。
	//
	// ToolsJSON 是节点每次心跳自报的一份 dto.NodeToolReport 数组。只在**内容真的变了**
	// 的时候才写（同 upstream_usage_json 的规矩）：不比就写是每台机器每天四千多次空 UPDATE。
	// 老版本节点不报，一直是空串 —— 界面上那一格什么都不画，不是「一个工具都没装」。
	ToolsJSON string `gorm:"column:tools_json;type:text" description:"节点自报的本机工具（claude/codex）版本与安装进度，JSON"`
	// 待下发的「装 / 升某个工具」指令。同一台机器同时只排一条：npm 全局安装本来就
	// 不该两个一起跑，而且挂在节点这一行上，心跳不用多查一次。
	ToolCommandID   string     `gorm:"column:tool_command_id;type:varchar(40)" description:"工具指令 id，节点在心跳里原样报回，对不上的一律忽略"`
	ToolCommandName string     `gorm:"column:tool_command_name;type:varchar(32)" description:"要装 / 升的工具名：claude 或 codex"`
	ToolCommandAt   *time.Time `gorm:"column:tool_command_at;type:timestamp null default null" description:"控制台点下那一刻；超过时限还没人领就作废"`

	// 远端登录（claude / codex）。和上面那组工具指令是**两条独立的槽**：
	// 一台机器可以一边装 codex 一边登录 claude，共用一个槽会互相顶掉。
	//
	// LoginsJSON 是节点每次心跳自报的一份 dto.NodeLoginReport 数组，规矩同 ToolsJSON。
	LoginsJSON string `gorm:"column:logins_json;type:text" description:"节点自报的登录会话（授权地址、短码、进度），JSON"`
	// LoginCommandCode 主人在控制台粘回来的授权码，等着搭下一跳心跳送过去。
	//
	// 空串 = 这条指令是「起一次登录」；有值 = 「这是你要的那串码」。两者 id 相同。
	// 存明文是有意的：它是一次性的、几分钟就过期的授权码，不是凭据 —— 换来的 token
	// 只落在那台机器上，Hub 这边从头到尾看不到。用完即清（见 clearLoginCommand）。
	LoginCommandID   string     `gorm:"column:login_command_id;type:varchar(40)" description:"登录指令 id，节点在心跳里原样报回"`
	LoginCommandName string     `gorm:"column:login_command_name;type:varchar(32)" description:"要登录的工具名：claude 或 codex"`
	LoginCommandCode string     `gorm:"column:login_command_code;type:varchar(255)" description:"主人粘回来的一次性授权码，送达后即清"`
	LoginCommandAt   *time.Time `gorm:"column:login_command_at;type:timestamp null default null" description:"控制台点下那一刻；超过时限还没人领就作废"`

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

// GalaxyLoginRecord 两端的登录留痕，成功与失败都记。
//
// 它是**证据**，不是闸门：连续失败的判定在 Redis 上（见 service/galaxy/account
// 的 LoginGuard），那边只留一个会自己过期的计数。谁在什么时候、从哪儿试了多少次
// 这件事只有这张表答得上来 —— 没有它，被爆破过一轮之后，库里和日志里都不会留下
// 任何痕迹。
//
// 和账号表不一样，这张表**不按端分**：端只是一列。分表是为了「不带端的查询捞不到
// 另一端的人」，那条理由在账号表上成立（漏写 side 会把别人的账号当成本人），
// 在流水上不成立 —— 漏写 side 最多是多看到几行，而追一个人在两端都被试过什么，
// 恰恰需要一次查两端。
//
// Username 记的是**用户输进来的那个名字**（规范化之后），账号不存在时照样记：
// 「有人拿着一串不存在的用户名在扫」本身就是要留下来的事实。UserID 那时是空的。
type GalaxyLoginRecord struct {
	ID      int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);index:idx_gx_login_name,priority:1;index:idx_gx_login_ip,priority:1"`
	Side    string `gorm:"column:side;type:varchar(16);index:idx_gx_login_name,priority:2" description:"provider=共享端；consumer=使用端"`

	UserID   string `gorm:"column:user_id;type:varchar(40)" description:"账号业务键，用户名不存在时为空"`
	Username string `gorm:"column:username;type:varchar(64);index:idx_gx_login_name,priority:3" description:"用户输入的登录名，已小写"`
	// IP 取 X-Forwarded-For 的第一跳，**可以伪造**（见 httpx.ClientIP）。
	// 只作线索，不作判定依据。
	IP        string `gorm:"column:ip;type:varchar(64);index:idx_gx_login_ip,priority:2"`
	UserAgent string `gorm:"column:user_agent;type:varchar(256)"`

	Success bool   `gorm:"column:success;default:false"`
	Reason  string `gorm:"column:reason;type:varchar(128)" description:"失败原因，只给运营看，不回给客户端"`

	CreatedTime time.Time `gorm:"column:created_time;autoCreateTime;index:idx_gx_login_name,priority:4,sort:desc;index:idx_gx_login_ip,priority:3,sort:desc"`
}

func (r *GalaxyLoginRecord) TableName() string { return "zt_galaxy_login_record" }
func (r *GalaxyLoginRecord) Init()             {}

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

	// ModelsAvailableJSON 是**节点报上来的事实**：上游现在有哪些模型。
	// 它不是规则，任何判定都不看它 —— 只给界面当标注（「这台机器有」），
	// 免得主人得自己记住上游有什么。
	ModelsAvailableJSON string `gorm:"column:models_available_json;type:varchar(4096)" description:"节点上报的上游可用模型名"`
	// GroupsJSON 主人确认加入的**模型分组**（mg_…）数组，是这条贡献**唯一**的范围闸：
	// 分组不在名单里，这台机器就接不到那个分组的单；分组属于某一个模型，所以
	// 「提供哪些模型能力」也由它回答。
	//
	// 2026-09-22 之前旁边还有 models_allow_json / models_deny_json 两列通配名单，
	// 已经随分组体系一并撤掉（见 20260922_galaxy_contribution_drop_model_list.sql）——
	// 两个维度各拦一半时，一条被拦下的单在界面上看不出是哪一道闸拦的。
	//
	// 空 = 不限（存量贡献），迁移那一刻没有任何机器会掉出候选。
	GroupsJSON string `gorm:"column:groups_json;type:varchar(4096)" description:"加入的模型分组数组，空=不限"`
	// UpstreamUsageJSON 节点自报的**上游订阅余量**（Claude / Codex 自己的 5 小时、
	// 周限额）。和 zt_galaxy_quota_grant 是两回事：那张表是主人打算放多少出去，
	// 这一列是上游实际还让跑多少。
	//
	// 数从哪来：节点定时问本机的 claude / codex 自己（`claude /usage`、codex `/status`，
	// 见 pool/usage_probe.rs），五分钟一轮，随心跳上报。**不再是从中转响应头里捎** ——
	// 那条路给不出「5 小时窗口还剩多少、这一周还剩多少」，而且机器闲着时不更新。
	//
	// 它现在**进决策路径**：UpstreamFloorJSON 那条线以它为准（见 upstreamfloor.go）。
	// 原先这里写着「只给人看、不参与派单」，理由是自报的数没法验证、上游的形状会变 ——
	// 那两条现在仍然成立，所以判定只在**认得出来的窗口上**做，认不出来、没采到、
	// 解不动一律当成「不知道」，放行而不是拦下：一台探不到余量的机器该照常接单。
	UpstreamUsageJSON string `gorm:"column:upstream_usage_json;type:varchar(4096)" description:"节点自报的上游订阅余量"`
	// UpstreamUsageAt 上面那份数是什么时候收到的。界面必须显示它：
	// 探针五分钟才跑一次，而且可能连着几轮没采到（CLI 没装、超时）。
	UpstreamUsageAt *time.Time `gorm:"column:upstream_usage_at;type:timestamp null default null" description:"上游余量的观测时刻"`
	// UpstreamFloorJSON 主人设的**余量下限**：上游某个窗口只剩这么多的时候就不再接单。
	//
	// 形状是 [{"window":"5h","percent":10}]，window 为空表示任一窗口。
	// 它和上面那一列是「规则」与「事实」的关系，也是 UpstreamUsageJSON 从
	// 「只给人看」变成进决策路径的那一步：主人按这条线保住自己要用的那部分订阅，
	// 而不是等额度被别人跑光之后才发现。
	//
	// 必填，默认 [{"window":"","percent":0}] —— 剩 0 才停，也就是不额外保护。
	// 空字符串按这个默认解，老行不必回填。
	UpstreamFloorJSON string `gorm:"column:upstream_floor_json;type:varchar(512)" description:"上游余量下限：剩余百分比低到这儿就不接单"`
	Seats             int    `gorm:"column:seats;default:3" description:"同时服务的消费者数量上限"`
	SeatConcurrency   int    `gorm:"column:seat_concurrency;default:2" description:"单座位并发上限"`
	ScheduleJSON      string `gorm:"column:schedule_json;type:varchar(512)" description:"挂机时段"`

	Status string `gorm:"column:status;type:varchar(16);index:idx_gx_contribution_node,priority:3" description:"active/draining/paused/disabled"`
	// PendingStatus 主人点了关闭、但那会儿还有请求在跑，等在途归零之后要落到的状态。
	//
	// 不塞进 Status：draining 那个值是心跳按额度自己写的，每个心跳都会在
	// active / draining 之间来回改。主人的意图放同一列会在下一个心跳被冲掉，
	// 表现是「关了又自己开回来」。意图和额度是两个独立的事实，必须两列。
	PendingStatus string `gorm:"column:pending_status;type:varchar(16)" description:"等在途请求跑完之后要落到的状态"`
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
	ID      int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_quota_window,priority:1;index:idx_gx_quota_window_key,priority:1"`
	CID     string `gorm:"column:cid;type:varchar(96);uniqueIndex:uk_gx_quota_window,priority:2"`
	Unit    string `gorm:"column:unit;type:varchar(48);uniqueIndex:uk_gx_quota_window,priority:3"`
	// WindowKey 单独再进一条索引：唯一键是按 cid 打头的，而「全池此刻还剩多少额度」
	// 那个查询手上只有窗口键、没有 cid —— 跳过第二列就用不上唯一键，只能全表扫。
	// 这张表按 (cid, unit, 窗口键) 一行一行地堆，旧窗口不清，所以它不是一张小表。
	WindowKey string `gorm:"column:window_key;type:varchar(24);uniqueIndex:uk_gx_quota_window,priority:4;index:idx_gx_quota_window_key,priority:2"`

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
	// Effort 这一次上游实际跑的推理强度（已按分组的档位表夹过）。
	// 它**不再是计价键**（价钱按 GroupID 收），只作记录与排障：
	// 「这个人买的是标准分组，而客户端一直在要 max 档」这件事只有这一列答得出来。
	Effort string `gorm:"column:effort;type:varchar(16)" description:"上游实际跑的推理强度，只作记录"`
	// GroupID 这一次落在哪个模型分组上。它和 Model 一样是**计价键**，所以必须落在单元行上：
	// 账单（Usage）、争议追回（dispute）都在事后重新取价，那时唯一能回答「当初按哪个分组收的」
	// 就是这一列。Redis 里那份信封活不过保留期，老单元只剩这张表。
	GroupID string `gorm:"column:group_id;type:varchar(64)" description:"模型分组，计价键的一部分"`
	// Fast 这一次是不是按快速跑的。分组没开快速时恒为 false —— 客户端要了也不算数。
	Fast bool `gorm:"column:fast;default:false" description:"是否按快速跑"`

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
	// GroupsJSON 这把密钥选中的模型分组（mg_…）数组。**签发时必选**（见 CreateConsumerKey），
	// 一个模型最多选一个分组 —— 同一个模型选两个分组，一次请求就没法回答「按哪份价收」。
	//
	// 空 = 存量密钥：每个模型落在它的默认分组上，行为和加分组之前一样。
	GroupsJSON  string `gorm:"column:groups_json;type:varchar(1024)" description:"选中的模型分组数组，空=不限"`
	Concurrency int    `gorm:"column:concurrency;default:4"`
	RPM         int    `gorm:"column:rpm;default:120"`

	Status      string     `gorm:"column:status;type:varchar(16);index:idx_gx_consumer_key_owner,priority:3" description:"active/expired/frozen/revoked"`
	IssuedAt    time.Time  `gorm:"column:issued_at;type:timestamp null default null"`
	ExpiresAt   time.Time  `gorm:"column:expires_at;type:timestamp null default null" description:"到期后请求返回 key_expired"`
	FrozenUntil *time.Time `gorm:"column:frozen_until;type:timestamp null default null" description:"冻结期内可续期换发"`
	RenewedFrom string     `gorm:"column:renewed_from_key_id;type:varchar(64)"`

	// 数据告知：密钥签发时必须记录消费者确认（C-13）。
	//
	// 注册时默认送的那一把是唯一的例外：那一刻人还没看过告知，所以两列都是空的
	// （notice_version = '' 且 notice_ack_at IS NULL）。留空而不是记个签发时间，
	// 是为了让「这把密钥背后有没有一次确认」在库里一眼分得出来。
	NoticeVersion string     `gorm:"column:notice_version;type:varchar(32)"`
	NoticeAckAt   *time.Time `gorm:"column:notice_ack_at;type:timestamp null default null"`

	CreatedTime time.Time `gorm:"column:created_time;autoCreateTime"`
	UpdatedTime time.Time `gorm:"column:updated_time;autoUpdateTime"`
}

func (r *GalaxyConsumerKey) TableName() string { return "zt_galaxy_consumer_key" }
func (r *GalaxyConsumerKey) Init()             {}

// GalaxyConsumerBalance 密钥的单位余额。P0 只记账不扣款，扣减在 P1 接支付后生效。
//
// ModelID 空串是**通用额度**：任何模型都能用它，不是「某个叫空串的模型」。
// 按模型打包卖的包（opus 打八折、sonnet 打六折）必须按模型分开记 ——
// 合并成一份通用 token 额度的话，买的人会把它全拿去跑最贵的那个模型，
// 付的是混合折扣价、用的是单价最高的模型，而账面上一点异常都看不出来。
//
// 扣的时候先扣这个模型自己的那份，扣不动再扣通用那份（见 service 的 consumeBalance）。
type GalaxyConsumerBalance struct {
	ID      int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_consumer_balance,priority:1"`
	KeyID   string `gorm:"column:key_id;type:varchar(64);uniqueIndex:uk_gx_consumer_balance,priority:2"`
	// NOT NULL DEFAULT '' 不是装饰：唯一索引不拦 NULL，可空的话同一把密钥、
	// 同一个单位能插进两行 model_id 为 NULL 的余额，扣的时候先扣到哪行全看运气。
	ModelID     string    `gorm:"column:model_id;type:varchar(96);not null;default:'';uniqueIndex:uk_gx_consumer_balance,priority:3" description:"模型名，空=通用额度"`
	Unit        string    `gorm:"column:unit;type:varchar(48);uniqueIndex:uk_gx_consumer_balance,priority:4"`
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

// GalaxyPrice 「kind × 模型 × 单位 → 单价」表。中转站按 token 计价，input 与 output 分别定价（D-02）。
//
// 一行里有**两个独立的价**：Price 是向使用者收的，ProviderPrice 是付给共享者的，
// 差额是平台毛利。原先只有 Price 加一个 ProviderShare 比例，于是上游价是下游价的
// 函数 —— 调一次下游价就自动改了所有共享者的收入，而共享者拿自己的积分一除
// 就能反推出平台抽了几成。两个价各存各的之后，这两件事互不牵连。
//
// ModelID 空串是**该 kind 的兜底价**，不是「某个叫空串的模型」；GroupID 空串同理，
// 是「该模型的通价」。取价由粗到细三级盖：kind 兜底 → 模型通价 → 分组价。原先整张表只按 kind 定价：opus 和 haiku 都是
// llm.chat，同样的 token 给共享者的钱一模一样，而门户上两者的标价能差几十倍 ——
// 平台毛利于是随使用者调哪个模型剧烈漂移，且没有任何地方拦得住。
type GalaxyPrice struct {
	ID      int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_price,priority:1"`
	Kind    string `gorm:"column:kind;type:varchar(64);uniqueIndex:uk_gx_price,priority:2"`
	// ModelID 这一行管哪个模型。空串 = 该 kind 的兜底价，模型没单独定价时按它算。
	// NOT NULL DEFAULT '' 不是装饰：MySQL 的唯一索引**不拦 NULL**，
	// 这一列要是可空，两行「同 kind 同单位同生效时刻、model_id 都是 NULL」能一起插进去，
	// 取价时先拿到哪行全看运气。加列的迁移也靠这个默认值把存量行落成兜底价。
	ModelID string `gorm:"column:model_id;type:varchar(96);not null;default:'';uniqueIndex:uk_gx_price,priority:3" description:"模型名，空=该 kind 的兜底价"`
	// GroupID 这一行管哪个**模型分组**。空串 = 该模型的通价，没单独定价的分组都按它算。
	//
	// 和 ModelID 完全同构，连「为什么必须 NOT NULL DEFAULT ''」的理由都一样：
	// MySQL 的唯一索引不拦 NULL，可空会让两行「同 kind 同模型同单位同生效时刻、
	// group_id 都是 NULL」一起插进去，取价时先拿到哪行全看运气。
	//
	// 这一列**取代了原先的 effort**（20260922_galaxy_model_group.sql）。推理强度不再是
	// 计价维度，而是分组的属性：一个分组卖哪几档、卖不卖快速，价钱按分组收一份。
	// 两个维度都留在表上是危险的 —— 取价只看其中一个，另一个就能躺下一行永远匹配不上的价。
	//
	// 这一列不校验「这个分组属不属于这个模型」：价目表是账，分组删了、模型下架了，
	// 老账行都还要读得出来。
	GroupID       string    `gorm:"column:group_id;type:varchar(64);not null;default:'';uniqueIndex:uk_gx_price,priority:4" description:"模型分组，空=该模型的通价"`
	Unit          string    `gorm:"column:unit;type:varchar(48);uniqueIndex:uk_gx_price,priority:5"`
	EffectiveFrom time.Time `gorm:"column:effective_from;type:timestamp null default null;uniqueIndex:uk_gx_price,priority:6"`
	// Price 是每百万单位的价格（微分），避免浮点累积误差。
	Price    int64  `gorm:"column:price" description:"对外单价：每百万单位微分"`
	Currency string `gorm:"column:currency;type:varchar(8);default:'CNY'"`
	// ProviderPrice 结算单价：每百万单位付给共享者多少微分。0 表示这一行还没迁移过，
	// 结算回落到 ProviderShare —— 回落是给存量数据留的过渡，不是「免费」的意思。
	// 真要不给钱就把 ProviderShare 一起设成 0。
	ProviderPrice int64 `gorm:"column:provider_price;default:0" description:"结算单价：每百万单位微分，0=回落到 provider_share"`
	// ProviderShare 老口径：提供者拿走下游金额的几成。只在 ProviderPrice 为 0 时还起作用。
	// 存量行迁移完（见 migrations/20260919_galaxy_provider_price.sql）就只剩历史意义。
	ProviderShare float64 `gorm:"column:provider_share;default:0.7" description:"旧口径分成比例，仅当 provider_price=0 时回落使用"`
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
	ID          int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine     string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_provider_ledger,priority:1;index:idx_gx_provider_ledger_cid,priority:1"`
	TxnID       string `gorm:"column:txn_id;type:varchar(96);uniqueIndex:uk_gx_provider_ledger,priority:2"`
	CID         string `gorm:"column:cid;type:varchar(96);index:idx_gx_provider_ledger_cid,priority:2"`
	OwnerUserID string `gorm:"column:owner_user_id;type:varchar(64)"`
	Type        string `gorm:"column:type;type:varchar(16)" description:"contribute/settle/payout/clawback/referral/ref_clawback"`
	// Unit 这笔积分是**哪种计量单位**挣来的（settle / clawback），或者 credit（提现、邀请奖励）。
	Unit string `gorm:"column:unit;type:varchar(48)"`
	// Amount 一律是**微积分**（1,000,000 = 1 积分 = ¥1），和信用账户余额同一量纲。
	//
	// 不是计量数：原先 settle 行记的是 token 数，于是收益页上「今天赚了多少」加的是 token、
	// 「可提现」用的是余额里的钱，两个口径根本不是一个东西。原始计量数在
	// zt_galaxy_meter_record 里（对账以它求和为准），这一列只回答「这笔挣了多少」。
	Amount int64  `gorm:"column:amount" description:"微积分，1,000,000 = 1 积分 = ¥1"`
	Price  int64  `gorm:"column:price"`
	UnitID string `gorm:"column:unit_id;type:varchar(40)"`
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
	// ItemsJSON 按模型拆开的构成：[{modelId, kind, units, discountBps}]。
	//
	// 它是模型包的**唯一事实**：UnitsJSON 与 Amount 都由它算出来（数量 × 对外单价
	// × 折扣），运营填的是数量和折扣，售价不经手。空串表示这是个遗留包 ——
	// 建它的时候还没有按模型定价，只有一份合计额度和一个手填的售价。
	//
	// 用 text 而不是 varchar：一个包能装下十几个模型 × 四档计量单位，
	// varchar(1024) 在第五六个模型上就会被 MySQL 截断，而截断不报错，
	// 只会让这个包少发几档额度。
	ItemsJSON string `gorm:"column:items_json;type:text" description:"按模型拆开的构成，空为遗留包"`
	// UnitsJSON 是这份商品给的额度：单位 → 数量。模型包由 ItemsJSON 摊平而来，
	// 只供展示与老路径使用 —— 发额度按 ItemsJSON 分模型发，不按它。
	UnitsJSON string `gorm:"column:units_json;type:varchar(1024)"`
	// Amount 售价，单位微分；与 price 表同一量纲，便于对账。
	// 模型包的这个数由服务端算出来写进去，是**成交价**：之后单价再调，
	// 已经在卖的包还按它卖，直到运营重新保存一次。
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
	// ItemsJSON 下单那一刻**按模型拆开**的额度快照，履约就照它发。
	// 空的是老订单（或遗留包下的单）：那时没有按模型分账，整份落进通用额度。
	ItemsJSON string `gorm:"column:items_json;type:text" description:"按模型拆开的额度快照，空则整份落通用额度"`
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

	// 四个单价都是「每百万 token 的微分」，与 zt_galaxy_price 同口径。
	// 0 表示这个模型不单独定价，按 kind 的统一价走 —— 不是「免费」。
	//
	// 四个桶互不重叠：InputPrice 对的是**未命中缓存的新增输入**（Hub 在 relay 的
	// netInput 里已经把 OpenAI 那边含在 input 里的 cached 减掉了），缓存读与缓存写
	// 各自一档。合成一档的话必有一边算错：缓存写入通常比普通输入还贵，
	// 缓存读取却便宜一个数量级。

	// ListInputPrice / ListOutputPrice / ListCachePrice 官方参考价，口径与上面几档完全一致
	// （每百万 token 微分、同一币种）。模型广场拿它划那道线、算「省 X%」。必须是运营填进来的事实：
	// 上游改价我们不会立刻知道，由代码推一个折扣写上去，性质上就是价格欺诈。
	// 0 = 没填，那一档的划线价不显示（折扣只按输出价算，和缓存这一档无关）。
	//
	// 缓存这一档是后加的（20260920_galaxy_model_list_cache_price.sql）：卡片上是
	// 新增输入 / 输出 / 缓存读取三格，划线价只有两档的话，差价最悬殊的那一格旁边反而没有可比的数。
	ListInputPrice  int64  `gorm:"column:list_input_price;default:0" description:"官方参考价：每百万 input token 微分，0=不显示划线价"`
	ListOutputPrice int64  `gorm:"column:list_output_price;default:0" description:"官方参考价：每百万 output token 微分，0=不显示划线价"`
	ListCachePrice  int64  `gorm:"column:list_cache_price;default:0" description:"官方参考价：每百万 cache read token 微分，0=这一档不显示"`
	Currency        string `gorm:"column:currency;type:varchar(8);default:'CNY'"`

	TagsJSON string `gorm:"column:tags_json;type:varchar(512)" description:"能力标签，JSON 数组"`
	Summary  string `gorm:"column:summary;type:varchar(256)" description:"一句话说明，门户卡片上那行"`

	// BadgeText 卡片右上角那个角标（「首发」「性价比旗舰」「均衡」），空串不显示。
	// 它推不出来：Featured 只有真假两种，而这类词随时间换，是运营的文案。
	// BadgeTone 只认 hot / new / value / neutral，前端映射到既有的四种胶囊配色 ——
	// 让运营直接填颜色的话，迟早出现一张六种颜色的卡片墙。
	BadgeText string `gorm:"column:badge_text;type:varchar(16)" description:"卡片角标文案，空=不显示"`
	BadgeTone string `gorm:"column:badge_tone;type:varchar(16)" description:"角标配色：hot/new/value/neutral"`

	Listed      bool      `gorm:"column:listed;default:true;index:idx_gx_model_listed,priority:2"`
	Featured    bool      `gorm:"column:featured;default:false" description:"首页精选位"`
	SortOrder   int       `gorm:"column:sort_order;default:0"`
	CreatedTime time.Time `gorm:"column:created_time;autoCreateTime"`
	UpdatedTime time.Time `gorm:"column:updated_time;autoUpdateTime"`
}

func (r *GalaxyModel) TableName() string { return "zt_galaxy_model" }
func (r *GalaxyModel) Init()             {}

// GalaxyModelGroup 一个模型底下的**分组**：平台真正在卖的那个单位。
//
// 为什么在「模型」之下再分一层（2026-09-22）：同一个模型可以用得很不一样 ——
// 想得浅一点、想得深一点、要不要走快速通道 —— 而这几种用法在上游那边的成本能差好几倍。
// 原先这两个旋钮由客户端在请求体里自己拨（output_config.effort / reasoning.effort、
// 快速开关），平台按一份价收，差额全由平台垫。
//
// 分组把这件事翻过来：**旋钮是商品的属性，不是调用方的自由**。
// 运营给同一个模型开「标准」「深度」「快速」几个分组，各自一套价；
// 使用者建密钥时选分组，共享者共享时选分组；请求带上来的强度与快速标记一律先过这道闸。
//
// 分组名是对外的，所以**不要把上游的档位名写进去**（low/high/max 这些是上游的内部刻度，
// 把它摆给使用者看，等于让上游的字段名替平台解释自己在卖什么 —— 那正是这次要去掉的东西）。
type GalaxyModelGroup struct {
	ID      int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_model_group,priority:1;uniqueIndex:uk_gx_model_group_name,priority:1;uniqueIndex:uk_gx_model_group_default,priority:1;index:idx_gx_model_group_model,priority:1"`
	GroupID string `gorm:"column:group_id;type:varchar(64);uniqueIndex:uk_gx_model_group,priority:2" description:"业务键 mg_…，对外只露它"`
	ModelID string `gorm:"column:model_id;type:varchar(96);uniqueIndex:uk_gx_model_group_name,priority:2;uniqueIndex:uk_gx_model_group_default,priority:2;index:idx_gx_model_group_model,priority:2"`
	// Name 同一个模型下不重名（uk_gx_model_group_name）。重名的两个分组在任何一处界面上
	// 都分不出来，而它们背后是两套价。
	Name    string `gorm:"column:name;type:varchar(64);uniqueIndex:uk_gx_model_group_name,priority:3"`
	Summary string `gorm:"column:summary;type:varchar(256)"`
	// EffortsJSON 这个分组卖哪几档推理强度。空数组 = 不限（请求带什么就按什么打上游）。
	// 非空时，不在表里的档会被夹到表里**最浅**的一档 —— 夹而不是拒绝，理由见
	// contract.GroupPolicy。
	EffortsJSON string `gorm:"column:efforts_json;type:varchar(512)" description:"绑定的推理强度数组，空=不限"`
	// AllowFast 卖不卖快速。关着的时候，客户端开了快速也不算数：请求体里的标记会被改写掉。
	AllowFast bool `gorm:"column:allow_fast;default:false" description:"是否支持快速"`
	Listed    bool `gorm:"column:listed;default:true;index:idx_gx_model_group_model,priority:3"`
	// IsDefault 该模型的默认分组：老密钥（没选分组）与所有「没指明分组」的路径落在它上面。
	//
	// 指针而不是 bool：唯一索引 uk_gx_model_group_default 靠「NULL 不参与唯一性」
	// 来实现「每个模型最多一个默认分组」，写 0 会让第二个非默认分组撞上唯一键。
	IsDefault   *bool     `gorm:"column:is_default;type:tinyint(1)" description:"1=该模型的默认分组；NULL=不是"`
	SortOrder   int       `gorm:"column:sort_order;default:0;index:idx_gx_model_group_model,priority:4"`
	CreatedTime time.Time `gorm:"column:created_time;autoCreateTime"`
	UpdatedTime time.Time `gorm:"column:updated_time;autoUpdateTime"`
}

func (r *GalaxyModelGroup) TableName() string { return "zt_galaxy_model_group" }
func (r *GalaxyModelGroup) Init()             {}

// Default 这一行是不是默认分组。指针解引用收在这里，调用方不必每次判空。
func (r *GalaxyModelGroup) Default() bool { return r != nil && r.IsDefault != nil && *r.IsDefault }

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
	BizLine     string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_points_ledger,priority:1;index:idx_gx_points_ledger_owner,priority:1;index:idx_gx_points_ledger_type,priority:1;index:idx_gx_points_ledger_unit,priority:1"`
	TxnID       string `gorm:"column:txn_id;type:varchar(96);uniqueIndex:uk_gx_points_ledger,priority:2" description:"幂等键：recharge:<请求号> / usage:<单元>:<尝试> / dispute:<工单>:refund / <充值流水>:referral"`
	OwnerUserID string `gorm:"column:owner_user_id;type:varchar(64);index:idx_gx_points_ledger_owner,priority:2"`
	Type        string `gorm:"column:type;type:varchar(16);index:idx_gx_points_ledger_type,priority:2" description:"recharge/usage/refund/referral；purchase 只剩历史"`

	Amount       int64 `gorm:"column:amount" description:"微积分，入账为正、出账为负"`
	BalanceAfter int64 `gorm:"column:balance_after"`
	// BaseAmount 这笔是按什么算出来的：充值是实付金额（微元），返现是那笔购买实付的积分。
	BaseAmount int64 `gorm:"column:base_amount" description:"充值=实付金额（微元）；返现=那笔购买实付的积分"`
	// RateBps 返现当时用的比例。比例改了不影响已经返过的，账上要能看出当时是按多少算的。
	RateBps int64 `gorm:"column:rate_bps" description:"返现比例快照（万分之一）"`

	OrderID string `gorm:"column:order_id;type:varchar(64)" description:"历史：买额度包那一单"`
	// UnitID 按量扣费与退款指向的那一次请求。账单上的 unitId 就是它，申诉也钉这个 ——
	// 没有它，一行「扣了 2288 微积分」就回答不了「哪一次对话花的」。
	UnitID        string    `gorm:"column:unit_id;type:varchar(64);index:idx_gx_points_ledger_unit,priority:2" description:"按量扣费对应的工作单元"`
	Kind          string    `gorm:"column:kind;type:varchar(32)" description:"按量扣费：调的哪类能力"`
	RelatedUserID string    `gorm:"column:related_user_id;type:varchar(64)" description:"返现：充值的被邀请人"`
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
	ID          int64      `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine     string     `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_bridge_release_id,priority:1;uniqueIndex:uk_gx_bridge_release_target,priority:1;index:idx_gx_bridge_release_platform,priority:1"`
	ReleaseID   string     `gorm:"column:release_id;type:varchar(40);uniqueIndex:uk_gx_bridge_release_id,priority:2" description:"业务键 br_…"`
	Version     string     `gorm:"column:version;type:varchar(32);uniqueIndex:uk_gx_bridge_release_target,priority:2" description:"语义版本，如 0.2.0"`
	Platform    string     `gorm:"column:platform;type:varchar(32);uniqueIndex:uk_gx_bridge_release_target,priority:3;index:idx_gx_bridge_release_platform,priority:2" description:"linux-x64 / darwin-arm64 / windows-x64 …"`
	FileName    string     `gorm:"column:file_name;type:varchar(128)" description:"ai-bridge-<版本>-<平台>.tar.gz（windows 是 .zip）"`
	ObjectKey   string     `gorm:"column:object_key;type:varchar(255)" description:"OSS 对象键，含部署配置的 prefix"`
	Size        int64      `gorm:"column:size" description:"字节数"`
	SHA256      string     `gorm:"column:sha256;type:varchar(64)" description:"整个压缩包的 sha256，小写十六进制"`
	Signature   string     `gorm:"column:signature;type:varchar(128)" description:"发布签名（Ed25519，base64）"`
	Notes       string     `gorm:"column:notes;type:text" description:"版本说明"`
	Status      string     `gorm:"column:status;type:varchar(16);index:idx_gx_bridge_release_platform,priority:3" description:"published/withdrawn"`
	PublishedBy string     `gorm:"column:published_by;type:varchar(64)" description:"上传的管理端账号"`
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

// ---------- 桌面客户端（Nova / Orbit）的版本分发 ----------

// GalaxyDesktopRelease 一次桌面客户端发版：一个端 × 一个平台通道 × 一个版本一行。
//
// 和 ai-bridge 那张表最大的不同是**字节不经服务端**：安装包一百多兆，管理端的浏览器
// 拿签名地址直传 OSS（见 desktoprelease.go）。所以这一行里没有 sha256 —— 校验值在
// 清单里，由 electron-builder 打包时算好（sha512），客户端下载完自己比对。
//
// Manifest 存的就是要写到 OSS 上的那份 latest-*.yml 原文。为什么整份存下来：
//
//   - 它是 electron-builder 的产物，字段随版本会变（blockMapSize、minimumSystemVersion、
//     packages…）。拆成列再拼回去，等于我们要跟着 electron-builder 的格式走一辈子；
//   - 下架要能**回到上一版**：把上一行的原文重新写回去就行，不用重新生成。
//
// 于是 OSS 上那个 latest-*.yml 永远是「这个端这个通道里版本最高的、还在架上的那一行」
// 的 Manifest（syncChannel），客户端只认它。
type GalaxyDesktopRelease struct {
	ID        int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine   string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_desktop_release_id,priority:1;uniqueIndex:uk_gx_desktop_release_target,priority:1;index:idx_gx_desktop_release_channel,priority:1"`
	ReleaseID string `gorm:"column:release_id;type:varchar(40);uniqueIndex:uk_gx_desktop_release_id,priority:2" description:"业务键 dr_…"`
	Product   string `gorm:"column:product;type:varchar(16);uniqueIndex:uk_gx_desktop_release_target,priority:2;index:idx_gx_desktop_release_channel,priority:2" description:"nova=共享端 / orbit=使用端"`
	Channel   string `gorm:"column:channel;type:varchar(16);uniqueIndex:uk_gx_desktop_release_target,priority:3;index:idx_gx_desktop_release_channel,priority:3" description:"mac / win / linux"`
	Version   string `gorm:"column:version;type:varchar(32);uniqueIndex:uk_gx_desktop_release_target,priority:4" description:"语义版本，如 0.1.1"`
	// ManifestFile 这个通道在 OSS 上的清单文件名：latest-mac.yml / latest.yml / latest-linux.yml。
	// 名字是 electron-updater 定死的，客户端按平台去取哪一个不由我们决定。
	ManifestFile string `gorm:"column:manifest_file;type:varchar(64)" description:"latest-mac.yml / latest.yml / latest-linux.yml"`
	Manifest     string `gorm:"column:manifest;type:mediumtext" description:"要写到 OSS 上的 latest-*.yml 原文"`
	// FilesJSON 清单里那几个文件的名字与大小，给运营列表用。
	// 真正的下载清单是 Manifest，这里只是为了列表不必每次去解析 yml。
	FilesJSON   string     `gorm:"column:files_json;type:text" description:"[{name,size,sha512}]"`
	Size        int64      `gorm:"column:size" description:"这一版全部文件的字节数之和"`
	Notes       string     `gorm:"column:notes;type:text" description:"版本说明，会写进清单的 releaseNotes，客户端更新提示里原样展示"`
	Status      string     `gorm:"column:status;type:varchar(16);index:idx_gx_desktop_release_channel,priority:4" description:"staging=已登记待上传 / published / withdrawn"`
	PublishedBy string     `gorm:"column:published_by;type:varchar(64)" description:"操作的管理端账号"`
	PublishedAt *time.Time `gorm:"column:published_at;type:timestamp null default null"`

	CreatedTime time.Time `gorm:"column:created_time;autoCreateTime"`
	UpdatedTime time.Time `gorm:"column:updated_time;autoUpdateTime"`
}

func (r *GalaxyDesktopRelease) TableName() string { return "zt_galaxy_desktop_release" }
func (r *GalaxyDesktopRelease) Init()             {}

// GalaxyUsageRollup 用量与金额的**按小时汇总**，只为管理端仪表盘而存在。
//
// 为什么非要一张汇总表：仪表盘要的是「今天消耗了多少 token、收了多少、结出去多少，
// 按 Claude / Codex 分开」。这三个数的原始出处分别是 zt_galaxy_meter_record 与
// 消费 / 供给两本账，而类别（claude / codex）只有 zt_galaxy_unit 上的模型才说得清 ——
// 也就是说每问一次，都要把当天的计量流水和两本账各扫一遍、每一行再回 unit 表查一次模型。
// 这三张是池子里最大的表（一次请求写若干行），而仪表盘是个会挂在大屏上自动刷新的页面：
// 直接查等于让最贵的一条查询按秒重复。
//
// 为什么按小时而不是按天：小时桶**封口之后就不会再变**（行的 created_at 就是它自己的
// 写入时刻，不存在迟到的行），所以算过一次就能一直用。按天的话，当天那一桶到半夜之前
// 一直是活的，每次都得重算一整天 —— 汇总表就白建了。
//
// 谁来写：读的时候顺手写（service/galaxy/admindashboard.go 的 rollHour），
// Hub 的巡检也会把刚封口的小时补上。两条路写的是同一个数，按唯一键整行覆盖，
// 重复跑没有副作用 —— 所以不需要「谁是唯一的写入者」这条约束，也不怕多实例同时跑。
//
// 每个已经算过的小时都会有一行 **Category 与 Unit 都是空串**的标记行，哪怕那个小时
// 一条流水都没有。没有它就分不出「这个小时没有量」和「这个小时还没算过」，
// 于是空闲时段会被反复重算。读的时候要把它滤掉。
type GalaxyUsageRollup struct {
	ID      int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_usage_rollup,priority:1"`
	// StatHour 小时桶的起点，整点。行归到哪一桶按它自己的 created_at 算。
	StatHour time.Time `gorm:"column:stat_hour;type:datetime(3);uniqueIndex:uk_gx_usage_rollup,priority:2" description:"小时桶起点，整点"`
	// Category claude / codex / video / other，由模型（其次是路由键与能力）推出来。
	// 空串是这个小时的标记行，不是某一类。
	Category string `gorm:"column:category;type:varchar(16);uniqueIndex:uk_gx_usage_rollup,priority:3" description:"claude/codex/video/other；空串是小时标记行"`
	// Unit 计量单位，与 zt_galaxy_meter_record.unit 同一套。空串同上。
	Unit string `gorm:"column:unit;type:varchar(48);uniqueIndex:uk_gx_usage_rollup,priority:4"`

	// Amount 这个单位的计量合计。单位不同量纲就不同：*_tokens 是 token 数，
	// llm.calls 是成功调用次数，time.seconds 是秒。跨单位相加没有意义。
	Amount int64 `gorm:"column:amount" description:"该计量单位的合计，量纲随 unit 而定"`
	// ConsumerAmount 使用端这一格结算掉的钱（微元），取自消费侧账本 type=settle。
	// **不是**由 Amount 乘单价算出来的：计费是逐笔向下取整的，事后乘一遍对不上账。
	ConsumerAmount int64 `gorm:"column:consumer_amount" description:"使用端结算金额，微元"`
	// ProviderAmount 共享端这一格挣到的钱（微元），取自供给侧账本 type=settle。
	// 和上面那个是两个数：差额是平台毛利，把它们当成一个数是这套账最容易犯的错。
	ProviderAmount int64 `gorm:"column:provider_amount" description:"共享端结算金额，微元"`

	RolledAt time.Time `gorm:"column:rolled_at;type:timestamp null default null" description:"这一桶最近一次算出来的时刻"`
}

func (r *GalaxyUsageRollup) TableName() string { return "zt_galaxy_usage_rollup" }
func (r *GalaxyUsageRollup) Init()             {}

// GalaxyTrackingDaily 是面向运营看板的埋点日汇总。
//
// 这里只存「哪一天、哪个位置、哪个目标被触发了多少次」，不保存 IP、账号或 UA：
// 当前产品问题只需要趋势，保留逐条访问流水既增加隐私面，也会让官网每次打开都长一行。
// TargetKey 让模型点击能保留 model_id；官网打开没有目标，固定为空串。
type GalaxyTrackingDaily struct {
	ID        int64     `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine   string    `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_gx_tracking_daily,priority:1" description:"业务线"`
	EventDate time.Time `gorm:"column:event_date;type:date;uniqueIndex:uk_gx_tracking_daily,priority:2" description:"服务端本地时区统计日期"`
	EventKey  string    `gorm:"column:event_key;type:varchar(48);uniqueIndex:uk_gx_tracking_daily,priority:3" description:"portal.open / model_square.model_click"`
	TargetKey string    `gorm:"column:target_key;type:varchar(96);uniqueIndex:uk_gx_tracking_daily,priority:4" description:"目标业务键；模型点击为 model_id，官网打开为空"`
	Count     int64     `gorm:"column:count" description:"触发次数"`

	CreatedTime time.Time `gorm:"column:created_time;autoCreateTime"`
	UpdatedTime time.Time `gorm:"column:updated_time;autoUpdateTime"`
}

func (r *GalaxyTrackingDaily) TableName() string { return "zt_galaxy_tracking_daily" }
func (r *GalaxyTrackingDaily) Init()             {}
