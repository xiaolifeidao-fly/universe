// Package repository 只能被 service/delivery 目录树引用（Go internal 规则）。
//
// zt_delivery_* 八张表的写入口全在这个包里，因此「交付推进数据只由 delivery 层写」
// 是编译期事实而非约定。
package repository

import "time"

// DeliveryCommand is the durable authority for a remote action. Redis may wake
// a worker, but a worker can only execute a command after this record is leased.
type DeliveryCommand struct {
	Id        int64  `gorm:"column:id;primaryKey;autoIncrement" description:"主键"`
	BizLine   string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_dlv_command_id,priority:1;uniqueIndex:uk_dlv_command_idempotency,priority:1;index:idx_dlv_command_queue,priority:1;index:idx_dlv_command_user,priority:1;index:idx_dlv_command_lease,priority:1" description:"业务线"`
	CommandID string `gorm:"column:command_id;type:varchar(64);uniqueIndex:uk_dlv_command_id,priority:2" description:"服务端生成的命令业务键"`
	ProgramID int64  `gorm:"column:program_id;index:idx_dlv_command_queue,priority:4;index:idx_dlv_command_user,priority:3" description:"目标项目数值主键"`
	UserID    string `gorm:"column:user_id;type:varchar(64);uniqueIndex:uk_dlv_command_idempotency,priority:2;index:idx_dlv_command_queue,priority:2;index:idx_dlv_command_user,priority:2" description:"提交人和领取队列所属用户"`

	CommandType    string `gorm:"column:command_type;type:varchar(64)" description:"动作类型，只能是协议定义的标识符"`
	IdempotencyKey string `gorm:"column:idempotency_key;type:varchar(128);uniqueIndex:uk_dlv_command_idempotency,priority:3" description:"同一用户稳定提交幂等键"`
	InputJSON      string `gorm:"column:input_json;type:mediumtext" description:"动作输入 JSON 对象，数据库权威副本"`
	ResultJSON     string `gorm:"column:result_json;type:mediumtext" description:"Worker 回传结果 JSON 对象"`
	ErrorMessage   string `gorm:"column:error_message;type:varchar(1024)" description:"失败或阻塞的简明错误"`

	State           string     `gorm:"column:state;type:varchar(16);index:idx_dlv_command_queue,priority:3;index:idx_dlv_command_user,priority:4" description:"pending/leased/running/succeeded/failed/cancelled/timed_out"`
	Progress        int        `gorm:"column:progress;default:0" description:"Worker 回传的执行进度，范围 0-100"`
	CancelRequested bool       `gorm:"column:cancel_requested;default:false" description:"用户已请求尽力取消，Worker 下次轮询或续租时可见"`
	LeaseToken      string     `gorm:"column:lease_token;type:varchar(64)" description:"本次领取租约令牌，仅领取 Worker 可回传"`
	LeaseWorkerID   string     `gorm:"column:lease_worker_id;type:varchar(64)" description:"持有租约的插件标识"`
	LeaseExpiresAt  *time.Time `gorm:"column:lease_expires_at;type:timestamp;null;index:idx_dlv_command_lease,priority:2" description:"租约截止时刻，默认两分钟"`
	DispatchCount   int        `gorm:"column:dispatch_count;default:1" description:"待领取通知投递次数，超过上限转为 timed_out"`
	AttemptCount    int        `gorm:"column:attempt_count;default:0" description:"成功领取次数，超过重试上限转为 timed_out"`
	StartedAt       *time.Time `gorm:"column:started_at;type:timestamp;null" description:"Worker 首次报告运行的时刻"`
	FinishedAt      *time.Time `gorm:"column:finished_at;type:timestamp;null" description:"终态回传时刻"`
	Version         int        `gorm:"column:version;default:1" description:"并发更新版本"`
	CreatedTime     time.Time  `gorm:"column:created_time;autoCreateTime" description:"创建时间"`
	UpdatedTime     time.Time  `gorm:"column:updated_time;autoUpdateTime" description:"更新时间"`
}

func (r *DeliveryCommand) TableName() string { return "zt_delivery_command" }
func (r *DeliveryCommand) Init()             {}

// DeliveryCommandEvent is the append-only event stream used by audit views and SSE cursors.
type DeliveryCommandEvent struct {
	Id        int64     `gorm:"column:id;primaryKey;autoIncrement" description:"事件游标主键"`
	BizLine   string    `gorm:"column:biz_line;type:varchar(32);index:idx_dlv_command_event_stream,priority:1" description:"业务线"`
	CommandID string    `gorm:"column:command_id;type:varchar(64);index:idx_dlv_command_event_stream,priority:2" description:"关联命令业务键"`
	UserID    string    `gorm:"column:user_id;type:varchar(64)" description:"命令所属用户"`
	Kind      string    `gorm:"column:kind;type:varchar(32)" description:"submitted/claimed/activity/lease_renewed/cancel_requested/completed 等事件类型"`
	State     string    `gorm:"column:state;type:varchar(16)" description:"事件发生后的命令状态"`
	Message   string    `gorm:"column:message;type:varchar(1024)" description:"面向用户的活动描述"`
	DataJSON  string    `gorm:"column:data_json;type:mediumtext" description:"附加 JSON 对象，不保存本机路径或凭证"`
	CreatedAt time.Time `gorm:"column:created_at;autoCreateTime" description:"事件生成时间"`
}

func (r *DeliveryCommandEvent) TableName() string { return "zt_delivery_command_event" }
func (r *DeliveryCommandEvent) Init()             {}

// DeliveryCommandAttachment is transient command input held by app-api until
// the mapped Worker downloads it. It never contains a local workspace path.
type DeliveryCommandAttachment struct {
	ID           int64     `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine      string    `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_dlv_command_attachment,priority:1;index:idx_dlv_command_attachment_owner,priority:1"`
	AttachmentID string    `gorm:"column:attachment_id;type:varchar(64);uniqueIndex:uk_dlv_command_attachment,priority:2"`
	ProgramID    int64     `gorm:"column:program_id;index:idx_dlv_command_attachment_owner,priority:3"`
	UserID       string    `gorm:"column:user_id;type:varchar(64);index:idx_dlv_command_attachment_owner,priority:2"`
	ItemKey      string    `gorm:"column:item_key;type:varchar(128)"`
	Name         string    `gorm:"column:name;type:varchar(160)"`
	ContentType  string    `gorm:"column:content_type;type:varchar(128)"`
	Size         int64     `gorm:"column:size"`
	Content      []byte    `gorm:"column:content;type:longblob"`
	CreatedTime  time.Time `gorm:"column:created_time;autoCreateTime"`
}

func (r *DeliveryCommandAttachment) TableName() string { return "zt_delivery_command_attachment" }
func (r *DeliveryCommandAttachment) Init()             {}

// DeliveryCommandWorker records a plugin identity for one user and business line.
type DeliveryCommandWorker struct {
	Id               int64     `gorm:"column:id;primaryKey;autoIncrement" description:"主键"`
	BizLine          string    `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_dlv_command_worker,priority:1;index:idx_dlv_command_worker_heartbeat,priority:1" description:"业务线"`
	UserID           string    `gorm:"column:user_id;type:varchar(64);uniqueIndex:uk_dlv_command_worker,priority:2;index:idx_dlv_command_worker_heartbeat,priority:2" description:"当前登录用户标识"`
	WorkerID         string    `gorm:"column:worker_id;type:varchar(64);uniqueIndex:uk_dlv_command_worker,priority:3;index:idx_dlv_command_worker_heartbeat,priority:3" description:"插件稳定实例标识"`
	DisplayName      string    `gorm:"column:display_name;type:varchar(128)" description:"插件或电脑显示名"`
	CapabilitiesJSON string    `gorm:"column:capabilities_json;type:text" description:"支持的命令类型 JSON 数组"`
	LastHeartbeatAt  time.Time `gorm:"column:last_heartbeat_at;type:timestamp;index:idx_dlv_command_worker_heartbeat,priority:4" description:"最近一次注册、领取或心跳时间"`
	CreatedTime      time.Time `gorm:"column:created_time;autoCreateTime" description:"创建时间"`
	UpdatedTime      time.Time `gorm:"column:updated_time;autoUpdateTime" description:"更新时间"`
}

