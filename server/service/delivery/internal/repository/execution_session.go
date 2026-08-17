// 任务执行会话表的读写。

package repository

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"
)

// ---------- 任务执行会话 ----------

func (r *DeliveryRepository) ListItemExecutionSessions(
	ctx context.Context,
	bizLine string, programID int64, itemKey, executorType, phase string,
) ([]*DeliveryItemExecutionSession, error) {
	tx := r.Db.WithContext(ctx).Model(&DeliveryItemExecutionSession{}).
		Where("biz_line = ? AND program_id = ? AND item_key = ?", bizLine, programID, itemKey)
	if executorType != "" {
		tx = tx.Where("executor_type = ?", executorType)
	}
	if phase != "" {
		tx = tx.Where("phase = ?", phase)
	}
	var rows []*DeliveryItemExecutionSession
	err := tx.Order("id asc").Find(&rows).Error
	return rows, err
}

func (r *DeliveryRepository) FindItemExecutionSession(
	ctx context.Context,
	bizLine string, programID int64, itemKey, executorType, phase string,
) (*DeliveryItemExecutionSession, error) {
	var row DeliveryItemExecutionSession
	err := r.Db.WithContext(ctx).Model(&DeliveryItemExecutionSession{}).
		Where("biz_line = ? AND program_id = ? AND item_key = ? AND executor_type = ? AND phase = ?",
			bizLine, programID, itemKey, executorType, phase).
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *DeliveryRepository) FindExecutionSessionByExternalID(
	ctx context.Context,
	bizLine, executorType, externalSessionID string,
) (*DeliveryItemExecutionSession, error) {
	var row DeliveryItemExecutionSession
	err := r.Db.WithContext(ctx).Model(&DeliveryItemExecutionSession{}).
		Where("biz_line = ? AND executor_type = ? AND external_session_id = ?",
			bizLine, executorType, externalSessionID).
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *DeliveryRepository) UpsertItemExecutionSession(ctx context.Context, row *DeliveryItemExecutionSession) error {
	var existing DeliveryItemExecutionSession
	err := r.Db.WithContext(ctx).Model(&DeliveryItemExecutionSession{}).
		Where("biz_line = ? AND program_id = ? AND item_key = ? AND executor_type = ? AND phase = ?",
			row.BizLine, row.ProgramID, row.ItemKey, row.ExecutorType, row.Phase).
		First(&existing).Error
	now := time.Now()
	if errors.Is(err, gorm.ErrRecordNotFound) {
		row.Version = 1
		row.CreatedTime = now
		row.UpdatedTime = now
		return r.Db.WithContext(ctx).Create(row).Error
	}
	if err != nil {
		return err
	}
	return r.Db.WithContext(ctx).Model(&DeliveryItemExecutionSession{}).Where("id = ?", existing.Id).
		Updates(map[string]any{
			"external_session_id": row.ExternalSessionID,
			"external_host_id":    row.ExternalHostID,
			"status":              row.Status,
			"progress":            row.Progress,
			"metadata_json":       row.MetadataJSON,
			"updated_by":          row.UpdatedBy,
			"version":             gorm.Expr("version + 1"),
			"updated_time":        now,
		}).Error
}

func (r *DeliveryRepository) UpdateItemExecutionSessionStatus(
	ctx context.Context,
	bizLine string, programID int64, itemKey, executorType, phase string,
	version int,
	values map[string]any,
) (int64, error) {
	values["version"] = gorm.Expr("version + 1")
	values["updated_time"] = time.Now()
	tx := r.Db.WithContext(ctx).Model(&DeliveryItemExecutionSession{}).
		Where("biz_line = ? AND program_id = ? AND item_key = ? AND executor_type = ? AND phase = ? AND version = ?",
			bizLine, programID, itemKey, executorType, phase, version).
		Updates(values)
	return tx.RowsAffected, tx.Error
}

func (r *DeliveryRepository) DeleteItemExecutionSessions(ctx context.Context, bizLine string, programID int64, itemKey string) error {
	return r.Db.WithContext(ctx).
		Where("biz_line = ? AND program_id = ? AND item_key = ?", bizLine, programID, itemKey).
		Delete(&DeliveryItemExecutionSession{}).Error
}
