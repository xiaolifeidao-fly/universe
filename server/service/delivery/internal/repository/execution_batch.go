// 执行批次的持久化读写。Repository 只组织查询和更新，不判断批次状态是否可流转。
package repository

import (
	"context"
	"strings"
	"time"

	"gorm.io/gorm/clause"
)

func (r *DeliveryRepository) CreateExecutionBatch(ctx context.Context, row *DeliveryExecutionBatch, items []*DeliveryExecutionBatchItem) error {
	now := time.Now()
	row.CreatedTime = now
	row.UpdatedTime = now
	if row.StartedAt == nil {
		row.StartedAt = &now
	}
	if err := r.Db.WithContext(ctx).Create(row).Error; err != nil {
		return err
	}
	if len(items) == 0 {
		return nil
	}
	for _, item := range items {
		item.CreatedTime = now
		item.UpdatedTime = now
	}
	return r.Db.WithContext(ctx).Create(&items).Error
}

func (r *DeliveryRepository) FindExecutionBatch(ctx context.Context, bizLine string, programID int64, batchID string) (*DeliveryExecutionBatch, error) {
	var row DeliveryExecutionBatch
	err := r.Db.WithContext(ctx).Model(&DeliveryExecutionBatch{}).
		Where("biz_line = ? AND program_id = ? AND batch_id = ?", bizLine, programID, batchID).
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *DeliveryRepository) LockExecutionBatch(ctx context.Context, bizLine string, programID int64, batchID string) (*DeliveryExecutionBatch, error) {
	var row DeliveryExecutionBatch
	err := r.Db.WithContext(ctx).Model(&DeliveryExecutionBatch{}).
		Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("biz_line = ? AND program_id = ? AND batch_id = ?", bizLine, programID, batchID).
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *DeliveryRepository) ListExecutionBatches(ctx context.Context, bizLine string, programID int64, createdBy string) ([]*DeliveryExecutionBatch, error) {
	var rows []*DeliveryExecutionBatch
	err := r.Db.WithContext(ctx).Model(&DeliveryExecutionBatch{}).
		Where("biz_line = ? AND program_id = ? AND created_by = ? AND status = ?", bizLine, programID, createdBy, "completed").
		Order("finished_at desc, id desc").
		Limit(50).
		Find(&rows).Error
	return rows, err
}

// ListRequirementExecutionBatches 返回需求最近的执行批次，运行中的批次始终排在最前。
// 进度总览需要看到所有启动者的批次，因此这里不按 created_by 过滤。
func (r *DeliveryRepository) ListRequirementExecutionBatches(ctx context.Context, bizLine string, programID int64, requirementKey string) ([]*DeliveryExecutionBatch, error) {
	var rows []*DeliveryExecutionBatch
	err := r.Db.WithContext(ctx).Model(&DeliveryExecutionBatch{}).
		Where("biz_line = ? AND program_id = ? AND requirement_key = ?", bizLine, programID, requirementKey).
		Order("CASE WHEN status = 'running' THEN 0 WHEN status = 'blocked' THEN 1 ELSE 2 END ASC").
		Order("started_at desc, id desc").
		Limit(50).
		Find(&rows).Error
	return rows, err
}

func (r *DeliveryRepository) ListExecutionBatchItems(ctx context.Context, bizLine string, programID int64, batchID string) ([]*DeliveryExecutionBatchItem, error) {
	var rows []*DeliveryExecutionBatchItem
	err := r.Db.WithContext(ctx).Model(&DeliveryExecutionBatchItem{}).
		Where("biz_line = ? AND program_id = ? AND batch_id = ?", bizLine, programID, batchID).
		Order("sequence asc, id asc").Find(&rows).Error
	return rows, err
}

func (r *DeliveryRepository) ListExecutionBatchItemsByBatchIDs(ctx context.Context, bizLine string, programID int64, batchIDs []string) ([]*DeliveryExecutionBatchItem, error) {
	if len(batchIDs) == 0 {
		return []*DeliveryExecutionBatchItem{}, nil
	}
	var rows []*DeliveryExecutionBatchItem
	err := r.Db.WithContext(ctx).Model(&DeliveryExecutionBatchItem{}).
		Where("biz_line = ? AND program_id = ? AND batch_id IN ?", bizLine, programID, batchIDs).
		Order("batch_id asc, sequence asc, id asc").
		Find(&rows).Error
	return rows, err
}

