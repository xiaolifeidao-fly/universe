// Package repository 只能被 service/delivery 目录树引用（Go internal 规则）。
//
// zt_delivery_* 八张表的写入口全在这个包里，因此「交付推进数据只由 delivery 层写」
// 是编译期事实而非约定。
package repository

import "time"

// DeliveryProgram 交付项目。一个甲方 / 一个国家的落地推进算一个项目，
// 对应原型 assets/tasks.json 的 meta 段（"印尼业务 · 任务维护看板"）。
//
// id 是所有项目范围操作使用的全局主键；program_code 仅保留为可读的业务编码。
// biz_line 是项目的归属属性，仍保留在每张交付表上以支持按业务线浏览与统计。
type DeliveryProgram struct {
	Id      int64  `gorm:"column:id;primaryKey;autoIncrement" description:"主键"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);index:idx_dlv_program_biz_line" description:"业务线"`

	ProgramCode string `gorm:"column:program_code;type:varchar(64);uniqueIndex:uk_dlv_program_code" description:"项目业务编码，如 indonesia；仅展示与导入幂等使用"`
	Name        string `gorm:"column:name;type:varchar(128)" description:"项目名称"`
	Summary     string `gorm:"column:summary;type:varchar(512)" description:"一句话说明"`
	Status      string `gorm:"column:status;type:varchar(16);default:'active'" description:"active 进行中 / archived 已归档"`

	CreatedBy   string    `gorm:"column:created_by;type:varchar(64)" description:"创建人"`
	UpdatedBy   string    `gorm:"column:updated_by;type:varchar(64)" description:"最后修改人"`
	CreatedTime time.Time `gorm:"column:created_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"创建时间"`
	UpdatedTime time.Time `gorm:"column:updated_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"更新时间"`
}

func (d *DeliveryProgram) TableName() string { return "zt_delivery_program" }
func (d *DeliveryProgram) Init()             {}

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

// DeliveryRequirement 需求：项目与任务之间缺失的那一层。
//
// 一次「新增需求」产出一批任务：需求记录「要做什么、谁负责」，任务记录「拆成了哪些活」。
// 拆解会话也挂在需求上 —— 追问同一个需求时，已经建出来的任务列表要一并带回给执行器。
//
// OwnerIDs / AssistantIDs 用 ,1,2, 这种前后都带逗号的形式存，
// 「和我有关的需求」用 LIKE '%,3,%' 就能命中，不用再开一张关联表。
type DeliveryRequirement struct {
	Id      int64  `gorm:"column:id;primaryKey;autoIncrement" description:"主键"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_dlv_requirement,priority:1;index:idx_dlv_requirement_program,priority:1" description:"业务线"`

	ProgramID      int64  `gorm:"column:program_id;type:bigint;uniqueIndex:uk_dlv_requirement,priority:2;index:idx_dlv_requirement_program,priority:2" description:"所属项目"`
	RequirementKey string `gorm:"column:requirement_key;type:varchar(64);uniqueIndex:uk_dlv_requirement,priority:3" description:"需求业务键 如 req-20260813-01"`

	Name   string `gorm:"column:name;type:varchar(255)" description:"需求名称"`
	Detail string `gorm:"column:detail;type:mediumtext" description:"需求详细信息"`
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
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_dlv_item,priority:1;index:idx_dlv_item_board,priority:1;index:idx_dlv_item_module,priority:1;index:idx_dlv_item_requirement_key,priority:1" description:"业务线"`

	ProgramID int64  `gorm:"column:program_id;type:bigint;uniqueIndex:uk_dlv_item,priority:2;index:idx_dlv_item_board,priority:2;index:idx_dlv_item_module,priority:2;index:idx_dlv_item_requirement_key,priority:2" description:"所属项目"`
	ItemKey   string `gorm:"column:item_key;type:varchar(64);uniqueIndex:uk_dlv_item,priority:3" description:"任务业务键 如 data-p01，沿用原型 id 便于导入"`

	StageKey  string `gorm:"column:stage_key;type:varchar(64);index:idx_dlv_item_board,priority:3" description:"所属阶段"`
	ModuleKey string `gorm:"column:module_key;type:varchar(64);index:idx_dlv_item_module,priority:3" description:"所属模块"`
	// RequirementKey 是任务归属的需求；空串表示需求层落地之前建的存量任务。
	RequirementKey string `gorm:"column:requirement_key;type:varchar(64);index:idx_dlv_item_requirement_key,priority:3" description:"所属需求"`
	Kind           string `gorm:"column:kind;type:varchar(16)" description:"gap 坑点 / capability 能力 / asset 已具备"`
	// PrototypeTask 仅兼容旧数据；新需求原型挂在需求本身，不再创建额外任务。
	PrototypeTask bool `gorm:"column:prototype_task;default:false" description:"历史原型任务标记，新流程不写入"`

	Title       string `gorm:"column:title;type:varchar(255)" description:"任务标题"`
	Description string `gorm:"column:description;type:varchar(1024)" description:"说明"`
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

	CreatedBy   string    `gorm:"column:created_by;type:varchar(64)" description:"创建人"`
	UpdatedBy   string    `gorm:"column:updated_by;type:varchar(64)" description:"最后修改人"`
	CreatedTime time.Time `gorm:"column:created_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"创建时间"`
	UpdatedTime time.Time `gorm:"column:updated_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"更新时间"`
}

func (d *DeliveryItemExecutionSession) TableName() string {
	return "zt_delivery_item_execution_session"
}
func (d *DeliveryItemExecutionSession) Init() {}

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
