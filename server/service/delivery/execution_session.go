// 执行会话：任务维度的执行器运行实例，按 执行器类型 + 阶段 唯一。

package delivery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"gorm.io/gorm"

	"contract"
	"service/delivery/dto"
	"service/delivery/internal/repository"
)

func (s *service) BindExecutionSession(ctx context.Context, req dto.BindExecutionSessionRequest) (dto.ExecutionSessionView, error) {
	if !req.BizLine.Valid() {
		return dto.ExecutionSessionView{}, contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 || req.ItemKey == "" {
		return dto.ExecutionSessionView{}, errors.New("缺少项目或任务标识")
	}
	executorType, err := normalizeExecutorType(req.ExecutorType)
	if err != nil {
		return dto.ExecutionSessionView{}, err
	}
	phase, err := normalizePhase(req.Phase)
	if err != nil {
		return dto.ExecutionSessionView{}, err
	}
	progress := normalizeProgress("", req.Progress)
	externalSessionID := strings.TrimSpace(req.ExternalSessionID)
	if externalSessionID == "" || len(externalSessionID) > 255 {
		return dto.ExecutionSessionView{}, errors.New("外部会话标识不能为空且不能超过 255 字符")
	}
	if len(req.ExternalHostID) > 255 {
		return dto.ExecutionSessionView{}, errors.New("外部运行节点标识不能超过 255 字符")
	}
	status, err := normalizeExecutionSessionStatus(req.Status, "pending")
	if err != nil {
		return dto.ExecutionSessionView{}, err
	}
	metadataJSON, err := marshalExecutionMetadata(req.Metadata)
	if err != nil {
		return dto.ExecutionSessionView{}, err
	}
	item, err := s.repo.FindItem(ctx, req.BizLine.String(), req.ProgramID, req.ItemKey)
	if err != nil {
		return dto.ExecutionSessionView{}, translate(err)
	}
	itemPhase := item.Phase
	if itemPhase == "" {
		itemPhase = phaseForLegacyItem(item)
	}
	if phase != itemPhase {
		return dto.ExecutionSessionView{}, errors.New("运行实例阶段必须与任务当前阶段一致")
	}
	if existing, err := s.repo.FindExecutionSessionByExternalID(ctx, req.BizLine.String(), executorType, externalSessionID); err == nil {
		if existing.ProgramID != req.ProgramID || existing.ItemKey != req.ItemKey {
			return dto.ExecutionSessionView{}, errors.New("该外部会话已绑定到其他任务")
		}
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return dto.ExecutionSessionView{}, err
	}
	// 绑定就是一轮运行的开始：这里同时算出会话行要落的计时，再把这一轮记到任务上。
	previous, err := s.repo.FindItemExecutionSession(ctx, req.BizLine.String(), req.ProgramID, req.ItemKey, executorType, phase)
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return dto.ExecutionSessionView{}, err
	}
	timing := runTimingFor(previous, status, time.Now())
	actor := actorOf(req.ActorID, req.ActorName)
	row := &repository.DeliveryItemExecutionSession{
		BizLine: req.BizLine.String(), ProgramID: req.ProgramID, ItemKey: req.ItemKey,
		ExecutorType: executorType, Phase: phase, Progress: progress, ExternalSessionID: externalSessionID,
		ExternalHostID: strings.TrimSpace(req.ExternalHostID), Status: status,
		MetadataJSON: metadataJSON, CreatedBy: actor, UpdatedBy: actor,
		RunStartedAt: timing.StartedAt, RunFinishedAt: timing.FinishedAt,
		LastRunDurationMs: timing.LastMs, TotalRunDurationMs: timing.TotalMs,
	}
	if err := s.repo.UpsertItemExecutionSession(ctx, row); err != nil {
		return dto.ExecutionSessionView{}, err
	}
	s.applyItemRunTiming(ctx, req.BizLine.String(), req.ProgramID, req.ItemKey, timing)
	updated, err := s.repo.FindItemExecutionSession(ctx, req.BizLine.String(), req.ProgramID, req.ItemKey, executorType, phase)
	if err != nil {
		return dto.ExecutionSessionView{}, translate(err)
	}
	return toExecutionSessionView(updated), nil
}

