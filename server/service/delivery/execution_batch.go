// 服务端执行批次：把一次批量/串行启动从本地桥接内存中提升为可查询的业务记录。
package delivery

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"contract"
	"service/delivery/dto"
	"service/delivery/internal/repository"
)

func (s *service) CreateExecutionBatch(ctx context.Context, req dto.CreateExecutionBatchRequest) (dto.ExecutionBatchView, error) {
	if !req.BizLine.Valid() {
		return dto.ExecutionBatchView{}, contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 {
		return dto.ExecutionBatchView{}, errors.New("缺少项目标识")
	}
	mode, err := normalizeExecutionBatchMode(req.Mode)
	if err != nil {
		return dto.ExecutionBatchView{}, err
	}
	executorType, err := normalizeExecutorType(req.ExecutorType)
	if err != nil {
		return dto.ExecutionBatchView{}, err
	}
	itemKeys, err := normalizeExecutionBatchItemKeys(req.ItemKeys)
	if err != nil {
		return dto.ExecutionBatchView{}, err
	}

	var created *repository.DeliveryExecutionBatch
	if err := s.repo.Tx(ctx, func(tx *repository.DeliveryRepository) error {
		if err := tx.LockProgram(ctx, req.BizLine.String(), req.ProgramID); err != nil {
			return translate(err)
		}
		items, err := tx.ListAllItems(ctx, repository.ItemQuery{BizLine: req.BizLine.String(), ProgramID: req.ProgramID})
		if err != nil {
			return err
		}
		byKey := make(map[string]*repository.DeliveryItem, len(items))
		for _, item := range items {
			byKey[item.ItemKey] = item
		}
		selected := make([]*repository.DeliveryItem, 0, len(itemKeys))
		for _, itemKey := range itemKeys {
			item := byKey[itemKey]
			if item == nil {
				return fmt.Errorf("任务不存在：%s", itemKey)
			}
			// 「再做一次」允许把已完成任务重新拉起：不回滚它的状态，只是再开一轮执行实例。
			if item.Status == StatusDropped || (item.Status == StatusDone && !req.Redo) {
				return fmt.Errorf("任务 %s 不是可执行状态", itemKey)
			}
			if strings.TrimSpace(item.RequirementKey) == "" {
				return fmt.Errorf("任务 %s 未关联需求，不能创建执行批次", itemKey)
			}
			selected = append(selected, item)
		}
		requirementKey := selected[0].RequirementKey
		for _, item := range selected[1:] {
			if item.RequirementKey != requirementKey {
				return errors.New("同一执行批次只能选择同一条需求下的任务")
			}
		}
		requirement, err := tx.FindRequirement(ctx, req.BizLine.String(), req.ProgramID, requirementKey)
		if err != nil {
			return translate(err)
		}
		// 先把心跳已经停掉的批次判死收尾，再做互斥判断：
		// 断网或桥接进程没了的时候没人替它收尾，否则「再做一次」会被一条早就不存在的运行永久挡住。
		if _, err := s.releaseDeadExecutionBatches(ctx, tx, req.BizLine.String(), req.ProgramID, actorOf(req.ActorID, req.ActorName)); err != nil {
			return err
		}
		active, err := tx.FindActiveExecutionBatchItemKeys(ctx, req.BizLine.String(), req.ProgramID, itemKeys)
		if err != nil {
			return err
		}
		if len(active) > 0 {
			return fmt.Errorf("任务正在其他执行批次中：%s。若执行端已经不在运行，请在任务面板点「全部停止」后重试", strings.Join(active, "、"))
		}
		now := time.Now()
		created = &repository.DeliveryExecutionBatch{
			BizLine: req.BizLine.String(), ProgramID: req.ProgramID, BatchID: generateExecutionBatchID(),
			RequirementKey: requirement.RequirementKey, RequirementName: requirement.Name, RequirementGitBranch: requirement.GitBranch,
			Mode: mode, ExecutorType: executorType, Status: ExecutionBatchStatusRunning, ItemCount: len(itemKeys),
			StartedAt: &now, HeartbeatAt: &now, CreatedBy: req.ActorID, CreatedByName: actorOf(req.ActorID, req.ActorName), UpdatedBy: actorOf(req.ActorID, req.ActorName),
		}
		batchItems := make([]*repository.DeliveryExecutionBatchItem, 0, len(itemKeys))
		for sequence, itemKey := range itemKeys {
			batchItems = append(batchItems, &repository.DeliveryExecutionBatchItem{
				BizLine: req.BizLine.String(), ProgramID: req.ProgramID, BatchID: created.BatchID,
				ItemKey: itemKey, Sequence: sequence + 1, Status: ExecutionBatchItemPending,
			})
		}
		return tx.CreateExecutionBatch(ctx, created, batchItems)
	}); err != nil {
		return dto.ExecutionBatchView{}, err
	}
	return toExecutionBatchView(created, nil), nil
}

func (s *service) UpdateExecutionBatchItem(ctx context.Context, req dto.UpdateExecutionBatchItemRequest) (dto.ExecutionBatchView, error) {
	if !req.BizLine.Valid() {
		return dto.ExecutionBatchView{}, contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 || strings.TrimSpace(req.BatchID) == "" || strings.TrimSpace(req.ItemKey) == "" {
		return dto.ExecutionBatchView{}, errors.New("缺少项目、批次或任务标识")
	}
	status, err := normalizeExecutionBatchItemStatus(req.Status)
	if err != nil {
		return dto.ExecutionBatchView{}, err
	}
	message := strings.TrimSpace(req.Message)
	if len([]rune(message)) > 1024 {
		return dto.ExecutionBatchView{}, errors.New("批次任务结果说明不能超过 1024 字符")
	}
	if err := s.repo.Tx(ctx, func(tx *repository.DeliveryRepository) error {
		batch, err := tx.LockExecutionBatch(ctx, req.BizLine.String(), req.ProgramID, req.BatchID)
		if err != nil {
			return translate(err)
		}
		if batch.Status != ExecutionBatchStatusRunning {
			return errors.New("执行批次已结束，不能再更新任务状态")
		}
		item, err := tx.FindExecutionBatchItem(ctx, req.BizLine.String(), req.ProgramID, req.BatchID, req.ItemKey)
		if err != nil {
			return translate(err)
		}
		if err := validateExecutionBatchItemTransition(item.Status, status); err != nil {
			return err
		}
		_, err = tx.UpdateExecutionBatchItem(ctx, req.BizLine.String(), req.ProgramID, req.BatchID, req.ItemKey, map[string]any{
			"status": status, "message": message,
		})
		return err
	}); err != nil {
		return dto.ExecutionBatchView{}, err
	}
	return s.GetExecutionBatch(ctx, req.BizLine, req.ProgramID, req.BatchID)
}

func (s *service) FinalizeExecutionBatch(ctx context.Context, req dto.FinalizeExecutionBatchRequest) (dto.ExecutionBatchView, error) {
	if !req.BizLine.Valid() {
		return dto.ExecutionBatchView{}, contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 || strings.TrimSpace(req.BatchID) == "" {
		return dto.ExecutionBatchView{}, errors.New("缺少项目或批次标识")
	}
	status, err := normalizeExecutionBatchStatus(req.Status)
	if err != nil {
		return dto.ExecutionBatchView{}, err
	}
	if status == ExecutionBatchStatusRunning {
		return dto.ExecutionBatchView{}, errors.New("运行中的批次不能执行收尾")
	}
	summary := strings.TrimSpace(req.Summary)
	if len([]rune(summary)) > 2048 {
		return dto.ExecutionBatchView{}, errors.New("批次摘要不能超过 2048 字符")
	}
	if err := s.repo.Tx(ctx, func(tx *repository.DeliveryRepository) error {
		batch, err := tx.LockExecutionBatch(ctx, req.BizLine.String(), req.ProgramID, req.BatchID)
		if err != nil {
			return translate(err)
		}
		// 收尾请求可能由桥接重试；已经是同一终态时直接按幂等处理。
		if batch.Status != ExecutionBatchStatusRunning {
			if batch.Status == status {
				return nil
			}
			return errors.New("执行批次已按另一种结果结束")
		}
		items, err := tx.ListExecutionBatchItems(ctx, req.BizLine.String(), req.ProgramID, req.BatchID)
		if err != nil {
			return err
		}
		completedCount, blockedCount := 0, 0
		for _, item := range items {
			switch item.Status {
			case ExecutionBatchItemCompleted:
				completedCount++
			case ExecutionBatchItemBlocked:
				blockedCount++
			}
		}
		if status == ExecutionBatchStatusCompleted && completedCount != len(items) {
			return errors.New("只有批次内全部任务完成后才能标记批次完成")
		}
		if status == ExecutionBatchStatusCompleted && blockedCount > 0 {
			return errors.New("批次包含受阻任务，不能标记为完成")
		}
		now := time.Now()
		_, err = tx.UpdateExecutionBatch(ctx, req.BizLine.String(), req.ProgramID, req.BatchID, map[string]any{
			"status": status, "summary": summary, "completed_count": completedCount, "blocked_count": blockedCount,
			"finished_at": &now, "updated_by": actorOf(req.ActorID, req.ActorName),
		})
		return err
	}); err != nil {
		return dto.ExecutionBatchView{}, err
	}
	return s.GetExecutionBatch(ctx, req.BizLine, req.ProgramID, req.BatchID)
}

func (s *service) GetExecutionBatch(ctx context.Context, bizLine contract.BizLine, programID int64, batchID string) (dto.ExecutionBatchView, error) {
	if !bizLine.Valid() {
		return dto.ExecutionBatchView{}, contract.ErrBizLineRequired
	}
	if programID <= 0 || strings.TrimSpace(batchID) == "" {
		return dto.ExecutionBatchView{}, errors.New("缺少项目或批次标识")
	}
	batch, err := s.repo.FindExecutionBatch(ctx, bizLine.String(), programID, batchID)
	if err != nil {
		return dto.ExecutionBatchView{}, translate(err)
	}
	items, err := s.repo.ListExecutionBatchItems(ctx, bizLine.String(), programID, batchID)
	if err != nil {
		return dto.ExecutionBatchView{}, err
	}
	return toExecutionBatchView(batch, items), nil
}

// ExecutionBatchHeartbeatTTL 是批次心跳的容忍上限。执行侧每隔 executionBatchHeartbeatInterval
// 续一次心跳，超过这个时间还没续上就按「执行端已经不在了」处理。
// 取值要能扛住一次普通的网络抖动或桥接重启，又不能长到让用户干等。
const ExecutionBatchHeartbeatTTL = 3 * time.Minute

// closeExecutionBatch 把一条运行中的批次收口成 blocked：没跑完的任务一律记受阻，
// 批次是被强行中止的，不能假装它们完成了。调用方需自行保证已经拿到批次锁。
func closeExecutionBatch(ctx context.Context, tx *repository.DeliveryRepository, batch *repository.DeliveryExecutionBatch, reason, actor string, now time.Time) error {
	items, err := tx.ListExecutionBatchItems(ctx, batch.BizLine, batch.ProgramID, batch.BatchID)
	if err != nil {
		return err
	}
	if _, err := tx.UpdateExecutionBatchItemsByStatus(ctx, batch.BizLine, batch.ProgramID, batch.BatchID,
		[]string{ExecutionBatchItemPending, ExecutionBatchItemRunning},
		map[string]any{"status": ExecutionBatchItemBlocked, "message": reason},
	); err != nil {
		return err
	}
	completedCount := 0
	for _, item := range items {
		if item.Status == ExecutionBatchItemCompleted {
			completedCount++
		}
	}
	blockedCount := len(items) - completedCount
	if _, err := tx.UpdateExecutionBatch(ctx, batch.BizLine, batch.ProgramID, batch.BatchID, map[string]any{
		"status": ExecutionBatchStatusBlocked, "summary": reason,
		"completed_count": completedCount, "blocked_count": blockedCount,
		"finished_at": &now, "updated_by": actor,
	}); err != nil {
		return err
	}
	batch.Status = ExecutionBatchStatusBlocked
	batch.Summary = reason
	batch.CompletedCount = completedCount
	batch.BlockedCount = blockedCount
	batch.FinishedAt = &now
	return nil
}

// executionBatchIsDead 判断批次的执行侧是否已经不在了：心跳过期即视为死亡。
// 老数据没有心跳字段，退回用启动时间判断，避免升级前留下的批次永远挡着任务。
func executionBatchIsDead(batch *repository.DeliveryExecutionBatch, now time.Time) bool {
	beat := batch.HeartbeatAt
	if beat == nil {
		beat = batch.StartedAt
	}
	if beat == nil {
		beat = &batch.CreatedTime
	}
	return now.Sub(*beat) > ExecutionBatchHeartbeatTTL
}

// releaseDeadExecutionBatches 收尾所有心跳已停的批次，返回被判死的批次。调用方需在事务里先锁住项目。
func (s *service) releaseDeadExecutionBatches(ctx context.Context, tx *repository.DeliveryRepository, bizLine string, programID int64, actor string) ([]*repository.DeliveryExecutionBatch, error) {
	batches, err := tx.ListRunningExecutionBatches(ctx, bizLine, programID, "")
	if err != nil {
		return nil, err
	}
	now := time.Now()
	released := make([]*repository.DeliveryExecutionBatch, 0, len(batches))
	for _, batch := range batches {
		if !executionBatchIsDead(batch, now) {
			continue
		}
		if err := closeExecutionBatch(ctx, tx, batch, "执行端心跳已停止（断网或执行进程退出），批次被自动收尾。", actor, now); err != nil {
			return nil, err
		}
		released = append(released, batch)
	}
	return released, nil
}

// CancelExecutionBatches 强制关闭仍在运行的批次。任务面板的「全部停止」必须能兜住桥接侧的任何状态：
// 断网、进程重启或线程已经退出时，本地内存里早就没有这个批次了，只有服务端还留着 running，
// 任务会被永久锁在批次里。这里按项目（或指定批次）把 running 一次性收口成 blocked。
func (s *service) CancelExecutionBatches(ctx context.Context, req dto.CancelExecutionBatchRequest) ([]dto.ExecutionBatchView, error) {
	if !req.BizLine.Valid() {
		return nil, contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 {
		return nil, errors.New("缺少项目标识")
	}
	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		reason = "用户在任务面板停止了执行，批次被强制关闭。"
	}
	// 摘要与批次任务说明共用这段文案，按较小的那一列（message varchar(1024)）限长。
	if len([]rune(reason)) > 1024 {
		return nil, errors.New("停止原因不能超过 1024 字符")
	}
	batchID := strings.TrimSpace(req.BatchID)
	var cancelled []*repository.DeliveryExecutionBatch
	if err := s.repo.Tx(ctx, func(tx *repository.DeliveryRepository) error {
		if err := tx.LockProgram(ctx, req.BizLine.String(), req.ProgramID); err != nil {
			return translate(err)
		}
		batches, err := tx.ListRunningExecutionBatches(ctx, req.BizLine.String(), req.ProgramID, batchID)
		if err != nil {
			return err
		}
		now := time.Now()
		for _, batch := range batches {
			if err := closeExecutionBatch(ctx, tx, batch, reason, actorOf(req.ActorID, req.ActorName), now); err != nil {
				return err
			}
			cancelled = append(cancelled, batch)
		}
		return nil
	}); err != nil {
		return nil, err
	}
	views := make([]dto.ExecutionBatchView, 0, len(cancelled))
	for _, row := range cancelled {
		views = append(views, toExecutionBatchView(row, nil))
	}
	return views, nil
}

// HeartbeatExecutionBatches 由本地执行端定期上报「我还在跑这些批次」，返回服务端认可仍在运行的批次号。
// 上报不在运行中的批次不算错误：执行端可能刚被停止，让它按返回值收敛即可。
func (s *service) HeartbeatExecutionBatches(ctx context.Context, req dto.ExecutionBatchHeartbeatRequest) ([]string, error) {
	if !req.BizLine.Valid() {
		return nil, contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 {
		return nil, errors.New("缺少项目标识")
	}
	batchIDs := make([]string, 0, len(req.BatchIDs))
	for _, batchID := range req.BatchIDs {
		if trimmed := strings.TrimSpace(batchID); trimmed != "" {
			batchIDs = append(batchIDs, trimmed)
		}
	}
	if len(batchIDs) == 0 {
		return []string{}, nil
	}
	if _, err := s.repo.TouchExecutionBatchHeartbeats(ctx, req.BizLine.String(), req.ProgramID, batchIDs); err != nil {
		return nil, err
	}
	return s.repo.FilterRunningExecutionBatchIDs(ctx, req.BizLine.String(), req.ProgramID, batchIDs)
}

func (s *service) ListExecutionBatchNotifications(ctx context.Context, query dto.ExecutionBatchNotificationQuery) ([]dto.ExecutionBatchView, error) {
	if !query.BizLine.Valid() {
		return nil, contract.ErrBizLineRequired
	}
	if query.ProgramID <= 0 {
		return nil, errors.New("缺少项目标识")
	}
	rows, err := s.repo.ListExecutionBatches(ctx, query.BizLine.String(), query.ProgramID, query.ActorID)
	if err != nil {
		return nil, err
	}
	views := make([]dto.ExecutionBatchView, 0, len(rows))
	for _, row := range rows {
		views = append(views, toExecutionBatchView(row, nil))
	}
	return views, nil
}

func (s *service) MarkExecutionBatchNotificationRead(ctx context.Context, req dto.MarkExecutionBatchNotificationReadRequest) (dto.ExecutionBatchView, error) {
	if !req.BizLine.Valid() {
		return dto.ExecutionBatchView{}, contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 || strings.TrimSpace(req.BatchID) == "" {
		return dto.ExecutionBatchView{}, errors.New("缺少项目或批次标识")
	}
	batch, err := s.repo.FindExecutionBatch(ctx, req.BizLine.String(), req.ProgramID, req.BatchID)
	if err != nil {
		return dto.ExecutionBatchView{}, translate(err)
	}
	if batch.CreatedBy != req.ActorID {
		return dto.ExecutionBatchView{}, errors.New("无权确认该批次提醒")
	}
	if batch.Status != ExecutionBatchStatusCompleted {
		return dto.ExecutionBatchView{}, errors.New("只有完成批次才有提醒")
	}
	if batch.NotificationReadAt == nil {
		now := time.Now()
		if _, err := s.repo.UpdateExecutionBatch(ctx, req.BizLine.String(), req.ProgramID, req.BatchID, map[string]any{"notification_read_at": &now}); err != nil {
			return dto.ExecutionBatchView{}, err
		}
	}
	return s.GetExecutionBatch(ctx, req.BizLine, req.ProgramID, req.BatchID)
}

func normalizeExecutionBatchItemKeys(values []string) ([]string, error) {
	if len(values) == 0 {
		return nil, errors.New("请至少选择一个任务")
	}
	if len(values) > 200 {
		return nil, errors.New("一次执行批次最多包含 200 个任务")
	}
	keys := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		key := strings.TrimSpace(value)
		if key == "" {
			return nil, errors.New("批次任务标识不能为空")
		}
		if _, exists := seen[key]; exists {
			return nil, fmt.Errorf("批次任务重复选择：%s", key)
		}
		seen[key] = struct{}{}
		keys = append(keys, key)
	}
	return keys, nil
}

func validateExecutionBatchItemTransition(current, next string) error {
	if current == next {
		return nil
	}
	// pending 也能直接落到终态：任务在批次启动前就已经完成会被直接记完成跳过，
	// 还没轮到就被停止或判死的任务则直接记受阻。少了这条，批次里会留下永远收不了尾的 pending。
	if current == ExecutionBatchItemPending && next != ExecutionBatchItemPending {
		return nil
	}
	if current == ExecutionBatchItemRunning && (next == ExecutionBatchItemCompleted || next == ExecutionBatchItemBlocked) {
		return nil
	}
	return fmt.Errorf("批次任务状态不能从 %s 变为 %s", current, next)
}

func toExecutionBatchView(row *repository.DeliveryExecutionBatch, items []*repository.DeliveryExecutionBatchItem) dto.ExecutionBatchView {
	created, updated := row.CreatedTime, row.UpdatedTime
	view := dto.ExecutionBatchView{
		BatchID: row.BatchID, BizLine: contract.BizLine(row.BizLine), ProgramID: row.ProgramID,
		RequirementKey: row.RequirementKey, RequirementName: row.RequirementName, RequirementGitBranch: row.RequirementGitBranch,
		Mode: row.Mode, ExecutorType: row.ExecutorType, Status: row.Status, ItemCount: row.ItemCount,
		CompletedCount: row.CompletedCount, BlockedCount: row.BlockedCount, Summary: row.Summary,
		NotificationReadAt: row.NotificationReadAt, StartedAt: row.StartedAt, FinishedAt: row.FinishedAt,
		CreatedBy: row.CreatedBy, CreatedByName: row.CreatedByName, CreatedAt: &created, UpdatedAt: &updated,
	}
	if items == nil {
		return view
	}
	view.Items = make([]dto.ExecutionBatchItemView, 0, len(items))
	for _, item := range items {
		updatedAt := item.UpdatedTime
		view.Items = append(view.Items, dto.ExecutionBatchItemView{
			ItemKey: item.ItemKey, Sequence: item.Sequence, Status: item.Status, Message: item.Message, UpdatedAt: &updatedAt,
		})
	}
	return view
}