func (r *DeliveryCommandWorker) TableName() string { return "zt_delivery_command_worker" }
func (r *DeliveryCommandWorker) Init()             {}

// DeliveryCommandWorkerWorkspace proves a worker has configured a local mapping.
// The local absolute path intentionally never leaves the plugin process.
type DeliveryCommandWorkerWorkspace struct {
	Id          int64     `gorm:"column:id;primaryKey;autoIncrement" description:"主键"`
	BizLine     string    `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_dlv_command_workspace,priority:1;index:idx_dlv_command_workspace_worker,priority:1" description:"业务线"`
	UserID      string    `gorm:"column:user_id;type:varchar(64);uniqueIndex:uk_dlv_command_workspace,priority:2;index:idx_dlv_command_workspace_worker,priority:2" description:"当前登录用户标识"`
	WorkerID    string    `gorm:"column:worker_id;type:varchar(64);uniqueIndex:uk_dlv_command_workspace,priority:3;index:idx_dlv_command_workspace_worker,priority:3" description:"插件稳定实例标识"`
	ProgramID   int64     `gorm:"column:program_id;uniqueIndex:uk_dlv_command_workspace,priority:4;index:idx_dlv_command_workspace_worker,priority:4" description:"已配置本机工作目录映射的项目"`
	CreatedTime time.Time `gorm:"column:created_time;autoCreateTime" description:"创建时间"`
	UpdatedTime time.Time `gorm:"column:updated_time;autoUpdateTime" description:"更新时间"`
}

func (r *DeliveryCommandWorkerWorkspace) TableName() string {
	return "zt_delivery_command_worker_workspace"
}
func (r *DeliveryCommandWorkerWorkspace) Init() {}

// DeliveryProgram 交付项目。一个甲方 / 一个国家的落地推进算一个项目，
// 对应原型 assets/tasks.json 的 meta 段（"印尼业务 · 任务维护看板"）。
//
// id 是所有项目范围操作使用的全局主键；program_code 仅保留为可读的业务编码。
// biz_line 是项目的归属属性，仍保留在每张交付表上以支持按业务线浏览与统计。
type DeliveryProgram struct {
	Id      int64  `gorm:"column:id;primaryKey;autoIncrement" description:"主键"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);index:idx_dlv_program_biz_line;uniqueIndex:uk_dlv_program_code,priority:1" description:"业务线"`

	// 项目编码按空间唯一，不是全局唯一：空间归各自的用户所有，
	// 甲空间用过 test，乙空间不该因此建不了同名项目。
	// 所有关联仍然走数值主键 id，编码只承担展示与导入幂等。
	ProgramCode string `gorm:"column:program_code;type:varchar(64);uniqueIndex:uk_dlv_program_code,priority:2" description:"项目业务编码，如 indonesia；仅展示与导入幂等使用"`
	Name        string `gorm:"column:name;type:varchar(128)" description:"项目名称"`
	Summary     string `gorm:"column:summary;type:varchar(512)" description:"一句话说明"`
	Status      string `gorm:"column:status;type:varchar(16);default:'active'" description:"active 进行中 / archived 已归档"`
	// Git 配置是项目共享的可选能力；它不校验或改写本机 remote，
	// 实际工作区和当前分支仍由本地桥接读取。
	GitEnabled         bool   `gorm:"column:git_enabled;default:false" description:"项目是否启用 Git 需求分支能力"`
	GitRepositoryURL   string `gorm:"column:git_repository_url;type:varchar(512)" description:"项目可选记录的 Git 仓库地址，仅供成员查看"`
	GitRemoteName      string `gorm:"column:git_remote_name;type:varchar(64);default:'origin'" description:"用于校验和拉取的 Git 远端名称，默认 origin"`
	GitBaseBranch      string `gorm:"column:git_base_branch;type:varchar(255)" description:"项目启用 Git 后的新需求默认基准分支"`
	GitChatSyncEnabled bool   `gorm:"column:git_chat_sync_enabled;default:false" description:"是否将已结束的需求和任务聊天记录归档到项目工作目录 chat/"`
	CloudSyncEnabled   bool   `gorm:"column:cloud_sync_enabled;default:false" description:"是否将所选项目内容同步至服务端云端文件库"`
	CloudSyncScopes    string `gorm:"column:cloud_sync_scopes;type:varchar(128)" description:"同步类别的规范化逗号列表：chat/requirement/design/test/prototype/execution/attachment"`

	CreatedBy   string    `gorm:"column:created_by;type:varchar(64)" description:"创建人"`
	UpdatedBy   string    `gorm:"column:updated_by;type:varchar(64)" description:"最后修改人"`
	CreatedTime time.Time `gorm:"column:created_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"创建时间"`
	UpdatedTime time.Time `gorm:"column:updated_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"更新时间"`
}

func (d *DeliveryProgram) TableName() string { return "zt_delivery_program" }
func (d *DeliveryProgram) Init()             {}

// DeliveryCloudSyncFile 是项目工作目录中被明确选中同步到服务端的文件快照。
// 相对路径而不是本机绝对路径，保证不同成员机器之间不会泄露目录结构。
type DeliveryCloudSyncFile struct {
	Id      int64  `gorm:"column:id;primaryKey;autoIncrement" description:"主键"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_dlv_cloud_file,priority:1;index:idx_dlv_cloud_file_updated,priority:1" description:"业务线"`

	ProgramID    int64  `gorm:"column:program_id;type:bigint;uniqueIndex:uk_dlv_cloud_file,priority:2;index:idx_dlv_cloud_file_updated,priority:2" description:"所属项目"`
	Category     string `gorm:"column:category;type:varchar(16);uniqueIndex:uk_dlv_cloud_file,priority:3;index:idx_dlv_cloud_file_updated,priority:3" description:"同步类别：chat/requirement/design/test/prototype/execution/attachment"`
	RelativePath string `gorm:"column:relative_path;type:varchar(1024)" description:"项目工作目录内的相对路径"`
	// 相对路径本身放进联合唯一键会让索引超过 InnoDB 的 3072 字节上限，
	// 所以唯一性落在定长的路径哈希上，路径列保持完整长度只做展示与回读。
	RelativePathHash string    `gorm:"column:relative_path_hash;type:char(64);uniqueIndex:uk_dlv_cloud_file,priority:4" description:"relative_path 的 SHA-256，仅用于唯一键"`
	ContentType      string    `gorm:"column:content_type;type:varchar(128)" description:"文件 MIME 类型"`
	ObjectKey        string    `gorm:"column:object_key;type:varchar(1536)" description:"OSS 对象键；正文只保存在私有 OSS"`
	Size             int64     `gorm:"column:size;type:bigint" description:"正文的字节数"`
	SHA256           string    `gorm:"column:sha256;type:char(64)" description:"正文 SHA-256，用于识别同内容重传"`
	UpdatedBy        string    `gorm:"column:updated_by;type:varchar(64)" description:"最近同步操作人"`
	UpdatedTime      time.Time `gorm:"column:updated_time;type:timestamp;default:CURRENT_TIMESTAMP;index:idx_dlv_cloud_file_updated,priority:4" description:"最近同步时间"`
}

func (d *DeliveryCloudSyncFile) TableName() string { return "zt_delivery_cloud_sync_file" }
func (d *DeliveryCloudSyncFile) Init()             {}

// DeliveryStage 推进阶段，对应原型 stages[]（现状 / 第一步 / 第二步 / 第三步 / 终局）。
//
// 排序用 seq，标识用 stage_key —— 原型里阶段是数组下标（tasks[].stage = 0..4），
// 中途插一个阶段所有任务的归属会整体错位，所以这里不用下标做键。
type DeliveryStage struct {
	Id      int64  `gorm:"column:id;primaryKey;autoIncrement" description:"主键"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_dlv_stage,priority:1;index:idx_dlv_stage_seq,priority:1" description:"业务线"`

	ProgramID int64  `gorm:"column:program_id;type:bigint;uniqueIndex:uk_dlv_stage,priority:2;index:idx_dlv_stage_seq,priority:2" description:"所属项目"`
	StageKey  string `gorm:"column:stage_key;type:varchar(64);uniqueIndex:uk_dlv_stage,priority:3" description:"阶段业务键 如 s1"`
	Seq       int    `gorm:"column:seq;index:idx_dlv_stage_seq,priority:3" description:"展示顺序，看板列从左到右"`

	Tag           string `gorm:"column:tag;type:varchar(32)" description:"阶段标签 现状/第一步/终局"`
	TimeWindow    string `gorm:"column:time_window;type:varchar(64)" description:"时间窗 如 0 – 4 周"`
	MaturityLevel string `gorm:"column:maturity_level;type:varchar(16)" description:"自动化成熟度 如 L2.0"`
	Title         string `gorm:"column:title;type:varchar(255)" description:"阶段目标"`

	CreatedTime time.Time `gorm:"column:created_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"创建时间"`
	UpdatedTime time.Time `gorm:"column:updated_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"更新时间"`
}