func (s *service) ListExecutionSessions(ctx context.Context, query dto.ExecutionSessionQuery) ([]dto.ExecutionSessionView, error) {
	if !query.BizLine.Valid() {
		return nil, contract.ErrBizLineRequired
	}
	if query.ProgramID <= 0 || query.ItemKey == "" {
		return nil, errors.New("缺少项目或任务标识")
	}
	executorType := ""
	if query.ExecutorType != "" {
		var err error
		executorType, err = normalizeExecutorType(query.ExecutorType)
		if err != nil {
			return nil, err
		}
	}
	phase := ""
	if query.Phase != "" {
		var err error
		phase, err = normalizePhase(query.Phase)
		if err != nil {
			return nil, err
		}
	}
	if _, err := s.repo.FindItem(ctx, query.BizLine.String(), query.ProgramID, query.ItemKey); err != nil {
		return nil, translate(err)
	}
	rows, err := s.repo.ListItemExecutionSessions(ctx, query.BizLine.String(), query.ProgramID, query.ItemKey, executorType, phase)
	if err != nil {
		return nil, err
	}
	views := make([]dto.ExecutionSessionView, 0, len(rows))
	for _, row := range rows {
		views = append(views, toExecutionSessionView(row))
	}
	return views, nil
}

func (s *service) UpdateExecutionSessionStatus(ctx context.Context, req dto.UpdateExecutionSessionStatusRequest) (dto.ExecutionSessionView, error) {
	if !req.BizLine.Valid() {
		return dto.ExecutionSessionView{}, contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 || req.ItemKey == "" {
		return dto.ExecutionSessionView{}, errors.New("缺少项目或任务标识")
	}
	if req.Version <= 0 {
		return dto.ExecutionSessionView{}, errors.New("缺少版本号，请刷新后重试")
	}
	executorType, err := normalizeExecutorType(req.ExecutorType)
	if err != nil {
		return dto.ExecutionSessionView{}, err
	}
	phase, err := normalizePhase(req.Phase)
	if err != nil {
		return dto.ExecutionSessionView{}, err
	}
	status, err := normalizeExecutionSessionStatus(req.Status, "")
	if err != nil {
		return dto.ExecutionSessionView{}, err
	}
	current, err := s.repo.FindItemExecutionSession(ctx, req.BizLine.String(), req.ProgramID, req.ItemKey, executorType, phase)
	if err != nil {
		return dto.ExecutionSessionView{}, translate(err)
	}
	if current.Version != req.Version {
		return dto.ExecutionSessionView{}, contract.ErrVersionConflict
	}
	// 收到终态就是一轮运行的结束：结算这一轮耗时，并累加到任务上。
	timing := runTimingFor(current, status, time.Now())
	values := map[string]any{
		"status":                status,
		"updated_by":            actorOf(req.ActorID, req.ActorName),
		"run_started_at":        timing.StartedAt,
		"run_finished_at":       timing.FinishedAt,
		"last_run_duration_ms":  timing.LastMs,
		"total_run_duration_ms": timing.TotalMs,
	}
	if req.Progress != nil {
		values["progress"] = normalizeProgress("", *req.Progress)
	}
	if req.Metadata != nil {
		metadataJSON, err := normalizeRawExecutionMetadata(req.Metadata)
		if err != nil {
			return dto.ExecutionSessionView{}, err
		}
		values["metadata_json"] = metadataJSON
	}
	affected, err := s.repo.UpdateItemExecutionSessionStatus(ctx, req.BizLine.String(), req.ProgramID, req.ItemKey, executorType, phase, req.Version, values)
	if err != nil {
		return dto.ExecutionSessionView{}, err
	}
	if affected == 0 {
		return dto.ExecutionSessionView{}, contract.ErrVersionConflict
	}
	s.applyItemRunTiming(ctx, req.BizLine.String(), req.ProgramID, req.ItemKey, timing)
	updated, err := s.repo.FindItemExecutionSession(ctx, req.BizLine.String(), req.ProgramID, req.ItemKey, executorType, phase)
	if err != nil {
		return dto.ExecutionSessionView{}, translate(err)
	}
	return toExecutionSessionView(updated), nil
}

// executionRunTiming 是一次会话写入要落的运行计时，外加「这次写入是不是一轮运行的边界」。
// 任务上的最近一轮和累计耗时只在边界上动，中途的进度、元数据更新不重复计时。
type executionRunTiming struct {
	StartedAt  *time.Time
	FinishedAt *time.Time
	LastMs     int64
	TotalMs    int64
	Started    bool
	Finished   bool
}

// executionSessionRunning 表示这一轮还在跑；pending 也算，它是刚建会话还没发出第一个回合。
func executionSessionRunning(status string) bool {
	return status == "pending" || status == "running"
}

// runDurationMillis 一轮运行的耗时。缺开始时刻或时钟回拨时按 0 计，绝不写负数。
func runDurationMillis(startedAt *time.Time, finishedAt time.Time) int64 {
	if startedAt == nil || startedAt.IsZero() {
		return 0
	}
	if elapsed := finishedAt.Sub(*startedAt).Milliseconds(); elapsed > 0 {
		return elapsed
	}
	return 0
}

// runTimingFor 按会话现状和这次要写入的状态，算出这一轮的开始或结算。
//
//   - 写入非终态：又开了一轮，重新起算，上一轮没收尾的时间不再补记。
//   - 写入终态且这一轮还开着：结算耗时，累计只增不减。
//   - 写入终态但这一轮已经结算过（终态重放、后台补偿重试）或压根没有开始时刻
//     （存量数据）：只补结束时刻，不重复累加。
func runTimingFor(previous *repository.DeliveryItemExecutionSession, status string, now time.Time) executionRunTiming {
	timing := executionRunTiming{}
	if previous != nil {
		timing.StartedAt = previous.RunStartedAt
		timing.FinishedAt = previous.RunFinishedAt
		timing.LastMs = previous.LastRunDurationMs
		timing.TotalMs = previous.TotalRunDurationMs
	}
	if executionSessionRunning(status) {
		started := now
		timing.StartedAt = &started
		timing.FinishedAt = nil
		timing.Started = true
		return timing
	}
	if timing.FinishedAt != nil || timing.StartedAt == nil {
		if timing.FinishedAt == nil {
			finished := now
			timing.FinishedAt = &finished
		}
		return timing
	}
	duration := runDurationMillis(timing.StartedAt, now)
	finished := now
	timing.FinishedAt = &finished
	timing.LastMs = duration
	timing.TotalMs += duration
	timing.Finished = true
	return timing
}

// applyItemRunTiming 把这一轮的边界记到任务上，任务面板的「本次 / 累计耗时」读的就是这几列。
//
// 计时是展示用的旁路数据：写失败不该让会话绑定或收尾整体失败，
// 否则执行侧会把一次成功的启动当成失败回滚掉。
func (s *service) applyItemRunTiming(
	ctx context.Context, bizLine string, programID int64, itemKey string, timing executionRunTiming,
) {
	switch {
	case timing.Started && timing.StartedAt != nil:
		_ = s.repo.StartItemRun(ctx, bizLine, programID, itemKey, *timing.StartedAt)
	case timing.Finished && timing.StartedAt != nil && timing.FinishedAt != nil:
		_ = s.repo.FinishItemRun(ctx, bizLine, programID, itemKey, *timing.StartedAt, *timing.FinishedAt, timing.LastMs)
	}
}

func normalizeExecutorType(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if !executorTypePattern.MatchString(value) {
		return "", errors.New("执行器类型只能包含小写字母、数字、下划线或连字符，且不能超过 32 字符")
	}
	return value, nil
}

func normalizeExecutionSessionStatus(value, fallback string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		value = fallback
	}
	if _, ok := executionSessionStatuses[value]; !ok {
		return "", fmt.Errorf("未知的执行会话状态：%s", value)
	}
	return value, nil
}

