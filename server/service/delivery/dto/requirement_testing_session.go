// 需求总体测试会话：会话目录与报告元数据，正文仍由执行器线程持有。

package dto

import (
	"time"

	"contract"
)

type RequirementTestingSessionView struct {
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

type RequirementTestingSessionQuery struct {
	BizLine        contract.BizLine `form:"-"`
	ProgramID      int64            `form:"programId"`
	RequirementKey string           `form:"requirementKey"`
	ExecutorType   string           `form:"executorType"`
}

type BindRequirementTestingSessionRequest struct {
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
