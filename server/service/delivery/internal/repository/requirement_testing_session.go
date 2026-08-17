// 需求总体测试会话目录表的读写。

package repository

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"
)

func (r *DeliveryRepository) ListRequirementTestingSessions(
	ctx context.Context, bizLine string, programID int64, requirementKey, executorType string,
) ([]*DeliveryRequirementTestingSession, error) {
	tx := r.Db.WithContext(ctx).Model(&DeliveryRequirementTestingSession{}).
		Where("biz_line = ? AND program_id = ? AND requirement_key = ?", bizLine, programID, requirementKey)
	if executorType != "" {
		tx = tx.Where("executor_type = ?", executorType)
	}
	var rows []*DeliveryRequirementTestingSession
	err := tx.Order("id asc").Find(&rows).Error
	return rows, err
}

func (r *DeliveryRepository) FindRequirementTestingSession(
	ctx context.Context, bizLine string, programID int64, requirementKey, executorType, threadID string,
) (*DeliveryRequirementTestingSession, error) {
	var row DeliveryRequirementTestingSession
	err := r.Db.WithContext(ctx).Model(&DeliveryRequirementTestingSession{}).
		Where("biz_line = ? AND program_id = ? AND requirement_key = ? AND executor_type = ? AND thread_id = ?",
			bizLine, programID, requirementKey, executorType, threadID).
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *DeliveryRepository) UpsertRequirementTestingSession(ctx context.Context, row *DeliveryRequirementTestingSession) error {
	var existing DeliveryRequirementTestingSession
	err := r.Db.WithContext(ctx).Model(&DeliveryRequirementTestingSession{}).
		Where("biz_line = ? AND program_id = ? AND requirement_key = ? AND executor_type = ? AND thread_id = ?",
			row.BizLine, row.ProgramID, row.RequirementKey, row.ExecutorType, row.ThreadID).
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
	return r.Db.WithContext(ctx).Model(&DeliveryRequirementTestingSession{}).Where("id = ?", existing.Id).
		Updates(map[string]any{
			"title": row.Title, "status": row.Status, "metadata_json": row.MetadataJSON,
			"updated_by": row.UpdatedBy, "version": gorm.Expr("version + 1"), "updated_time": now,
		}).Error
}

func (r *DeliveryRepository) DeleteRequirementTestingSessions(ctx context.Context, bizLine string, programID int64, requirementKey string) error {
	return r.Db.WithContext(ctx).Where("biz_line = ? AND program_id = ? AND requirement_key = ?", bizLine, programID, requirementKey).
		Delete(&DeliveryRequirementTestingSession{}).Error
}