func (d *DeliveryStage) TableName() string { return "zt_delivery_stage" }
func (d *DeliveryStage) Init()             {}

// DeliveryModule 能力模块，对应原型 modules[]（数据回传 / 案件前筛 / 触达 · WhatsApp …）。
//
// weight 是加权成熟度的分母来源：整体成熟度 = Σ(weight × 模块进度) / Σweight。
// 原型页面把 weight 显示出来了却没参与计算，口径在 service 层统一。
type DeliveryModule struct {
	Id      int64  `gorm:"column:id;primaryKey;autoIncrement" description:"主键"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_dlv_module,priority:1;index:idx_dlv_module_seq,priority:1" description:"业务线"`

	ProgramID int64  `gorm:"column:program_id;type:bigint;uniqueIndex:uk_dlv_module,priority:2;index:idx_dlv_module_seq,priority:2" description:"所属项目"`
	ModuleKey string `gorm:"column:module_key;type:varchar(64);uniqueIndex:uk_dlv_module,priority:3" description:"模块业务键 如 data/screen/wa"`
	Seq       int    `gorm:"column:seq;index:idx_dlv_module_seq,priority:3" description:"展示顺序"`

	Name   string `gorm:"column:name;type:varchar(128)" description:"模块名称"`
	Weight int    `gorm:"column:weight" description:"权重百分比，用于加权成熟度"`
	Kind   string `gorm:"column:kind;type:varchar(16)" description:"link 链路 / tool 工具 / center 中枢"`

	CreatedTime time.Time `gorm:"column:created_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"创建时间"`
	UpdatedTime time.Time `gorm:"column:updated_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"更新时间"`
}

func (d *DeliveryModule) TableName() string { return "zt_delivery_module" }
func (d *DeliveryModule) Init()             {}

// DeliveryTimePlan 时间计划：项目按交付节奏切出来的一个时间窗口，
// 在 Git 上对应一条从基准分支切出的发布分支（默认 release/{截止日期}）。
//
// 它和需求是一对多的弱引用：需求上的 time_plan_key 指向这里的 plan_key，
// 计划被删除只把需求那一列清空，已经建出来的分支不受影响。
type DeliveryTimePlan struct {
	Id      int64  `gorm:"column:id;primaryKey;autoIncrement" description:"主键"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_dlv_time_plan,priority:1;index:idx_dlv_time_plan_end,priority:1" description:"业务线"`

	ProgramID int64  `gorm:"column:program_id;type:bigint;uniqueIndex:uk_dlv_time_plan,priority:2;index:idx_dlv_time_plan_end,priority:2" description:"所属项目"`
	PlanKey   string `gorm:"column:plan_key;type:varchar(64);uniqueIndex:uk_dlv_time_plan,priority:3" description:"时间计划业务键 如 plan-1760000000000"`

	Name    string     `gorm:"column:name;type:varchar(255)" description:"时间计划名称"`
	StartAt *time.Time `gorm:"column:start_at;type:timestamp;null" description:"计划开始时间"`
	// EndAt 同时决定默认分支名 release/{截止日期}，所以它是必填。
	EndAt  *time.Time `gorm:"column:end_at;type:timestamp;null;index:idx_dlv_time_plan_end,priority:3" description:"计划截止时间"`
	Status string     `gorm:"column:status;type:varchar(16);default:active" description:"active 进行中 / done 已发布 / archived 已归档"`

	// 分支实际创建仍由本机桥接完成，这里只记录关联结果。
	BaseBranch          string     `gorm:"column:base_branch;type:varchar(255)" description:"切出计划分支时使用的基准分支"`
	Branch              string     `gorm:"column:branch;type:varchar(255)" description:"计划分支，默认 release/{截止日期}"`
	BranchCreatedAt     *time.Time `gorm:"column:branch_created_at;type:timestamp NULL" description:"计划分支最近创建并关联的时间"`
	BaseSyncedAt        *time.Time `gorm:"column:base_synced_at;type:timestamp NULL" description:"最近一次把基线分支回合进计划分支的时间"`
	RequirementMergedAt *time.Time `gorm:"column:requirement_merged_at;type:timestamp NULL" description:"最近一次把需求分支合并进计划分支的时间"`
	BasePublishedAt     *time.Time `gorm:"column:base_published_at;type:timestamp NULL" description:"最近一次把计划分支回推合并进基线分支的时间"`

	Version int `gorm:"column:version;default:1" description:"乐观锁版本"`

	CreatedBy     string    `gorm:"column:created_by;type:varchar(64)" description:"创建人标识"`
	CreatedByName string    `gorm:"column:created_by_name;type:varchar(64)" description:"创建人显示名"`
	UpdatedBy     string    `gorm:"column:updated_by;type:varchar(64)" description:"最后修改人"`
	CreatedTime   time.Time `gorm:"column:created_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"创建时间"`
	UpdatedTime   time.Time `gorm:"column:updated_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"更新时间"`
}

func (d *DeliveryTimePlan) TableName() string { return "zt_delivery_time_plan" }
func (d *DeliveryTimePlan) Init()             {}

