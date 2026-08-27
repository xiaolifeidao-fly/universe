// 需求拆解批次的数据形状。批次描述「这批任务是哪一次拆解写进来的」，
// 与执行批次（一次批量运行）不是同一个概念，也不共用一张表。
package dto

import (
	"time"

	"contract"
)

// PlanningBatchView 一条需求下的一次拆解批次。
type PlanningBatchView struct {
	BatchKey       string           `json:"batchKey"`
	BizLine        contract.BizLine `json:"bizLine"`
	ProgramID      int64            `json:"programId"`
	RequirementKey string           `json:"requirementKey"`
	Seq            int              `json:"seq"`
	Title          string           `json:"title"`
	Source         string           `json:"source"`
	ExecutorType   string           `json:"executorType"`
	ThreadID       string           `json:"threadId"`
	Summary        string           `json:"summary"`
	// ItemCount 是写入时登记的任务数；任务可能被删除，实际归属仍以任务表为准。
	ItemCount     int        `json:"itemCount"`
	CreatedBy     string     `json:"createdBy"`
	CreatedByName string     `json:"createdByName"`
	CreatedAt     *time.Time `json:"createdAt"`
	UpdatedAt     *time.Time `json:"updatedAt"`
}

type PlanningBatchQuery struct {
	BizLine        contract.BizLine `form:"-"`
	ProgramID      int64            `form:"programId"`
	RequirementKey string           `form:"requirementKey"`
}

type CreatePlanningBatchRequest struct {
	BizLine        contract.BizLine `json:"-"`
	ProgramID      int64            `json:"programId"`
	RequirementKey string           `json:"requirementKey"`
	Title          string           `json:"title"`
	Source         string           `json:"source"`
	ExecutorType   string           `json:"executorType"`
	ThreadID       string           `json:"threadId"`
	Summary        string           `json:"summary"`
	ItemCount      int              `json:"itemCount"`
	ActorID        string           `json:"-"`
	ActorName      string           `json:"actorName"`
}
