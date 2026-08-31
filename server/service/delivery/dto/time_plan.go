// 时间计划相关的请求、查询与视图。
//
// 时间计划是项目的交付时间窗口，在 Git 上对应一条从基准分支切出的发布分支。
// 服务端只保存计划元数据和分支关联；分支创建、回合基线、合并需求分支全部发生在
// 本机桥接的项目工作目录里，服务端不执行任何 Git 命令。

package dto

import (
	"time"

	"contract"
)

// ---------- 时间计划 ----------

const (
	TimePlanStatusActive   = "active"
	TimePlanStatusDone     = "done"
	TimePlanStatusArchived = "archived"
)

type TimePlanView struct {
	PlanKey   string           `json:"planKey"`
	BizLine   contract.BizLine `json:"bizLine"`
	ProgramID int64            `json:"programId"`
	Name      string           `json:"name"`
	StartAt   *time.Time       `json:"startAt"`
	EndAt     *time.Time       `json:"endAt"`
	Status    string           `json:"status"`

	BaseBranch      string     `json:"baseBranch"`
	Branch          string     `json:"branch"`
	BranchCreatedAt *time.Time `json:"branchCreatedAt"`
	// 三个合并方向各记各的最近一次成功时间，互不覆盖。
	BaseSyncedAt        *time.Time `json:"baseSyncedAt"`
	RequirementMergedAt *time.Time `json:"requirementMergedAt"`
	BasePublishedAt     *time.Time `json:"basePublishedAt"`

	// RequirementCount 是挂在这个计划下的需求条数，列表用它，不拉需求明细。
	RequirementCount int64 `json:"requirementCount"`

	Version       int        `json:"version"`
	CreatedBy     string     `json:"createdBy"`
	CreatedByName string     `json:"createdByName"`
	CreatedAt     *time.Time `json:"createdAt"`
	UpdatedBy     string     `json:"updatedBy"`
	UpdatedAt     *time.Time `json:"updatedAt"`
}

// TimePlanRequirementView 是合并需求分支时要用的需求摘要：只带分支相关的字段，
// 不复用完整的 RequirementView，避免合并弹窗为了几个字段拉一整份需求详情。
type TimePlanRequirementView struct {
	RequirementKey string `json:"requirementKey"`
	Name           string `json:"name"`
	Status         string `json:"status"`
	GitBranch      string `json:"gitBranch"`
	GitBaseBranch  string `json:"gitBaseBranch"`
	// GitEnabled 为 false 或分支为空的需求不会出现在合并候选里，但仍会列出来说明原因。
	GitEnabled bool `json:"gitEnabled"`
}

type TimePlanQuery struct {
	Page
	BizLine   contract.BizLine `form:"-"`
	ProgramID int64            `form:"programId"`
	Status    string           `form:"status"`
	Keyword   string           `form:"keyword"`
}

type TimePlanPage struct {
	Total int64          `json:"total"`
	Data  []TimePlanView `json:"data"`
}

// SaveTimePlanRequest PlanKey 为空表示新建；带 key 表示更新，更新必须带上读到的 Version。
// Branch 留空时由服务端按截止日期生成 release/{YYYYMMDD}。
type SaveTimePlanRequest struct {
	BizLine    contract.BizLine `json:"-"`
	ProgramID  int64            `json:"programId"`
	PlanKey    string           `json:"planKey"`
	Name       string           `json:"name"`
	StartAt    *time.Time       `json:"startAt"`
	EndAt      *time.Time       `json:"endAt"`
	Status     string           `json:"status"`
	BaseBranch string           `json:"baseBranch"`
	Branch     string           `json:"branch"`
	Version    int              `json:"version"`
	ActorID    string           `json:"-"`
	ActorName  string           `json:"actorName"`
}

// BindTimePlanBranchRequest 由浏览器在本机桥接确认分支创建成功后调用；服务端只记录关联结果。
// 不复用编辑版号：分支创建的确认和用户编辑计划名称不该互相造成版本冲突。
type BindTimePlanBranchRequest struct {
	BizLine    contract.BizLine `json:"-"`
	ProgramID  int64            `json:"programId"`
	PlanKey    string           `json:"planKey"`
	BaseBranch string           `json:"baseBranch"`
	Branch     string           `json:"branch"`
	ActorID    string           `json:"-"`
	ActorName  string           `json:"actorName"`
}

// TimePlanMergeKind 区分三个合并方向，服务端据此记录各自的最近成功时间：
//   - base        基线分支 → 计划分支，把主干最新拉进发布分支
//   - requirement 需求分支 → 计划分支，把这一批需求汇总进发布分支
//   - publish     计划分支 → 基线分支，发布分支验收完回推主干
const (
	TimePlanMergeKindBase        = "base"
	TimePlanMergeKindRequirement = "requirement"
	TimePlanMergeKindPublish     = "publish"
)

// RecordTimePlanMergeRequest 在本机合并成功后回写事实。服务端不判断合并结果对不对，
// 只记录「什么时候、谁、做过哪一类合并」，供计划列表展示。
type RecordTimePlanMergeRequest struct {
	BizLine   contract.BizLine `json:"-"`
	ProgramID int64            `json:"programId"`
	PlanKey   string           `json:"planKey"`
	Kind      string           `json:"kind"`
	ActorID   string           `json:"-"`
	ActorName string           `json:"actorName"`
}

type DeleteTimePlanRequest struct {
	BizLine   contract.BizLine `json:"-"`
	ProgramID int64            `json:"programId"`
	PlanKey   string           `json:"planKey"`
	ActorID   string           `json:"-"`
	ActorName string           `json:"actorName"`
}

// BindRequirementTimePlanRequest 需求列表和工作台的「关联时间计划」按钮用它。
// PlanKey 传空串表示解除关联。不带 version：关联动作和需求正文编辑互不相干。
type BindRequirementTimePlanRequest struct {
	BizLine        contract.BizLine `json:"-"`
	ProgramID      int64            `json:"programId"`
	RequirementKey string           `json:"requirementKey"`
	PlanKey        string           `json:"planKey"`
	ActorID        string           `json:"-"`
	ActorName      string           `json:"actorName"`
}

type TimePlanRequirementQuery struct {
	BizLine   contract.BizLine `form:"-"`
	ProgramID int64            `form:"programId"`
	PlanKey   string           `form:"planKey"`
}