// DeliveryRequirement 需求：项目与任务之间缺失的那一层。
//
// 一次「新增需求」产出一批任务：需求记录「要做什么、谁负责」，任务记录「拆成了哪些活」。
// 拆解会话也挂在需求上 —— 追问同一个需求时，已经建出来的任务列表要一并带回给执行器。
//
// OwnerIDs / AssistantIDs 用 ,1,2, 这种前后都带逗号的形式存，
// 「和我有关的需求」用 LIKE '%,3,%' 就能命中，不用再开一张关联表。
type DeliveryRequirement struct {
	Id      int64  `gorm:"column:id;primaryKey;autoIncrement" description:"主键"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_dlv_requirement,priority:1;index:idx_dlv_requirement_program,priority:1;index:idx_dlv_requirement_time_plan,priority:1" description:"业务线"`

	ProgramID      int64  `gorm:"column:program_id;type:bigint;uniqueIndex:uk_dlv_requirement,priority:2;index:idx_dlv_requirement_program,priority:2;index:idx_dlv_requirement_time_plan,priority:2" description:"所属项目"`
	RequirementKey string `gorm:"column:requirement_key;type:varchar(64);uniqueIndex:uk_dlv_requirement,priority:3" description:"需求业务键 如 req-20260813-01"`

	Name   string `gorm:"column:name;type:varchar(255)" description:"需求名称"`
	Detail string `gorm:"column:detail;type:mediumtext" description:"需求详细信息"`
	// ReferenceRequirementKeys 是需求详情里 @ 引用的历史需求键，形如 ,req-a,req-b,。
	// 拆解会话据此把被引用需求的大纲产物地址交给插件，正文由插件按需读取。
	ReferenceRequirementKeys string `gorm:"column:reference_requirement_keys;type:varchar(1024)" description:"@ 引用的历史需求键，形如 ,req-a,req-b,"`
	// ReferenceItemKeys 是需求详情里 @ 引用的既有任务键，形如 ,task-a,task-b,。
	// 拆解会话据此把被引用任务的需求文档地址交给插件，正文由插件按需读取。
	ReferenceItemKeys string `gorm:"column:reference_item_keys;type:varchar(2048)" description:"@ 引用的既有任务键，形如 ,task-a,task-b,"`
	// TimePlanKey 是需求关联的时间计划键；空串表示这条需求还没排进任何时间计划。
	// 它是弱引用：时间计划被删除时只清这一列，不影响需求本身和它的分支。
	TimePlanKey string `gorm:"column:time_plan_key;type:varchar(64);index:idx_dlv_requirement_time_plan,priority:3" description:"关联的时间计划键；空串表示未排期到任何计划"`
	// PlannedStartAt / PlannedEndAt 是需求的计划时间窗口；为空表示尚未排期。
	PlannedStartAt *time.Time `gorm:"column:planned_start_at;type:timestamp;null" description:"需求计划开始时间"`
	PlannedEndAt   *time.Time `gorm:"column:planned_end_at;type:timestamp;null" description:"需求计划结束时间"`
	Status         string     `gorm:"column:status;type:varchar(16);default:open" description:"open 进行中 / done 已完成 / dropped 不做"`

	// Mode 决定拆出来的任务从哪个阶段起步：
	// simple 简易模式直接进动作执行，professional 专业模式由用户选，默认梳理需求。
	Mode       string `gorm:"column:mode;type:varchar(16);default:professional" description:"simple 简易 / professional 专业"`
	StartPhase string `gorm:"column:start_phase;type:varchar(16);default:requirement" description:"任务起始阶段：requirement/development/testing"`
	// SplitTasks 决定这条需求要不要拆成多条任务：关掉时整条需求只落一条任务，适合改动本来就不可分的小需求。
	SplitTasks bool `gorm:"column:split_tasks;default:true" description:"拆解会话是否把需求拆成多条任务；false 表示只建一条"`
	// GenerateTaskOutline 是历史列名，现用于控制拆解后是否预生成每条任务的需求文档。
	GenerateTaskOutline bool `gorm:"column:generate_task_outline;default:false" description:"拆解会话是否预生成每条任务的需求文档；默认否"`
	// GeneratePrototype 仅专业模式可用。任务拆解确认后，由用户二次确认是否生成关联到本需求的 HTML 原型。
	GeneratePrototype bool `gorm:"column:generate_prototype;default:false" description:"专业模式需求是否启用拆解后生成 HTML 原型"`
	// Git 关联保留需求分支的基准和创建状态；Git 命令仍只在本机桥接的项目工作目录中执行。
	// GitEnabled 为 NULL 表示这条需求还没做过选择，由前端回落到用户偏好里的默认值。
	GitEnabled         *bool      `gorm:"column:git_enabled" description:"需求是否启用 Git 分支关联；NULL 表示未设置"`
	GitBaseBranch      string     `gorm:"column:git_base_branch;type:varchar(255)" description:"创建需求分支时使用的基准分支"`
	GitBranch          string     `gorm:"column:git_branch;type:varchar(255)" description:"关联的需求分支"`
	GitBranchCreatedAt *time.Time `gorm:"column:git_branch_created_at;type:timestamp NULL" description:"需求分支最近创建并关联的时间"`
	// PrototypeHTMLPath 是项目工作区 doc/ 下的原型目录；目录内按功能模块存放多个 HTML，正文不进入任务面板数据库。
	PrototypeHTMLPath    string     `gorm:"column:prototype_html_path;type:varchar(512)" description:"需求 HTML 原型目录在项目工作区中的相对路径"`
	PrototypeGeneratedAt *time.Time `gorm:"column:prototype_generated_at;type:timestamp NULL" description:"需求 HTML 原型最近生成时间"`
	// 总体测试是需求维度的验收，不与任一任务的 testing_report 混用。正文同时落在工作区 doc/test/<requirement_key>/测试报告.md。
	TestingStatus      string     `gorm:"column:testing_status;type:varchar(16);default:todo;index:idx_dlv_requirement_testing,priority:3" description:"需求总体测试：todo/doing/passed/failed/blocked"`
	TestingReport      string     `gorm:"column:testing_report;type:mediumtext" description:"需求总体测试报告正文"`
	TestingReportPath  string     `gorm:"column:testing_report_path;type:varchar(512)" description:"需求总体测试报告在项目工作区中的相对路径"`
	TestingReportedAt  *time.Time `gorm:"column:testing_reported_at;type:timestamp NULL" description:"需求总体测试报告最近生成时间"`
	TestingCasesStatus string     `gorm:"column:testing_cases_status;type:varchar(16);default:todo;index:idx_dlv_requirement_testing_cases,priority:3" description:"需求测试用例：todo/doing/ready/blocked"`
	TestingCases       string     `gorm:"column:testing_cases;type:mediumtext" description:"需求总体测试用例正文"`
	TestingCasesPath   string     `gorm:"column:testing_cases_path;type:varchar(512)" description:"需求测试用例在项目工作区中的相对路径"`
	StageKey           string     `gorm:"column:stage_key;type:varchar(64)" description:"拆解任务默认所属交付阶段"`
	ModuleKey          string     `gorm:"column:module_key;type:varchar(64)" description:"拆解任务默认所属模块"`
	Kind               string     `gorm:"column:kind;type:varchar(16)" description:"拆解任务默认类型：gap/capability/asset"`

	OwnerIDs       string `gorm:"column:owner_ids;type:varchar(512)" description:"主负责人标识，形如 ,1,2,"`
	OwnerNames     string `gorm:"column:owner_names;type:varchar(512)" description:"主负责人显示名，逗号分隔"`
	AssistantIDs   string `gorm:"column:assistant_ids;type:varchar(512)" description:"辅助人标识，形如 ,3,4,"`
	AssistantNames string `gorm:"column:assistant_names;type:varchar(512)" description:"辅助人显示名，逗号分隔"`

	Version int `gorm:"column:version;default:1" description:"乐观锁版本"`

	CreatedBy     string    `gorm:"column:created_by;type:varchar(64);index:idx_dlv_requirement_creator" description:"创建人标识"`
	CreatedByName string    `gorm:"column:created_by_name;type:varchar(64)" description:"创建人显示名"`
	UpdatedBy     string    `gorm:"column:updated_by;type:varchar(64)" description:"最后修改人"`
	CreatedTime   time.Time `gorm:"column:created_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"创建时间"`
	UpdatedTime   time.Time `gorm:"column:updated_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"更新时间"`
}

func (d *DeliveryRequirement) TableName() string { return "zt_delivery_requirement" }
func (d *DeliveryRequirement) Init()             {}

// DeliveryRequirementEvent 是需求本身的变更流水。任务事件单独存放在 DeliveryItemEvent，
// 再由需求时间线按发生时间聚合，避免把需求和任务写入同一张语义混杂的表。
type DeliveryRequirementEvent struct {
	Id      int64  `gorm:"column:id;primaryKey;autoIncrement" description:"主键"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);index:idx_dlv_requirement_event_time,priority:1" description:"业务线"`

	ProgramID      int64  `gorm:"column:program_id;type:bigint;index:idx_dlv_requirement_event_time,priority:2" description:"所属项目"`
	RequirementKey string `gorm:"column:requirement_key;type:varchar(64);index:idx_dlv_requirement_event_time,priority:3" description:"所属需求业务键"`

	Kind      string `gorm:"column:kind;type:varchar(16)" description:"create 新建 / field 字段变更 / delete 删除"`
	Field     string `gorm:"column:field;type:varchar(32)" description:"变更字段名，kind=field 时有值"`
	FromValue string `gorm:"column:from_value;type:varchar(255)" description:"变更前"`
	ToValue   string `gorm:"column:to_value;type:varchar(255)" description:"变更后"`
	Comment   string `gorm:"column:comment;type:varchar(1024)" description:"补充说明"`

	ActorID     string    `gorm:"column:actor_id;type:varchar(64)" description:"操作人"`
	ActorName   string    `gorm:"column:actor_name;type:varchar(64)" description:"操作人显示名"`
	CreatedTime time.Time `gorm:"column:created_time;type:timestamp;default:CURRENT_TIMESTAMP;index:idx_dlv_requirement_event_time,priority:4" description:"发生时间"`
}

func (d *DeliveryRequirementEvent) TableName() string { return "zt_delivery_requirement_event" }
func (d *DeliveryRequirementEvent) Init()             {}

