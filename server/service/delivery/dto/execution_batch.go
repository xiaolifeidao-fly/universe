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
	// Redo 表示这是一次「再做一次」：已完成的任务也允许重新进入批次，
	// 任务状态不回滚，只是再开一轮执行实例。
	Redo      bool   `json:"redo"`
	ActorID   string `json:"-"`
	ActorName string `json:"actorName"`
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

// CancelExecutionBatchRequest 强制关闭仍在运行的执行批次。
// BatchID 为空表示关闭该项目下全部运行中的批次：本地桥接可能因为断网、重启或进程被杀
// 已经丢失批次上下文，这时只能按项目整体收口，否则批次里的任务会被永久锁住。
type CancelExecutionBatchRequest struct {
	BizLine   contract.BizLine `json:"-"`
	ProgramID int64            `json:"programId"`
	BatchID   string           `json:"batchId"`
	Reason    string           `json:"reason"`
	ActorID   string           `json:"-"`
	ActorName string           `json:"actorName"`
}

// ExecutionBatchHeartbeatRequest 是执行端的「我还活着」上报。心跳停掉的批次会被服务端判死收尾，
// 否则断网或进程退出之后，批次里的任务再也没法启动。
type ExecutionBatchHeartbeatRequest struct {
	BizLine   contract.BizLine `json:"-"`
	ProgramID int64            `json:"programId"`
	BatchIDs  []string         `json:"batchIds"`
	ActorID   string           `json:"-"`
	ActorName string           `json:"actorName"`
}

type ExecutionBatchNotificationQuery struct {
	BizLine   contract.BizLine `form:"-"`
	ProgramID int64            `form:"programId"`
	ActorID   string           `form:"-"`
}

// RequirementProgressQuery 查询一条需求当前的完整任务推进情况。
type RequirementProgressQuery struct {
	BizLine        contract.BizLine `form:"-"`
	ProgramID      int64            `form:"programId"`
	RequirementKey string           `form:"requirementKey"`
}

// RequirementProgressView 同时返回任务图和执行批次。任务是完整计划，批次只说明当前或历史运行上下文。
type RequirementProgressView struct {
	RequirementKey  string         `json:"requirementKey"`
	RequirementName string         `json:"requirementName"`
	TotalCount      int            `json:"totalCount"`
	CountedCount    int            `json:"countedCount"`
	Progress        float64        `json:"progress"`
	StatusCounts    map[string]int `json:"statusCounts"`
	// TotalRunDurationMs 是这条需求下全部任务的执行耗时之和（毫秒），
	// RunCount 是它们已结束的执行轮次总数。
	TotalRunDurationMs int64                `json:"totalRunDurationMs"`
	RunCount           int                  `json:"runCount"`
	Items              []ItemView           `json:"items"`
	Batches            []ExecutionBatchView `json:"batches"`
	// PlanningBatches 是这条需求拆解过几批任务；任务用 planningBatchKey 归到某一批。
	PlanningBatches []PlanningBatchView `json:"planningBatches"`
}

type MarkExecutionBatchNotificationReadRequest struct {
	BizLine   contract.BizLine `json:"-"`
	ProgramID int64            `json:"programId"`
	BatchID   string           `json:"batchId"`
	ActorID   string           `json:"-"`
}
