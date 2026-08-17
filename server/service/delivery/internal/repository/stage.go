// 阶段表的读写。

package repository

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"
)

// ---------- 阶段 ----------

func (r *DeliveryRepository) ListStages(ctx context.Context, bizLine string, programID int64) ([]*DeliveryStage, error) {
	var rows []*DeliveryStage
	err := r.Db.WithContext(ctx).Model(&DeliveryStage{}).
		Where("biz_line = ? AND program_id = ?", bizLine, programID).
		Order("seq asc").Find(&rows).Error
	return rows, err
}

func (r *DeliveryRepository) UpsertStage(ctx context.Context, row *DeliveryStage) error {
	var existing DeliveryStage
	err := r.Db.WithContext(ctx).Model(&DeliveryStage{}).
		Where("biz_line = ? AND program_id = ? AND stage_key = ?", row.BizLine, row.ProgramID, row.StageKey).
		First(&existing).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		row.CreatedTime = time.Now()
		row.UpdatedTime = row.CreatedTime
		return r.Db.WithContext(ctx).Create(row).Error
	}
	if err != nil {
		return err
	}
	return r.Db.WithContext(ctx).Model(&DeliveryStage{}).Where("id = ?", existing.Id).
		Updates(map[string]any{
			"seq":            row.Seq,
			"tag":            row.Tag,
			"time_window":    row.TimeWindow,
			"maturity_level": row.MaturityLevel,
			"title":          row.Title,
			"updated_time":   time.Now(),
		}).Error
}

func (r *DeliveryRepository) CountItemsByStage(ctx context.Context, bizLine string, programID int64, stageKey string) (int64, error) {
	var total int64
	err := r.Db.WithContext(ctx).Model(&DeliveryItem{}).
		Where("biz_line = ?", bizLine).
		Where("program_id = ?", programID).
		Where("stage_key = ?", stageKey).
		Count(&total).Error
	return total, err
}

func (r *DeliveryRepository) DeleteStage(ctx context.Context, bizLine string, programID int64, stageKey string) (int64, error) {
	tx := r.Db.WithContext(ctx).Where("biz_line = ? AND program_id = ? AND stage_key = ?", bizLine, programID, stageKey).
		Delete(&DeliveryStage{})
	return tx.RowsAffected, tx.Error
}