// DeliveryRequirementCompletionNotification 是需求完成时发送给每位负责人和协助者的独立提醒。
// 它不复用需求表上的字段：同一条需求的不同收件人必须分别确认已读。
// 唯一键让需求再次从未完成改为完成时刷新同一位收件人的提醒，而不是积累不可处理的历史消息。
type DeliveryRequirementCompletionNotification struct {
	Id      int64  `gorm:"column:id;primaryKey;autoIncrement" description:"主键"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_dlv_requirement_completion_notice,priority:1;index:idx_dlv_requirement_completion_recipient,priority:1" description:"业务线"`

	ProgramID       int64  `gorm:"column:program_id;type:bigint;uniqueIndex:uk_dlv_requirement_completion_notice,priority:2;index:idx_dlv_requirement_completion_recipient,priority:2" description:"所属项目"`
	RequirementKey  string `gorm:"column:requirement_key;type:varchar(64);uniqueIndex:uk_dlv_requirement_completion_notice,priority:3" description:"已完成需求键"`
	RequirementName string `gorm:"column:requirement_name;type:varchar(255)" description:"完成时冻结的需求名称"`
	RecipientID     string `gorm:"column:recipient_id;type:varchar(64);uniqueIndex:uk_dlv_requirement_completion_notice,priority:4;index:idx_dlv_requirement_completion_recipient,priority:3" description:"接收人（负责人或协助者）"`
	RecipientName   string `gorm:"column:recipient_name;type:varchar(64)" description:"接收人显示名快照"`
	// NotificationReadAt 只属于当前 RecipientID；点击后不会影响同需求的其他负责人或协助者。
	NotificationReadAt *time.Time `gorm:"column:notification_read_at;type:timestamp NULL;index:idx_dlv_requirement_completion_recipient,priority:4" description:"完成提醒已读时间"`
	CompletedAt        time.Time  `gorm:"column:completed_at;type:timestamp;index:idx_dlv_requirement_completion_recipient,priority:5" description:"本次标记完成的时间"`
	CreatedTime        time.Time  `gorm:"column:created_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"创建时间"`
	UpdatedTime        time.Time  `gorm:"column:updated_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"最近刷新时间"`
}

func (d *DeliveryRequirementCompletionNotification) TableName() string {
	return "zt_delivery_requirement_completion_notification"
}
func (d *DeliveryRequirementCompletionNotification) Init() {}

// DeliveryRequirementPlanningSession 需求拆解会话目录：一条需求下开过哪几轮拆解对话。
//
// 只存目录，不存对话正文 —— 正文由 Codex / Claude 自己的会话缓存持有，
// 桥接按 thread_id 读回。桥接是可以随时重启的本地进程，目录留在它内存里就会跟着重启一起消失。
type DeliveryRequirementPlanningSession struct {
	Id      int64  `gorm:"column:id;primaryKey;autoIncrement" description:"主键"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_dlv_planning_session,priority:1" description:"业务线"`

	ProgramID      int64  `gorm:"column:program_id;type:bigint;uniqueIndex:uk_dlv_planning_session,priority:2;index:idx_dlv_planning_program,priority:1" description:"所属项目"`
	RequirementKey string `gorm:"column:requirement_key;type:varchar(64);uniqueIndex:uk_dlv_planning_session,priority:3;index:idx_dlv_planning_program,priority:2" description:"所属需求业务键"`
	ExecutorType   string `gorm:"column:executor_type;type:varchar(32);uniqueIndex:uk_dlv_planning_session,priority:4" description:"执行器类型：codex/claude"`
	ThreadID       string `gorm:"column:thread_id;type:varchar(255);uniqueIndex:uk_dlv_planning_session,priority:5" description:"执行器会话标识，对话正文按它去执行器缓存里读"`

	Title  string `gorm:"column:title;type:varchar(255)" description:"会话标题，聊天列表显示用"`
	Status string `gorm:"column:status;type:varchar(16)" description:"running/completed/failed/interrupted"`
	// MetadataJSON 存这轮拆解的上下文：选中的里程碑 / 模块 / 任务类型，以及拆解前的基线与本轮产出。
	MetadataJSON string `gorm:"column:metadata_json;type:mediumtext" description:"拆解上下文与结果 JSON"`
	Version      int    `gorm:"column:version;default:1" description:"乐观锁版本"`

	CreatedBy   string    `gorm:"column:created_by;type:varchar(64)" description:"创建人"`
	UpdatedBy   string    `gorm:"column:updated_by;type:varchar(64)" description:"最后修改人"`
	CreatedTime time.Time `gorm:"column:created_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"创建时间"`
	UpdatedTime time.Time `gorm:"column:updated_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"更新时间"`
}

func (d *DeliveryRequirementPlanningSession) TableName() string {
	return "zt_delivery_requirement_planning_session"
}
func (d *DeliveryRequirementPlanningSession) Init() {}

// DeliveryRequirementPlanningBatch 需求拆解批次：一次「拆解并写入任务」的写入单元。
//
// 一条需求可以反复拆解，每次拆出来的任务是一批。批次记录这批任务是什么时候、
// 由谁、基于哪一轮拆解会话写进来的；任务侧只冻结 planning_batch_key 一个弱引用，
// 老任务和手工建的任务留空，不强制归批。
type DeliveryRequirementPlanningBatch struct {
	Id      int64  `gorm:"column:id;primaryKey;autoIncrement" description:"主键"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_dlv_planning_batch,priority:1;index:idx_dlv_planning_batch_req,priority:1" description:"业务线"`

	ProgramID      int64  `gorm:"column:program_id;type:bigint;uniqueIndex:uk_dlv_planning_batch,priority:2;index:idx_dlv_planning_batch_req,priority:2" description:"所属项目"`
	BatchKey       string `gorm:"column:batch_key;type:varchar(64);uniqueIndex:uk_dlv_planning_batch,priority:3" description:"批次业务键 如 plan-xxxx"`
	RequirementKey string `gorm:"column:requirement_key;type:varchar(64);index:idx_dlv_planning_batch_req,priority:3" description:"所属需求业务键"`
	// Seq 是同一条需求下的第几次拆解，从 1 开始；展示成「第 N 批」不用再按时间猜。
	Seq int `gorm:"column:seq;index:idx_dlv_planning_batch_req,priority:4" description:"需求内的拆解序号，从 1 开始"`

	Title  string `gorm:"column:title;type:varchar(255)" description:"批次标题，默认取「第 N 次拆解」"`
	Source string `gorm:"column:source;type:varchar(16);default:planner" description:"来源：planner 拆解会话 / manual 人工 / import 导入"`
	// ExecutorType / ThreadID 指回产出这批任务的那轮拆解会话，可为空。
	ExecutorType string `gorm:"column:executor_type;type:varchar(32)" description:"产出该批次的执行器类型，可空"`
	ThreadID     string `gorm:"column:thread_id;type:varchar(255)" description:"产出该批次的拆解会话标识，可空"`
	Summary      string `gorm:"column:summary;type:varchar(1024)" description:"本批次的一句话说明"`
	ItemCount    int    `gorm:"column:item_count" description:"写入时登记的任务数，实际归属以任务表为准"`

	CreatedBy     string    `gorm:"column:created_by;type:varchar(64)" description:"创建人标识"`
	CreatedByName string    `gorm:"column:created_by_name;type:varchar(64)" description:"创建人显示名"`
	UpdatedBy     string    `gorm:"column:updated_by;type:varchar(64)" description:"最后修改人"`
	CreatedTime   time.Time `gorm:"column:created_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"创建时间"`
	UpdatedTime   time.Time `gorm:"column:updated_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"更新时间"`
}

func (d *DeliveryRequirementPlanningBatch) TableName() string {
	return "zt_delivery_requirement_planning_batch"
}
func (d *DeliveryRequirementPlanningBatch) Init() {}

