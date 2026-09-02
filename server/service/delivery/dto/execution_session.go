// 任务执行会话相关的请求、查询与视图。

package dto

import (
	"encoding/json"
	"time"

	"contract"
)

// ---------- 任务执行会话 ----------

type ExecutionSessionView struct {
	ProgramID         int64          `json:"programId"`
	ItemKey           string         `json:"itemKey"`
	ExecutorType      string         `json:"executorType"`
	Phase             string         `json:"phase"`
	Progress          int            `json:"progress"`
	ExternalSessionID string         `json:"externalSessionId"`
	ExternalHostID    string         `json:"externalHostId"`
	Status            string         `json:"status"`
	Metadata          map[string]any `json:"metadata"`
	Version           int            `json:"version"`
	// 运行计时：最近一轮的起止时刻，以及最近一轮和这条会话历次运行的累计耗时（毫秒）。
	RunStartedAt       *time.Time `json:"runStartedAt"`
	RunFinishedAt      *time.Time `json:"runFinishedAt"`
	LastRunDurationMs  int64      `json:"lastRunDurationMs"`
	TotalRunDurationMs int64      `json:"totalRunDurationMs"`
	UpdatedBy          string     `json:"updatedBy"`
	UpdatedAt          *time.Time `json:"updatedAt"`
}

type ExecutionSessionQuery struct {
	BizLine      contract.BizLine `form:"-"`
	ProgramID    int64            `form:"programId"`
	ItemKey      string           `form:"itemKey"`
	ExecutorType string           `form:"executorType"`
	Phase        string           `form:"phase"`
}

type BindExecutionSessionRequest struct {
	BizLine           contract.BizLine `json:"-"`
	ProgramID         int64            `json:"programId"`
	ItemKey           string           `json:"itemKey"`
	ExecutorType      string           `json:"executorType"`
	Phase             string           `json:"phase"`
	Progress          int              `json:"progress"`
	ExternalSessionID string           `json:"externalSessionId"`
	ExternalHostID    string           `json:"externalHostId"`
	Status            string           `json:"status"`
	Metadata          map[string]any   `json:"metadata"`
	ActorID           string           `json:"-"`
	ActorName         string           `json:"actorName"`
}

type UpdateExecutionSessionStatusRequest struct {
	BizLine      contract.BizLine `json:"-"`
	ProgramID    int64            `json:"programId"`
	ItemKey      string           `json:"itemKey"`
	ExecutorType string           `json:"executorType"`
	Phase        string           `json:"phase"`
	Version      int              `json:"version"`
	Status       string           `json:"status"`
	Progress     *int             `json:"progress"`
	Metadata     json.RawMessage  `json:"metadata"`
	ActorID      string           `json:"-"`
	ActorName    string           `json:"actorName"`
}