func (r *DeliveryRepository) FindExecutionBatchItem(ctx context.Context, bizLine string, programID int64, batchID, itemKey string) (*DeliveryExecutionBatchItem, error) {
	var row DeliveryExecutionBatchItem
	err := r.Db.WithContext(ctx).Model(&DeliveryExecutionBatchItem{}).
		Where("biz_line = ? AND program_id = ? AND batch_id = ? AND item_key = ?", bizLine, programID, batchID, itemKey).
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *DeliveryRepository) FindActiveExecutionBatchItemKeys(ctx context.Context, bizLine string, programID int64, itemKeys []string) ([]string, error) {
	if len(itemKeys) == 0 {
		return []string{}, nil
	}
	var keys []string
	err := r.Db.WithContext(ctx).Table("zt_delivery_execution_batch_item AS batch_item").
		Select("DISTINCT batch_item.item_key").
		Joins("JOIN zt_delivery_execution_batch AS batch ON batch.biz_line = batch_item.biz_line AND batch.program_id = batch_item.program_id AND batch.batch_id = batch_item.batch_id").
		Where("batch_item.biz_line = ? AND batch_item.program_id = ? AND batch_item.item_key IN ? AND batch.status = ?", bizLine, programID, itemKeys, "running").
		Order("batch_item.item_key asc").Scan(&keys).Error
	return keys, err
}

// ListRunningExecutionBatches 锁定并返回仍在运行的批次；batchID 为空表示整个项目。
// 强制收尾要在锁上做，避免和桥接自己的收尾请求并发写成两种结果。
func (r *DeliveryRepository) ListRunningExecutionBatches(ctx context.Context, bizLine string, programID int64, batchID string) ([]*DeliveryExecutionBatch, error) {
	query := r.Db.WithContext(ctx).Model(&DeliveryExecutionBatch{}).
		Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("biz_line = ? AND program_id = ? AND status = ?", bizLine, programID, "running")
	if strings.TrimSpace(batchID) != "" {
		query = query.Where("batch_id = ?", batchID)
	}
	var rows []*DeliveryExecutionBatch
	err := query.Order("id asc").Find(&rows).Error
	return rows, err
}

// TouchExecutionBatchHeartbeats 续上执行端心跳，只认还在运行的批次。
func (r *DeliveryRepository) TouchExecutionBatchHeartbeats(ctx context.Context, bizLine string, programID int64, batchIDs []string) (int64, error) {
	if len(batchIDs) == 0 {
		return 0, nil
	}
	now := time.Now()
	tx := r.Db.WithContext(ctx).Model(&DeliveryExecutionBatch{}).
		Where("biz_line = ? AND program_id = ? AND batch_id IN ? AND status = ?", bizLine, programID, batchIDs, "running").
		Updates(map[string]any{"heartbeat_at": &now, "updated_time": now})
	return tx.RowsAffected, tx.Error
}

// FilterRunningExecutionBatchIDs 从一组批次号里挑出服务端仍认为在运行的，执行端据此收敛自己的队列。
func (r *DeliveryRepository) FilterRunningExecutionBatchIDs(ctx context.Context, bizLine string, programID int64, batchIDs []string) ([]string, error) {
	if len(batchIDs) == 0 {
		return []string{}, nil
	}
	running := make([]string, 0, len(batchIDs))
	err := r.Db.WithContext(ctx).Model(&DeliveryExecutionBatch{}).
		Where("biz_line = ? AND program_id = ? AND batch_id IN ? AND status = ?", bizLine, programID, batchIDs, "running").
		Order("id asc").
		Pluck("batch_id", &running).Error
	return running, err
}

// UpdateExecutionBatchItemsByStatus 批量改写批次内处于指定状态的任务，用于强制收尾时一次性收口未完成项。
func (r *DeliveryRepository) UpdateExecutionBatchItemsByStatus(ctx context.Context, bizLine string, programID int64, batchID string, fromStatuses []string, values map[string]any) (int64, error) {
	if len(fromStatuses) == 0 {
		return 0, nil
	}
	values["updated_time"] = time.Now()
	tx := r.Db.WithContext(ctx).Model(&DeliveryExecutionBatchItem{}).
		Where("biz_line = ? AND program_id = ? AND batch_id = ? AND status IN ?", bizLine, programID, batchID, fromStatuses).
		Updates(values)
	return tx.RowsAffected, tx.Error
}

func (r *DeliveryRepository) UpdateExecutionBatchItem(ctx context.Context, bizLine string, programID int64, batchID, itemKey string, values map[string]any) (int64, error) {
	values["updated_time"] = time.Now()
	tx := r.Db.WithContext(ctx).Model(&DeliveryExecutionBatchItem{}).
		Where("biz_line = ? AND program_id = ? AND batch_id = ? AND item_key = ?", bizLine, programID, batchID, itemKey).
		Updates(values)
	return tx.RowsAffected, tx.Error
}

func (r *DeliveryRepository) UpdateExecutionBatch(ctx context.Context, bizLine string, programID int64, batchID string, values map[string]any) (int64, error) {
	values["updated_time"] = time.Now()
	tx := r.Db.WithContext(ctx).Model(&DeliveryExecutionBatch{}).
		Where("biz_line = ? AND program_id = ? AND batch_id = ?", bizLine, programID, batchID).
		Updates(values)
	return tx.RowsAffected, tx.Error
}