func marshalExecutionMetadata(value map[string]any) (string, error) {
	if value == nil {
		value = map[string]any{}
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return "", errors.New("执行会话 metadata 不是有效 JSON")
	}
	if len(raw) > maxExecutionMetadataBytes {
		return "", errors.New("执行会话 metadata 不能超过 8KB")
	}
	return string(raw), nil
}

func normalizeRawExecutionMetadata(raw json.RawMessage) (string, error) {
	if len(raw) > maxExecutionMetadataBytes {
		return "", errors.New("执行会话 metadata 不能超过 8KB")
	}
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil || value == nil {
		return "", errors.New("执行会话 metadata 必须是 JSON 对象")
	}
	return marshalExecutionMetadata(value)
}

func toExecutionSessionView(row *repository.DeliveryItemExecutionSession) dto.ExecutionSessionView {
	updated := row.UpdatedTime
	metadata := map[string]any{}
	if row.MetadataJSON != "" {
		_ = json.Unmarshal([]byte(row.MetadataJSON), &metadata)
	}
	return dto.ExecutionSessionView{
		ProgramID: row.ProgramID, ItemKey: row.ItemKey, ExecutorType: row.ExecutorType, Phase: row.Phase, Progress: row.Progress,
		ExternalSessionID: row.ExternalSessionID, ExternalHostID: row.ExternalHostID,
		Status: row.Status, Metadata: metadata, Version: row.Version,
		RunStartedAt: row.RunStartedAt, RunFinishedAt: row.RunFinishedAt,
		LastRunDurationMs: row.LastRunDurationMs, TotalRunDurationMs: row.TotalRunDurationMs,
		UpdatedBy: row.UpdatedBy, UpdatedAt: &updated,
	}
}