// DeliveryRequirementTestingSession 需求总体测试的会话目录。拆解会话与测试会话分表，
// 因为它们的产物、权限与生命周期不同，不能用一个 metadata 字段靠 kind 猜语义。
type DeliveryRequirementTestingSession struct {
	Id      int64  `gorm:"column:id;primaryKey;autoIncrement" description:"主键"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_dlv_requirement_testing_session,priority:1" description:"业务线"`

	ProgramID      int64  `gorm:"column:program_id;type:bigint;uniqueIndex:uk_dlv_requirement_testing_session,priority:2;index:idx_dlv_requirement_testing_session,priority:1" description:"所属项目"`
	RequirementKey string `gorm:"column:requirement_key;type:varchar(64);uniqueIndex:uk_dlv_requirement_testing_session,priority:3;index:idx_dlv_requirement_testing_session,priority:2" description:"所属需求业务键"`
	ExecutorType   string `gorm:"column:executor_type;type:varchar(32);uniqueIndex:uk_dlv_requirement_testing_session,priority:4" description:"执行器类型：codex/claude"`
	ThreadID       string `gorm:"column:thread_id;type:varchar(255);uniqueIndex:uk_dlv_requirement_testing_session,priority:5" description:"执行器会话标识"`

	Title        string `gorm:"column:title;type:varchar(255)" description:"会话标题"`
	Status       string `gorm:"column:status;type:varchar(16)" description:"running/completed/failed/interrupted"`
	MetadataJSON string `gorm:"column:metadata_json;type:mediumtext" description:"测试会话上下文与产物 JSON"`
	Version      int    `gorm:"column:version;default:1" description:"乐观锁版本"`

	CreatedBy   string    `gorm:"column:created_by;type:varchar(64)" description:"创建人"`
	UpdatedBy   string    `gorm:"column:updated_by;type:varchar(64)" description:"最后修改人"`
	CreatedTime time.Time `gorm:"column:created_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"创建时间"`
	UpdatedTime time.Time `gorm:"column:updated_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"更新时间"`
}

func (d *DeliveryRequirementTestingSession) TableName() string {
	return "zt_delivery_requirement_testing_session"
}
func (d *DeliveryRequirementTestingSession) Init() {}

// DeliveryItem 推进任务，看板的主体，对应原型 tasks[]。
//
// 注意与第 2 层 service/task 的区别：那边是下发给端侧的催收指令（zt_task_instance），
// 这边是「这个能力建到哪一步了」。两者同名不同域，前缀是唯一的归属判据。
type DeliveryItem struct {
	Id      int64  `gorm:"column:id;primaryKey;autoIncrement" description:"主键"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_dlv_item,priority:1;index:idx_dlv_item_board,priority:1;index:idx_dlv_item_module,priority:1;index:idx_dlv_item_requirement_key,priority:1;index:idx_dlv_item_planning_batch,priority:1" description:"业务线"`

	ProgramID int64  `gorm:"column:program_id;type:bigint;uniqueIndex:uk_dlv_item,priority:2;index:idx_dlv_item_board,priority:2;index:idx_dlv_item_module,priority:2;index:idx_dlv_item_requirement_key,priority:2;index:idx_dlv_item_planning_batch,priority:2" description:"所属项目"`
	ItemKey   string `gorm:"column:item_key;type:varchar(64);uniqueIndex:uk_dlv_item,priority:3" description:"任务业务键 如 data-p01，沿用原型 id 便于导入"`

	StageKey  string `gorm:"column:stage_key;type:varchar(64);index:idx_dlv_item_board,priority:3" description:"所属阶段"`
	ModuleKey string `gorm:"column:module_key;type:varchar(64);index:idx_dlv_item_module,priority:3" description:"所属模块"`
	// RequirementKey 是任务归属的需求；空串表示需求层落地之前建的存量任务。
	RequirementKey string `gorm:"column:requirement_key;type:varchar(64);index:idx_dlv_item_requirement_key,priority:3" description:"所属需求"`
	// PlanningBatchKey 是任务来自哪一次需求拆解；非必填，手工新建和存量任务留空。
	PlanningBatchKey string `gorm:"column:planning_batch_key;type:varchar(64);index:idx_dlv_item_planning_batch,priority:3" description:"来源拆解批次，可空"`
	Kind             string `gorm:"column:kind;type:varchar(16)" description:"gap 坑点 / capability 能力 / asset 已具备"`
	// PrototypeTask 仅兼容旧数据；新需求原型挂在需求本身，不再创建额外任务。
	PrototypeTask bool `gorm:"column:prototype_task;default:false" description:"历史原型任务标记，新流程不写入"`

	Title       string `gorm:"column:title;type:varchar(255)" description:"任务标题"`
	Description string `gorm:"column:description;type:text" description:"说明"`
	// BenefitTags 以 JSON 字符串保存多个简短收益标签，避免增加一张只服务展示的关联表。
	BenefitTags string `gorm:"column:benefit_tags;type:text" description:"任务收益或作用标签 JSON 数组"`
	// 以下两个字段保留给已存在数据库及旧接口读取；新写入分别使用路径和阶段产物字段。
	RequirementDocument string `gorm:"column:requirement_document;type:mediumtext" description:"旧需求文档正文"`
	ExecutionOutput     string `gorm:"column:execution_output;type:mediumtext" description:"旧执行记录"`
	// RequirementDocumentPath 是需求文档在执行器工作区中的固定相对路径：
	// doc/{module_key}/{item_key}/文档.md。每个阶段的会话都从这里读取需求上下文。
	RequirementDocumentPath string `gorm:"column:requirement_document_path;type:varchar(512)" description:"需求文档相对路径"`
	// ActionOutput 和 TestingReport 分别保存动作执行产物摘要与成品测试报告。
	// 真实文件仍由项目本身的 skill 约定；这里保存任务面板可审阅的结果文本。
	ActionOutput  string `gorm:"column:action_output;type:mediumtext" description:"动作执行产物摘要"`
	TestingReport string `gorm:"column:testing_report;type:mediumtext" description:"成品测试报告"`
	// 测试用例生成可与研发并行；它不参与任务 phase/status 状态机。
	TestingCasesStatus string `gorm:"column:testing_cases_status;type:varchar(16);default:todo;index:idx_dlv_item_testing_cases,priority:3" description:"测试用例：todo/doing/ready/blocked"`
	TestingCases       string `gorm:"column:testing_cases;type:mediumtext" description:"成品测试用例正文"`
	TestingCasesPath   string `gorm:"column:testing_cases_path;type:varchar(512)" description:"测试用例在项目工作区中的相对路径"`
	// Phase + Status 是任务唯一的当前工作状态。一条任务只能属于一个阶段，
	// 不能同时出现在梳理需求、动作执行、成品测试三个面板里。
	Phase  string `gorm:"column:phase;type:varchar(16);default:requirement;index:idx_dlv_item_phase,priority:3" description:"当前阶段：requirement/development/testing"`
	Status string `gorm:"column:status;type:varchar(16);index:idx_dlv_item_board,priority:4;index:idx_dlv_item_module,priority:4;index:idx_dlv_item_phase,priority:4" description:"当前阶段状态：todo/doing/done/blocked/dropped"`
	// 以下三列保留用于已迁移数据兼容，新的读写路径不再使用它们。
	RequirementStatus string `gorm:"column:requirement_status;type:varchar(16);default:todo;index:idx_dlv_item_requirement,priority:3" description:"需求阶段：todo/doing/done/blocked/dropped"`
	DevelopmentStatus string `gorm:"column:development_status;type:varchar(16);default:todo;index:idx_dlv_item_development,priority:3" description:"开发阶段：todo/doing/done/blocked/dropped"`
	TestingStatus     string `gorm:"column:testing_status;type:varchar(16);default:todo;index:idx_dlv_item_testing,priority:3" description:"测试阶段：todo/doing/done/blocked/dropped"`
	Progress          int    `gorm:"column:progress" description:"进度 0-100，done 强制 100，dropped 不计入统计"`

	// 执行耗时：每一轮执行实例开始与结束时各写一次，累计值只增不减。
	// 一条任务会被反复执行（再做一次、追问、批量重跑），面板既要看最近一轮花了多久，
	// 也要看这条任务到现在一共花了多久，所以最近一轮和累计分开存。
	LastRunStartedAt   *time.Time `gorm:"column:last_run_started_at;type:timestamp NULL" description:"最近一轮执行开始时间"`
	LastRunFinishedAt  *time.Time `gorm:"column:last_run_finished_at;type:timestamp NULL" description:"最近一轮执行结束时间"`
	LastRunDurationMs  int64      `gorm:"column:last_run_duration_ms;default:0" description:"最近一轮执行耗时毫秒"`
	TotalRunDurationMs int64      `gorm:"column:total_run_duration_ms;default:0" description:"历次执行累计耗时毫秒"`
	RunCount           int        `gorm:"column:run_count;default:0" description:"已结束的执行轮次数"`

	OwnerID   string     `gorm:"column:owner_id;type:varchar(64)" description:"负责人标识，鉴权落地前先存名字"`
	OwnerName string     `gorm:"column:owner_name;type:varchar(64)" description:"负责人显示名"`
	DueDate   *time.Time `gorm:"column:due_date;type:date;null" description:"截止日期"`
	Note      string     `gorm:"column:note;type:varchar(1024)" description:"备注"`
	SortOrder int        `gorm:"column:sort_order" description:"列内手工排序，越小越靠前"`

	// Version 乐观锁。看板是多人同时开着的，每次更新必须带上读到的版本号。
	Version int `gorm:"column:version;default:1" description:"乐观锁版本"`

	CreatedBy   string    `gorm:"column:created_by;type:varchar(64)" description:"创建人"`
	UpdatedBy   string    `gorm:"column:updated_by;type:varchar(64)" description:"最后修改人"`
	CreatedTime time.Time `gorm:"column:created_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"创建时间"`
	UpdatedTime time.Time `gorm:"column:updated_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"更新时间"`
}

