// 需求相关的请求、查询与视图，含 HTML 原型。

package dto

import (
	"time"

	"contract"
)

// ---------- 需求 ----------

// RequirementMember 主负责人 / 辅助人。前端选人时给 id，显示名由服务端一并落库，
// 这样需求列表不用为了显示名字再去关联用户表。
type RequirementMember struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type RequirementView struct {
	RequirementKey string           `json:"requirementKey"`
	BizLine        contract.BizLine `json:"bizLine"`
	ProgramID      int64            `json:"programId"`
	Name           string           `json:"name"`
	Detail         string           `json:"detail"`
	// ReferenceRequirementKeys 是需求详情里 @ 引用的历史需求；插件按这些键取各自的大纲产物地址。
	ReferenceRequirementKeys []string `json:"referenceRequirementKeys"`
	// ReferenceItemKeys 是需求详情里 @ 引用的既有任务；插件按这些键读取任务需求文档。
	ReferenceItemKeys []string   `json:"referenceItemKeys"`
	PlannedStartAt    *time.Time `json:"plannedStartAt"`
	PlannedEndAt      *time.Time `json:"plannedEndAt"`
	Status            string     `json:"status"`
	Mode              string     `json:"mode"`
	StartPhase        string     `json:"startPhase"`
	SplitTasks        bool       `json:"splitTasks"`
	// PreGenerateTaskDocuments 控制确认拆解后是否预生成每条任务的需求文档。
	// GenerateTaskOutline 保留在响应中，兼容尚未升级的旧面板和本地桥接器。
	PreGenerateTaskDocuments bool `json:"preGenerateTaskDocuments"`
	GenerateTaskOutline      bool `json:"generateTaskOutline,omitempty"`
	GeneratePrototype        bool `json:"generatePrototype"`
	// GitEnabled 表示该需求是否关联一个独立 Git 分支；分支实际创建由本机桥接完成。
	// 为 null 表示这条需求没有单独设置过，调用方应回落到自己的默认偏好。
	GitEnabled           *bool      `json:"gitEnabled"`
	GitBaseBranch        string     `json:"gitBaseBranch"`
	GitBranch            string     `json:"gitBranch"`
	GitBranchCreatedAt   *time.Time `json:"gitBranchCreatedAt"`
	PrototypeHTMLPath    string     `json:"prototypeHtmlPath"`
	PrototypeGeneratedAt *time.Time `json:"prototypeGeneratedAt"`
	TestingStatus        string     `json:"testingStatus"`
	TestingReport        string     `json:"testingReport"`
	TestingReportPath    string     `json:"testingReportPath"`
	TestingReportedAt    *time.Time `json:"testingReportedAt"`
	// 测试用例设计与真实执行分开保存：研发进行时可以先准备，不得因此改变总体测试结论。
	TestingCasesStatus string              `json:"testingCasesStatus"`
	TestingCases       string              `json:"testingCases"`
	TestingCasesPath   string              `json:"testingCasesPath"`
	StageKey           string              `json:"stageKey"`
	ModuleKey          string              `json:"moduleKey"`
	Kind               string              `json:"kind"`
	Owners             []RequirementMember `json:"owners"`
	Assistants         []RequirementMember `json:"assistants"`
	ItemCount          int64               `json:"itemCount"`
	Version            int                 `json:"version"`
	CreatedBy          string              `json:"createdBy"`
	CreatedByName      string              `json:"createdByName"`
	CreatedAt          *time.Time          `json:"createdAt"`
	UpdatedBy          string              `json:"updatedBy"`
	UpdatedAt          *time.Time          `json:"updatedAt"`
}

// RequirementPrototypeView 是需求关联的 HTML 原型元数据。文件正文在项目工作区 doc/ 下，
// 浏览器通过本地桥接读取后用 iframe sandbox 预览。
type RequirementPrototypeView struct {
	RequirementKey string     `json:"requirementKey"`
	Path           string     `json:"path"`
	Exists         bool       `json:"exists"`
	GeneratedAt    *time.Time `json:"generatedAt"`
}

type RequirementPage struct {
	Total int64             `json:"total"`
	Data  []RequirementView `json:"data"`
}

// RequirementQuery Scope=mine 只看和我有关的（我创建 / 我负责 / 我辅助），
// 其余取值表示不限定。
type RequirementQuery struct {
	Page
	BizLine   contract.BizLine `form:"-"`
	ProgramID int64            `form:"programId"`
	Keyword   string           `form:"keyword"`
	Status    string           `form:"status"`
	Scope     string           `form:"scope"`
	ActorID   string           `form:"-"`
}

