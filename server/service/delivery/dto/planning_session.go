// 需求拆解会话相关的请求、查询与视图。

package dto

import (
	"time"

	"contract"
)

// ---------- 需求拆解会话 ----------

// PlanningSessionView 一条需求下的一轮拆解对话。只描述目录，正文在执行器自己的会话缓存里。
type PlanningSessionView struct {
	ProgramID      int64          `json:"programId"`
	RequirementKey string         `json:"requirementKey"`
	ExecutorType   string         `json:"executorType"`
	ThreadID       string         `json:"threadId"`
	Title          string         `json:"title"`
	Status         string         `json:"status"`
	Metadata       map[string]any `json:"metadata"`
	Version        int            `json:"version"`
	CreatedAt      *time.Time     `json:"createdAt"`
	UpdatedAt      *time.Time     `json:"updatedAt"`
}

type PlanningSessionQuery struct {
	BizLine        contract.BizLine `form:"-"`
	ProgramID      int64            `form:"programId"`
	RequirementKey string           `form:"requirementKey"`
	ExecutorType   string           `form:"executorType"`
}

type BindPlanningSessionRequest struct {
	BizLine        contract.BizLine `json:"-"`
	ProgramID      int64            `json:"programId"`
	RequirementKey string           `json:"requirementKey"`
	ExecutorType   string           `json:"executorType"`
	ThreadID       string           `json:"threadId"`
	Title          string           `json:"title"`
	Status         string           `json:"status"`
	Metadata       map[string]any   `json:"metadata"`
	ActorID        string           `json:"-"`
	ActorName      string           `json:"actorName"`
}