func (d *DeliveryItem) TableName() string { return "zt_delivery_item" }
func (d *DeliveryItem) Init()             {}

// DeliveryItemExecutionSession 把推进任务绑定到外部执行器会话。
// executor_type 只表达执行器类型，平台特有标识全部收敛到 external_* 与 metadata_json。
type DeliveryItemExecutionSession struct {
	Id      int64  `gorm:"column:id;primaryKey;autoIncrement" description:"主键"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_dlv_item_exec,priority:1;uniqueIndex:uk_dlv_exec_external,priority:1;index:idx_dlv_exec_status,priority:1" description:"业务线"`

	ProgramID    int64  `gorm:"column:program_id;type:bigint;uniqueIndex:uk_dlv_item_exec,priority:2;index:idx_dlv_exec_status,priority:2" description:"所属项目"`
	ItemKey      string `gorm:"column:item_key;type:varchar(64);uniqueIndex:uk_dlv_item_exec,priority:3" description:"所属任务业务键"`
	ExecutorType string `gorm:"column:executor_type;type:varchar(32);uniqueIndex:uk_dlv_item_exec,priority:4;uniqueIndex:uk_dlv_exec_external,priority:2" description:"执行器类型"`
	Phase        string `gorm:"column:phase;type:varchar(16);uniqueIndex:uk_dlv_item_exec,priority:5;index:idx_dlv_exec_status,priority:3" description:"会话所属阶段"`

	ExternalSessionID string `gorm:"column:external_session_id;type:varchar(255);uniqueIndex:uk_dlv_exec_external,priority:3" description:"外部会话标识"`
	ExternalHostID    string `gorm:"column:external_host_id;type:varchar(255)" description:"外部运行节点标识，可空"`
	Status            string `gorm:"column:status;type:varchar(16);index:idx_dlv_exec_status,priority:4" description:"pending/running/completed/blocked/closed"`
	Progress          int    `gorm:"column:progress;default:0" description:"本次运行实例完成进度 0-100"`
	MetadataJSON      string `gorm:"column:metadata_json;type:text" description:"执行器扩展元数据 JSON"`
	Version           int    `gorm:"column:version;default:1" description:"乐观锁版本"`

	// 一行会话记录被同一任务的历次运行复用，这三列描述的是「最近一轮」：
	// 绑定成运行中时写开始时间，收到终态时写结束时间并算出这一轮的耗时。
	RunStartedAt       *time.Time `gorm:"column:run_started_at;type:timestamp NULL" description:"本轮运行开始时间"`
	RunFinishedAt      *time.Time `gorm:"column:run_finished_at;type:timestamp NULL" description:"本轮运行结束时间"`
	LastRunDurationMs  int64      `gorm:"column:last_run_duration_ms;default:0" description:"最近一轮运行耗时毫秒"`
	TotalRunDurationMs int64      `gorm:"column:total_run_duration_ms;default:0" description:"该会话历次运行累计耗时毫秒"`

	CreatedBy   string    `gorm:"column:created_by;type:varchar(64)" description:"创建人"`
	UpdatedBy   string    `gorm:"column:updated_by;type:varchar(64)" description:"最后修改人"`
	CreatedTime time.Time `gorm:"column:created_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"创建时间"`
	UpdatedTime time.Time `gorm:"column:updated_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"更新时间"`
}

func (d *DeliveryItemExecutionSession) TableName() string {
	return "zt_delivery_item_execution_session"
}
func (d *DeliveryItemExecutionSession) Init() {}

// DeliveryExecutionBatch 记录一次由用户在任务面板发起的批量或串行执行。
// 本地桥接负责实际驱动 AI；这里保存跨浏览器刷新、桥接重启后仍可追溯的批次事实。
type DeliveryExecutionBatch struct {
	Id      int64  `gorm:"column:id;primaryKey;autoIncrement" description:"主键"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_dlv_execution_batch,priority:1;index:idx_dlv_execution_batch_notice,priority:1;index:idx_dlv_execution_batch_requirement,priority:1" description:"业务线"`

	ProgramID            int64  `gorm:"column:program_id;type:bigint;uniqueIndex:uk_dlv_execution_batch,priority:2;index:idx_dlv_execution_batch_notice,priority:2;index:idx_dlv_execution_batch_requirement,priority:2" description:"所属项目"`
	BatchID              string `gorm:"column:batch_id;type:varchar(64);uniqueIndex:uk_dlv_execution_batch,priority:3" description:"服务端批次业务键"`
	RequirementKey       string `gorm:"column:requirement_key;type:varchar(64);index:idx_dlv_execution_batch_requirement,priority:3" description:"关联需求键"`
	RequirementName      string `gorm:"column:requirement_name;type:varchar(255)" description:"启动时冻结的需求名称"`
	RequirementGitBranch string `gorm:"column:requirement_git_branch;type:varchar(255)" description:"启动时冻结的需求 Git 分支"`
	Mode                 string `gorm:"column:mode;type:varchar(16)" description:"parallel 批量并行 / sequence 串行"`
	ExecutorType         string `gorm:"column:executor_type;type:varchar(32)" description:"codex / claude"`
	Status               string `gorm:"column:status;type:varchar(16);index:idx_dlv_execution_batch_notice,priority:3" description:"running / completed / blocked"`
	ItemCount            int    `gorm:"column:item_count" description:"批次任务数"`
	CompletedCount       int    `gorm:"column:completed_count" description:"已完成任务数"`
	BlockedCount         int    `gorm:"column:blocked_count" description:"受阻任务数"`
	Summary              string `gorm:"column:summary;type:varchar(2048)" description:"完成或受阻摘要"`
	// 完成消息只发给启动者，单字段即可表示这位启动者是否已经点击过提醒。
	NotificationReadAt *time.Time `gorm:"column:notification_read_at;type:timestamp NULL" description:"完成提醒已读时间"`
	// 本地桥接每隔几十秒续一次心跳。心跳停了说明执行侧已经不在了（断网、进程被杀、机器休眠），
	// 服务端据此把批次判死并放行里面的任务，否则任务会被永久锁在一条没人收尾的 running 批次里。
	HeartbeatAt   *time.Time `gorm:"column:heartbeat_at;type:timestamp NULL" description:"执行侧最近一次心跳时间"`
	StartedAt     *time.Time `gorm:"column:started_at;type:timestamp NULL" description:"开始时间"`
	FinishedAt    *time.Time `gorm:"column:finished_at;type:timestamp NULL;index:idx_dlv_execution_batch_notice,priority:4" description:"结束时间"`
	CreatedBy     string     `gorm:"column:created_by;type:varchar(64);index:idx_dlv_execution_batch_notice,priority:5" description:"启动人"`
	CreatedByName string     `gorm:"column:created_by_name;type:varchar(64)" description:"启动人显示名"`
	UpdatedBy     string     `gorm:"column:updated_by;type:varchar(64)" description:"最后更新人"`
	CreatedTime   time.Time  `gorm:"column:created_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"创建时间"`
	UpdatedTime   time.Time  `gorm:"column:updated_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"更新时间"`
}

