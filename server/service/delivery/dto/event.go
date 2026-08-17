// 任务流水相关的查询与视图。

package dto

import (
	"time"

	"contract"
)

// ---------- 流水 ----------

type EventQuery struct {
	Page
	BizLine   contract.BizLine `form:"-"`
	ProgramID int64            `form:"programId"`
	ItemKey   string           `form:"itemKey"`
}

type EventView struct {
	ItemKey   string    `json:"itemKey"`
	Kind      string    `json:"kind"`
	Field     string    `json:"field"`
	FromValue string    `json:"fromValue"`
	ToValue   string    `json:"toValue"`
	Comment   string    `json:"comment"`
	ActorID   string    `json:"actorId"`
	ActorName string    `json:"actorName"`
	CreatedAt time.Time `json:"createdAt"`
}

type EventPage struct {
	Total int64       `json:"total"`
	Data  []EventView `json:"data"`
}

// RequirementTimelineQuery 查询一条需求的完整时间线；它同时包含需求本身和关联任务的事件。
type RequirementTimelineQuery struct {
	Page
	BizLine        contract.BizLine `form:"-"`
	ProgramID      int64            `form:"programId"`
	RequirementKey string           `form:"requirementKey"`
}

// RequirementTimelineEventView 在统一的时间线里显式标识事件来源，避免把任务变动误认为需求编辑。
type RequirementTimelineEventView struct {
	Source    string    `json:"source"` // requirement / item
	ItemKey   string    `json:"itemKey"`
	Kind      string    `json:"kind"`
	Field     string    `json:"field"`
	FromValue string    `json:"fromValue"`
	ToValue   string    `json:"toValue"`
	Comment   string    `json:"comment"`
	ActorID   string    `json:"actorId"`
	ActorName string    `json:"actorName"`
	CreatedAt time.Time `json:"createdAt"`
}

type RequirementTimelinePage struct {
	Total int64                          `json:"total"`
	Data  []RequirementTimelineEventView `json:"data"`
}
