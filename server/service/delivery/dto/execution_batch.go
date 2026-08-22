// 执行批次相关的数据形状。批次把一次「批量执行 / 串行执行」作为服务端可追踪的运行单元，
// 与单条任务的执行会话互补：前者描述一组任务的整体结果，后者保留每项会话细节。
package dto

import (
	"time"

	"contract"
)

type ExecutionBatchItemView struct {
	ItemKey   string     `json:"itemKey"`
	Sequence  int        `json:"sequence"`
	Status    string     `json:"status"`
	Message   string     `json:"message"`
	UpdatedAt *time.Time `json:"updatedAt"`
}

type ExecutionBatchView struct {
	BatchID   string           `json:"batchId"`
	BizLine   contract.BizLine `json:"bizLine"`
	ProgramID int64            `json:"programId"`
	// 每个批次只归属一条需求，避免一条完成提醒跳转到多个需求时没有确定的落点。
	RequirementKey  string `json:"requirementKey"`
	RequirementName string `json:"requirementName"`
	// 运行开始时冻结需求分支，之后需求改分支也不重写这次运行记录。
	RequirementGitBranch string `json:"requirementGitBranch"`
	Mode                 string `json:"mode"`
	ExecutorType         string `json:"executorType"`
	Status               string `json:"status"`
	ItemCount            int    `json:"itemCount"`
	CompletedCount       int    `json:"completedCount"`
	BlockedCount         int    `json:"blockedCount"`
	Summary              string `json:"summary"`
	// 批次完成提醒只属于启动该批次的用户；已读态不影响其他人自己的任务关注消息。
	NotificationReadAt *time.Time               `json:"notificationReadAt"`
	StartedAt          *time.Time               `json:"startedAt"`
	FinishedAt         *time.Time               `json:"finishedAt"`
	CreatedBy          string                   `json:"createdBy"`
	CreatedByName      string                   `json:"createdByName"`
	CreatedAt          *time.Time               `json:"createdAt"`
	UpdatedAt          *time.Time               `json:"updatedAt"`
	Items              []ExecutionBatchItemView `json:"items,omitempty"`
}

type CreateExecutionBatchRequest struct {
	BizLine      contract.BizLine `json:"-"`
	ProgramID    int64            `json:"programId"`
	Mode         string           `json:"mode"`
	ExecutorType string           `json:"executorType"`
	ItemKeys     []string         `json:"itemKeys"`
	ActorID      string           `json:"-"`
	ActorName    string           `json:"actorName"`
}

type UpdateExecutionBatchItemRequest struct {
	BizLine   contract.BizLine `json:"-"`
	ProgramID int64            `json:"programId"`
	BatchID   string           `json:"batchId"`
	ItemKey   string           `json:"itemKey"`
	Status    string           `json:"status"`
	Message   string           `json:"message"`
	ActorID   string           `json:"-"`
	ActorName string           `json:"actorName"`
}

type FinalizeExecutionBatchRequest struct {
	BizLine   contract.BizLine `json:"-"`
	ProgramID int64            `json:"programId"`
	BatchID   string           `json:"batchId"`
	Status    string           `json:"status"`
	Summary   string           `json:"summary"`
	ActorID   string           `json:"-"`
	ActorName string           `json:"actorName"`
}

type ExecutionBatchNotificationQuery struct {
	BizLine   contract.BizLine `form:"-"`
	ProgramID int64            `form:"programId"`
	ActorID   string           `form:"-"`
}

type MarkExecutionBatchNotificationReadRequest struct {
	BizLine   contract.BizLine `json:"-"`
	ProgramID int64            `json:"programId"`
	BatchID   string           `json:"batchId"`
	ActorID   string           `json:"-"`
}
