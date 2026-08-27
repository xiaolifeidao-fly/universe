// 任务相关的请求、查询与视图。

package dto

import (
	"time"

	"contract"
)

// ---------- 任务 ----------

type ItemQuery struct {
	Page
	BizLine        contract.BizLine `form:"-"`
	ProgramID      int64            `form:"programId"`
	StageKey       string           `form:"stageKey"`
	ModuleKey      string           `form:"moduleKey"`
	RequirementKey string           `form:"requirementKey"`
	Status         string           `form:"status"`
	Phase          string           `form:"phase"`
	Kind           string           `form:"kind"`
	OwnerName      string           `form:"ownerName"`
	Keyword        string           `form:"keyword"`
	// Sort=recent 仅供按最近创建时间取候选的轻量列表使用；空值仍保持看板的手工排序。
	Sort string `form:"sort"`
}

type ItemView struct {
	ItemKey        string           `json:"itemKey"`
	BizLine        contract.BizLine `json:"bizLine"`
	ProgramID      int64            `json:"programId"`
	StageKey       string           `json:"stageKey"`
	ModuleKey      string           `json:"moduleKey"`
	RequirementKey string           `json:"requirementKey"`
	// PlanningBatchKey 是任务来自哪一次需求拆解；非必填，手工新建和存量任务为空串。
	PlanningBatchKey string `json:"planningBatchKey"`
	Kind             string `json:"kind"`
	Title          string           `json:"title"`
	Description    string           `json:"description"`
	// BenefitTags 用简短标签说明任务交付后带来的收益或作用。
	BenefitTags []string `json:"benefitTags"`
	// 大字段仅在 GET /delivery/item 的详情响应中返回，避免拖慢看板列表。
	RequirementDocument     string `json:"requirementDocument,omitempty"` // 旧数据兼容，权威内容改为读取 RequirementDocumentPath。
	RequirementDocumentPath string `json:"requirementDocumentPath"`
	ActionOutput            string `json:"actionOutput,omitempty"`
	TestingReport           string `json:"testingReport,omitempty"`
	TestingCasesStatus      string `json:"testingCasesStatus"`
	TestingCases            string `json:"testingCases,omitempty"`
	TestingCasesPath        string `json:"testingCasesPath"`
	ExecutionOutput         string `json:"executionOutput,omitempty"` // 旧客户端兼容，等同于 ActionOutput。
	// Phase + Status 是任务唯一的当前归属和状态。
	Phase             string     `json:"phase"`
	RequirementStatus string     `json:"requirementStatus"`
	DevelopmentStatus string     `json:"developmentStatus"`
	TestingStatus     string     `json:"testingStatus"`
	Status            string     `json:"status"`
	Progress          int        `json:"progress"`
	OwnerID           string     `json:"ownerId"`
	OwnerName         string     `json:"ownerName"`
	DueDate           *time.Time `json:"dueDate"`
	Note              string     `json:"note"`
	SortOrder         int        `json:"sortOrder"`
	// DependsOnItemKeys 是当前任务的直接前置任务；服务端保证整张图无环。
	DependsOnItemKeys []string `json:"dependsOnItemKeys"`
	// DependencySourceSides 以前置任务键为 key，记录箭头从前置任务的哪条边出发。
	DependencySourceSides map[string]string `json:"dependencySourceSides"`
	// DependencyTargetSides 以前置任务键为 key，记录箭头连接当前任务的哪条边。
	DependencyTargetSides map[string]string `json:"dependencyTargetSides"`
	// Version 前端改这条时必须原样带回来，服务端据此判定并发冲突。
	Version   int        `json:"version"`
	CreatedAt *time.Time `json:"createdAt"`
	UpdatedBy string     `json:"updatedBy"`
	UpdatedAt *time.Time `json:"updatedAt"`
}

type ItemPage struct {
	Total int64      `json:"total"`
	Data  []ItemView `json:"data"`
}

type SaveItemRequest struct {
	BizLine                 contract.BizLine  `json:"-"`
	ProgramID               int64             `json:"programId"`
	ItemKey                 string            `json:"itemKey"`
	StageKey                string            `json:"stageKey"`
	ModuleKey               string            `json:"moduleKey"`
	RequirementKey          string            `json:"requirementKey"`
	PlanningBatchKey        string            `json:"planningBatchKey"`
	Kind                    string            `json:"kind"`
	Title                   string            `json:"title"`
	Description             string            `json:"description"`
	BenefitTags             []string          `json:"benefitTags"`
	RequirementDocument     string            `json:"requirementDocument"`
	RequirementDocumentPath string            `json:"requirementDocumentPath"`
	ActionOutput            string            `json:"actionOutput"`
	TestingReport           string            `json:"testingReport"`
	Phase                   string            `json:"phase"`
	Status                  string            `json:"status"`
	RequirementStatus       string            `json:"requirementStatus"`
	DevelopmentStatus       string            `json:"developmentStatus"`
	TestingStatus           string            `json:"testingStatus"`
	Progress                int               `json:"progress"`
	OwnerID                 string            `json:"ownerId"`
	OwnerName               string            `json:"ownerName"`
	DueDate                 string            `json:"dueDate"`
	Note                    string            `json:"note"`
	SortOrder               int               `json:"sortOrder"`
	DependsOnItemKeys       []string          `json:"dependsOnItemKeys"`
	DependencySourceSides   map[string]string `json:"dependencySourceSides"`
	DependencyTargetSides   map[string]string `json:"dependencyTargetSides"`
	ActorID                 string            `json:"-"`
	ActorName               string            `json:"actorName"`
}

