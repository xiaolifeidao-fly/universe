// Package delivery 是交付推进域：把「印尼业务全景」那份路线图从一份 JSON
// 变成可多人协作、有流水、有趋势的看板。
//
// 它不在 6 层业务 DAG 里，是**管理面**，零下游依赖 —— 看的是「这个能力建到哪一步了」，
// 而 service/task 看的是「这条催收指令下发了没有」，service/orchestration 看的是
// 「今天发了多少条、设备在不在线」。同名不同域，表前缀 zt_delivery_ 是唯一的归属判据。
//
// 两条口径在这里定死，前端不许自己再算一遍：
//  1. 进度：status=done 强制 100，status=dropped 不计入任何统计；
//  2. 成熟度：Σ(模块权重 × 模块进度) / Σ权重 —— 原型页面把权重显示出来了却没参与计算。
package delivery

import (
	"context"

	"gorm.io/gorm"

	"contract"
	"service/delivery/dto"
	"service/delivery/internal/repository"
)

// Service 交付推进看板。
type Service interface {
	// ---------- 项目 ----------
	ListPrograms(ctx context.Context, bizLine contract.BizLine) ([]dto.ProgramView, error)
	// ResolveProgramBizLine 根据全局唯一的项目标识取得项目归属；项目范围接口不信任客户端业务线。
	ResolveProgramBizLine(ctx context.Context, programID int64) (contract.BizLine, error)
	// CountPrograms 仅供业务线删除前进行关联校验，不暴露项目明细。
	CountPrograms(ctx context.Context, bizLine contract.BizLine) (int64, error)
	GetProgram(ctx context.Context, bizLine contract.BizLine, programID int64) (dto.ProgramView, error)
	SaveProgram(ctx context.Context, req dto.SaveProgramRequest) error
	MigrateProgram(ctx context.Context, req dto.MigrateProgramRequest) error

	// ---------- 阶段 / 模块 ----------
	ListStages(ctx context.Context, bizLine contract.BizLine, programID int64) ([]dto.StageView, error)
	SaveStage(ctx context.Context, req dto.SaveStageRequest) error
	DeleteStage(ctx context.Context, req dto.DeleteStageRequest) error
	ListModules(ctx context.Context, bizLine contract.BizLine, programID int64) ([]dto.ModuleView, error)
	ListModulesPage(ctx context.Context, query dto.ModuleQuery) (dto.ModulePage, error)
	SaveModule(ctx context.Context, req dto.SaveModuleRequest) error
	DeleteModule(ctx context.Context, req dto.DeleteModuleRequest) error

	// ---------- 需求 ----------
	ListRequirements(ctx context.Context, query dto.RequirementQuery) (dto.RequirementPage, error)
	GetRequirement(ctx context.Context, bizLine contract.BizLine, programID int64, requirementKey string) (dto.RequirementView, error)
	SaveRequirement(ctx context.Context, req dto.SaveRequirementRequest) (dto.RequirementView, error)
	DeleteRequirement(ctx context.Context, req dto.DeleteRequirementRequest) error
	// 拆解会话目录：桥接是本地进程，重启就没了，聊天列表只能由服务端持有。
	ListPlanningSessions(ctx context.Context, query dto.PlanningSessionQuery) ([]dto.PlanningSessionView, error)
	BindPlanningSession(ctx context.Context, req dto.BindPlanningSessionRequest) (dto.PlanningSessionView, error)
	GetRequirementPrototype(ctx context.Context, bizLine contract.BizLine, programID int64, requirementKey string) (dto.RequirementPrototypeView, error)
	SaveRequirementPrototype(ctx context.Context, req dto.SaveRequirementPrototypeRequest) (dto.RequirementPrototypeView, error)
	UpdateRequirementTesting(ctx context.Context, req dto.UpdateRequirementTestingRequest) (dto.RequirementView, error)
	ListRequirementTestingSessions(ctx context.Context, query dto.RequirementTestingSessionQuery) ([]dto.RequirementTestingSessionView, error)
	BindRequirementTestingSession(ctx context.Context, req dto.BindRequirementTestingSessionRequest) (dto.RequirementTestingSessionView, error)
	// ListRequirementTimeline 合并需求自身与其下任务的变更流水，供需求管理查看完整上下文。
	ListRequirementTimeline(ctx context.Context, query dto.RequirementTimelineQuery) (dto.RequirementTimelinePage, error)

	// ---------- 任务 ----------
	ListItems(ctx context.Context, query dto.ItemQuery) (dto.ItemPage, error)
	GetItem(ctx context.Context, bizLine contract.BizLine, programID int64, itemKey string) (dto.ItemView, error)
	CreateItem(ctx context.Context, req dto.SaveItemRequest) (dto.ItemView, error)
	PatchItem(ctx context.Context, req dto.PatchItemRequest) (dto.ItemView, error)
	AdvancePhase(ctx context.Context, req dto.AdvancePhaseRequest) ([]dto.ItemView, error)
	DeleteItem(ctx context.Context, req dto.DeleteItemRequest) error
	Comment(ctx context.Context, req dto.CommentRequest) error
	ImportItems(ctx context.Context, req dto.ImportRequest) (dto.ImportResult, error)
	ListEvents(ctx context.Context, query dto.EventQuery) (dto.EventPage, error)
	BindExecutionSession(ctx context.Context, req dto.BindExecutionSessionRequest) (dto.ExecutionSessionView, error)
	ListExecutionSessions(ctx context.Context, query dto.ExecutionSessionQuery) ([]dto.ExecutionSessionView, error)
	UpdateExecutionSessionStatus(ctx context.Context, req dto.UpdateExecutionSessionStatusRequest) (dto.ExecutionSessionView, error)
	UpdateItemTestingCases(ctx context.Context, req dto.UpdateItemTestingCasesRequest) (dto.ItemView, error)

	// ---------- 看板 / 概览 ----------
	Board(ctx context.Context, query dto.BoardQuery) (dto.BoardView, error)
	Overview(ctx context.Context, bizLine contract.BizLine, programID int64) (dto.ProgramOverview, error)

	// ---------- 快照 ----------
	RebuildSnapshot(ctx context.Context, req dto.RebuildSnapshotRequest) ([]dto.SnapshotView, error)
	ListSnapshots(ctx context.Context, query dto.SnapshotQuery) ([]dto.SnapshotView, error)
}

type service struct {
	repo *repository.DeliveryRepository
}

func New(database *gorm.DB) Service {
	repo := &repository.DeliveryRepository{}
	repo.SetDb(database)
	return &service{repo: repo}
}
