// 需求拆解会话目录表的读写。

package repository

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"
)

// ---------- 需求拆解会话目录 ----------

func (r *DeliveryRepository) ListRequirementPlanningSessions(
	ctx context.Context,
	bizLine string, programID int64, requirementKey, executorType string,
) ([]*DeliveryRequirementPlanningSession, error) {
	tx := r.Db.WithContext(ctx).Model(&DeliveryRequirementPlanningSession{}).
		Where("biz_line = ? AND program_id = ? AND requirement_key = ?", bizLine, programID, requirementKey)
	if executorType != "" {
		tx = tx.Where("executor_type = ?", executorType)
	}
	var rows []*DeliveryRequirementPlanningSession
	err := tx.Order("id asc").Find(&rows).Error
	return rows, err
}

func (r *DeliveryRepository) FindRequirementPlanningSession(
	ctx context.Context,
	bizLine string, programID int64, requirementKey, executorType, threadID string,
) (*DeliveryRequirementPlanningSession, error) {
	var row DeliveryRequirementPlanningSession
	err := r.Db.WithContext(ctx).Model(&DeliveryRequirementPlanningSession{}).
		Where("biz_line = ? AND program_id = ? AND requirement_key = ? AND executor_type = ? AND thread_id = ?",
			bizLine, programID, requirementKey, executorType, threadID).
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// UpsertRequirementPlanningSession 一条 thread 一行：新开会话插入，续聊只更新标题、状态与上下文。
func (r *DeliveryRepository) UpsertRequirementPlanningSession(ctx context.Context, row *DeliveryRequirementPlanningSession) error {
	var existing DeliveryRequirementPlanningSession
	err := r.Db.WithContext(ctx).Model(&DeliveryRequirementPlanningSession{}).
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
	return r.Db.WithContext(ctx).Model(&DeliveryRequirementPlanningSession{}).Where("id = ?", existing.Id).
		Updates(map[string]any{
			"title":         row.Title,
			"status":        row.Status,
			"metadata_json": row.MetadataJSON,
			"updated_by":    row.UpdatedBy,
			"version":       gorm.Expr("version + 1"),
			"updated_time":  now,
		}).Error
}

func (r *DeliveryRepository) DeleteRequirementPlanningSessions(ctx context.Context, bizLine string, programID int64, requirementKey string) error {
	return r.Db.WithContext(ctx).
		Where("biz_line = ? AND program_id = ? AND requirement_key = ?", bizLine, programID, requirementKey).
		Delete(&DeliveryRequirementPlanningSession{}).Error
}