// PatchItemRequest 单条局部更新。指针字段表示「这次没改就别动」，
// 这样拖一下卡片只发一个 status，不会把别人同时改的负责人覆盖回去。
type PatchItemRequest struct {
	BizLine   contract.BizLine `json:"-"`
	ProgramID int64            `json:"programId"`
	ItemKey   string           `json:"itemKey"`
	Version   int              `json:"version"`

	StageKey                *string   `json:"stageKey"`
	ModuleKey               *string   `json:"moduleKey"`
	RequirementKey          *string   `json:"requirementKey"`
	Kind                    *string   `json:"kind"`
	Title                   *string   `json:"title"`
	Description             *string   `json:"description"`
	BenefitTags             *[]string `json:"benefitTags"`
	RequirementDocument     *string   `json:"requirementDocument"`
	RequirementDocumentPath *string   `json:"requirementDocumentPath"`
	ActionOutput            *string   `json:"actionOutput"`
	TestingReport           *string   `json:"testingReport"`
	Phase                   *string   `json:"phase"`
	ExecutionOutput         *string   `json:"executionOutput"` // 旧调用兼容，写入动作执行产物。
	Status                  *string   `json:"status"`
	RequirementStatus       *string   `json:"requirementStatus"`
	DevelopmentStatus       *string   `json:"developmentStatus"`
	TestingStatus           *string   `json:"testingStatus"`
	Progress                *int      `json:"progress"`
	OwnerID                 *string   `json:"ownerId"`
	OwnerName               *string   `json:"ownerName"`
	// DueDate 传 "2026-08-11" 设置，传 "" 清空，不传保持原值。
	DueDate   *string `json:"dueDate"`
	Note      *string `json:"note"`
	SortOrder *int    `json:"sortOrder"`
	// 指针用于区分「不修改依赖」与「清空全部依赖」。
	DependsOnItemKeys     *[]string          `json:"dependsOnItemKeys"`
	DependencySourceSides *map[string]string `json:"dependencySourceSides"`
	DependencyTargetSides *map[string]string `json:"dependencyTargetSides"`

	// Comment 随这次改动记一条进展说明，进同一条时间线。
	Comment   string `json:"comment"`
	ActorID   string `json:"-"`
	ActorName string `json:"actorName"`
}

// UpdateItemTestingCasesRequest 由测试用例生成桥独立回写。它不得改变任务 phase/status/progress，
// 也不走任务编辑的乐观锁，从而可与研发动作执行并行。
type UpdateItemTestingCasesRequest struct {
	BizLine            contract.BizLine `json:"-"`
	ProgramID          int64            `json:"programId"`
	ItemKey            string           `json:"itemKey"`
	TestingCasesStatus string           `json:"testingCasesStatus"`
	TestingCases       *string          `json:"testingCases"`
	ActorID            string           `json:"-"`
	ActorName          string           `json:"actorName"`
}

// AdvancePhaseRequest 仅允许把已完成的当前阶段推进到下一阶段的进行中状态。
// 每条任务都带 version，批量操作也遵循乐观锁，避免把别人的修改覆盖掉。
type AdvancePhaseItem struct {
	ItemKey string `json:"itemKey"`
	Version int    `json:"version"`
}

type AdvancePhaseRequest struct {
	BizLine   contract.BizLine   `json:"-"`
	ProgramID int64              `json:"programId"`
	Phase     string             `json:"phase"`
	Items     []AdvancePhaseItem `json:"items"`
	ActorID   string             `json:"-"`
	ActorName string             `json:"actorName"`
}

type DeleteItemRequest struct {
	BizLine   contract.BizLine `json:"-"`
	ProgramID int64            `json:"programId"`
	ItemKey   string           `json:"itemKey"`
	ActorID   string           `json:"-"`
	ActorName string           `json:"actorName"`
}

type CommentRequest struct {
	BizLine   contract.BizLine `json:"-"`
	ProgramID int64            `json:"programId"`
	ItemKey   string           `json:"itemKey"`
	Comment   string           `json:"comment"`
	ActorID   string           `json:"-"`
	ActorName string           `json:"actorName"`
}