// SaveRequirementRequest RequirementKey 为空表示新建；带 key 表示更新，
// 更新必须带上读到的 Version。
type SaveRequirementRequest struct {
	BizLine        contract.BizLine `json:"-"`
	ProgramID      int64            `json:"programId"`
	RequirementKey string           `json:"requirementKey"`
	Name           string           `json:"name"`
	Detail         string           `json:"detail"`
	// ReferenceRequirementKeys 用指针表达「本次请求没提这件事」：老客户端不传时保持原有引用。
	ReferenceRequirementKeys *[]string `json:"referenceRequirementKeys"`
	// ReferenceItemKeys 用指针表达「本次请求没提这件事」：老客户端不传时保持原有关联。
	ReferenceItemKeys *[]string  `json:"referenceItemKeys"`
	PlannedStartAt    *time.Time `json:"plannedStartAt"`
	PlannedEndAt      *time.Time `json:"plannedEndAt"`
	Status            string     `json:"status"`
	Mode              string     `json:"mode"`
	StartPhase        string     `json:"startPhase"`
	// SplitTasks 用指针表达「本次请求没提这件事」：老客户端不传时新建按默认拆解、编辑保持原值。
	SplitTasks *bool `json:"splitTasks"`
	// PreGenerateTaskDocuments 用指针区分「没提」：新建默认不预生成，编辑保持原值。
	PreGenerateTaskDocuments *bool `json:"preGenerateTaskDocuments"`
	// GenerateTaskOutline 是旧字段，升级中的旧面板仍可用；新调用方必须传上面的字段。
	GenerateTaskOutline *bool `json:"generateTaskOutline"`
	GeneratePrototype   bool  `json:"generatePrototype"`
	// GitEnabled 用指针区分旧客户端未传和明确关闭；分支字段同理，防止旧客户端覆盖关联信息。
	GitEnabled    *bool               `json:"gitEnabled"`
	GitBaseBranch *string             `json:"gitBaseBranch"`
	GitBranch     *string             `json:"gitBranch"`
	StageKey      string              `json:"stageKey"`
	ModuleKey     string              `json:"moduleKey"`
	Kind          string              `json:"kind"`
	Owners        []RequirementMember `json:"owners"`
	Assistants    []RequirementMember `json:"assistants"`
	Version       int                 `json:"version"`
	ActorID       string              `json:"-"`
	ActorName     string              `json:"actorName"`
}

// BindRequirementGitBranch 在本机成功创建分支后记录关联；不复用编辑版号，
// 以免分支创建的异步确认和用户编辑需求正文互相造成版本冲突。
type BindRequirementGitBranchRequest struct {
	BizLine        contract.BizLine `json:"-"`
	ProgramID      int64            `json:"programId"`
	RequirementKey string           `json:"requirementKey"`
	GitBaseBranch  string           `json:"gitBaseBranch"`
	GitBranch      string           `json:"gitBranch"`
	ActorID        string           `json:"-"`
	ActorName      string           `json:"actorName"`
}

type DeleteRequirementRequest struct {
	BizLine        contract.BizLine `json:"-"`
	ProgramID      int64            `json:"programId"`
	RequirementKey string           `json:"requirementKey"`
	ActorID        string           `json:"-"`
	ActorName      string           `json:"actorName"`
}

type SaveRequirementPrototypeRequest struct {
	BizLine        contract.BizLine `json:"-"`
	ProgramID      int64            `json:"programId"`
	RequirementKey string           `json:"requirementKey"`
	Path           string           `json:"path"`
	ActorID        string           `json:"-"`
	ActorName      string           `json:"actorName"`
}

// UpdateRequirementTestingRequest 由本地测试桥回写需求总体测试的独立产物。
// 指针字段区分“本轮不覆盖既有产物”和“明确写入空文本”。
type UpdateRequirementTestingRequest struct {
	BizLine            contract.BizLine `json:"-"`
	ProgramID          int64            `json:"programId"`
	RequirementKey     string           `json:"requirementKey"`
	TestingStatus      *string          `json:"testingStatus"`
	TestingReport      *string          `json:"testingReport"`
	TestingCasesStatus *string          `json:"testingCasesStatus"`
	TestingCases       *string          `json:"testingCases"`
	ActorID            string           `json:"-"`
	ActorName          string           `json:"actorName"`
}