func (d *DeliveryExecutionBatch) TableName() string { return "zt_delivery_execution_batch" }
func (d *DeliveryExecutionBatch) Init()             {}

// DeliveryExecutionBatchItem 是批次中的任务快照。任务本身后来被移动或删除也不抹去本次运行记录。
type DeliveryExecutionBatchItem struct {
	Id          int64     `gorm:"column:id;primaryKey;autoIncrement" description:"主键"`
	BizLine     string    `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_dlv_execution_batch_item,priority:1;index:idx_dlv_execution_batch_item_active,priority:1" description:"业务线"`
	ProgramID   int64     `gorm:"column:program_id;type:bigint;uniqueIndex:uk_dlv_execution_batch_item,priority:2;index:idx_dlv_execution_batch_item_active,priority:2" description:"所属项目"`
	BatchID     string    `gorm:"column:batch_id;type:varchar(64);uniqueIndex:uk_dlv_execution_batch_item,priority:3;index:idx_dlv_execution_batch_item_active,priority:3" description:"批次键"`
	ItemKey     string    `gorm:"column:item_key;type:varchar(64);uniqueIndex:uk_dlv_execution_batch_item,priority:4;index:idx_dlv_execution_batch_item_active,priority:4" description:"任务键"`
	Sequence    int       `gorm:"column:sequence" description:"启动请求中的顺序"`
	Status      string    `gorm:"column:status;type:varchar(16)" description:"pending / running / completed / blocked"`
	Message     string    `gorm:"column:message;type:varchar(1024)" description:"该任务在本批次中的结果摘要"`
	CreatedTime time.Time `gorm:"column:created_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"创建时间"`
	UpdatedTime time.Time `gorm:"column:updated_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"更新时间"`
}

func (d *DeliveryExecutionBatchItem) TableName() string { return "zt_delivery_execution_batch_item" }
func (d *DeliveryExecutionBatchItem) Init()             {}

// DeliveryItemDependency 任务依赖边。PredecessorItemKey -> SuccessorItemKey 表示
// 后置任务必须等待前置任务；一对多表示并行分叉，多对一表示汇合。
//
// 不建外键：任务删除时由 service 在同一事务里清理相关边，环形依赖也由 service 校验。
type DeliveryItemDependency struct {
	Id      int64  `gorm:"column:id;primaryKey;autoIncrement" description:"主键"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_dlv_item_dep,priority:1;index:idx_dlv_item_dep_pre,priority:1;index:idx_dlv_item_dep_suc,priority:1" description:"业务线"`

	ProgramID          int64  `gorm:"column:program_id;type:bigint;uniqueIndex:uk_dlv_item_dep,priority:2;index:idx_dlv_item_dep_pre,priority:2;index:idx_dlv_item_dep_suc,priority:2" description:"所属项目"`
	PredecessorItemKey string `gorm:"column:predecessor_item_key;type:varchar(64);uniqueIndex:uk_dlv_item_dep,priority:3;index:idx_dlv_item_dep_pre,priority:3" description:"前置任务业务键"`
	SuccessorItemKey   string `gorm:"column:successor_item_key;type:varchar(64);uniqueIndex:uk_dlv_item_dep,priority:4;index:idx_dlv_item_dep_suc,priority:3" description:"后置任务业务键"`
	SourceSide         string `gorm:"column:source_side;type:varchar(8);default:''" description:"箭头从前置任务的边框出发 top/right/bottom/left，空值自动选择"`
	TargetSide         string `gorm:"column:target_side;type:varchar(8);default:''" description:"箭头连接后置任务的边框 top/right/bottom/left，空值自动选择"`

	CreatedBy   string    `gorm:"column:created_by;type:varchar(64)" description:"创建人"`
	CreatedTime time.Time `gorm:"column:created_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"创建时间"`
}

func (d *DeliveryItemDependency) TableName() string { return "zt_delivery_item_dependency" }
func (d *DeliveryItemDependency) Init()             {}

// DeliveryItemEvent 任务流水：状态流转、进度改动、进展评论各算一条。
//
// 没有这张表，看板只有「当前快照」，回答不了「这个月推动了什么」「这条卡了几天」——
// 而这正是全景报告里点名的问题：管理层只能看结果，看不到过程。
// 评论与字段变更合成一张表用 kind 区分，拆两张查时间线要 union，不值当。
type DeliveryItemEvent struct {
	Id      int64  `gorm:"column:id;primaryKey;autoIncrement" description:"主键"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);index:idx_dlv_event_item,priority:1;index:idx_dlv_event_time,priority:1;index:idx_dlv_event_requirement_time,priority:1" description:"业务线"`

	ProgramID int64  `gorm:"column:program_id;type:bigint;index:idx_dlv_event_item,priority:2;index:idx_dlv_event_time,priority:2;index:idx_dlv_event_requirement_time,priority:2" description:"所属项目"`
	ItemKey   string `gorm:"column:item_key;type:varchar(64);index:idx_dlv_event_item,priority:3" description:"任务业务键"`
	// RequirementKey 在事件写入时冻结，任务被删除或重新归属后，原需求仍能看到这段历史。
	RequirementKey string `gorm:"column:requirement_key;type:varchar(64);index:idx_dlv_event_requirement_time,priority:3" description:"事件发生时所属需求业务键"`

	Kind      string `gorm:"column:kind;type:varchar(16)" description:"create 新建 / field 字段变更 / comment 进展 / delete 删除"`
	Field     string `gorm:"column:field;type:varchar(32)" description:"变更字段名，kind=field 时有值"`
	FromValue string `gorm:"column:from_value;type:varchar(255)" description:"变更前"`
	ToValue   string `gorm:"column:to_value;type:varchar(255)" description:"变更后"`
	Comment   string `gorm:"column:comment;type:varchar(1024)" description:"进展说明"`

	ActorID     string    `gorm:"column:actor_id;type:varchar(64)" description:"操作人，取自凭证不取请求体"`
	ActorName   string    `gorm:"column:actor_name;type:varchar(64)" description:"操作人显示名"`
	CreatedTime time.Time `gorm:"column:created_time;type:timestamp;default:CURRENT_TIMESTAMP;index:idx_dlv_event_time,priority:3;index:idx_dlv_event_requirement_time,priority:4" description:"发生时间"`
}

func (d *DeliveryItemEvent) TableName() string { return "zt_delivery_item_event" }
func (d *DeliveryItemEvent) Init()             {}

// DeliverySnapshot 每日进度快照，按 (项目, 模块) 一行，module_key 为空串的那行是整体。
//
// 趋势线和三维全景图的历史对比全靠它 —— 拿当前的 item 表算不出上周的进度，
// 状态被覆盖之后历史就没了。
type DeliverySnapshot struct {
	Id      int64  `gorm:"column:id;primaryKey;autoIncrement" description:"主键"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_dlv_snapshot,priority:1" description:"业务线"`

	ProgramID int64     `gorm:"column:program_id;type:bigint;uniqueIndex:uk_dlv_snapshot,priority:2" description:"所属项目"`
	StatDate  time.Time `gorm:"column:stat_date;type:date;uniqueIndex:uk_dlv_snapshot,priority:3" description:"统计日期"`
	ModuleKey string    `gorm:"column:module_key;type:varchar(64);uniqueIndex:uk_dlv_snapshot,priority:4" description:"模块业务键，空串表示整体"`

	Progress      float64 `gorm:"column:progress;type:decimal(5,2)" description:"该模块进度，非 dropped 任务的平均值"`
	MaturityScore float64 `gorm:"column:maturity_score;type:decimal(5,2)" description:"加权成熟度，仅整体行有值"`

	TotalCount   int `gorm:"column:total_count" description:"任务总数（不含 dropped）"`
	DoneCount    int `gorm:"column:done_count" description:"已完成"`
	DoingCount   int `gorm:"column:doing_count" description:"进行中"`
	BlockedCount int `gorm:"column:blocked_count" description:"受阻"`

	CreatedTime time.Time `gorm:"column:created_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"落库时间"`
}

func (d *DeliverySnapshot) TableName() string { return "zt_delivery_snapshot" }
func (d *DeliverySnapshot) Init()             {}
