// 模块表的读写。

package repository

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"
)

// ---------- 模块 ----------

func (r *DeliveryRepository) ListModules(ctx context.Context, bizLine string, programID int64) ([]*DeliveryModule, error) {
	var rows []*DeliveryModule
	err := r.Db.WithContext(ctx).Model(&DeliveryModule{}).
		Where("biz_line = ? AND program_id = ?", bizLine, programID).
		Order("seq asc").Find(&rows).Error
	return rows, err
}

func (r *DeliveryRepository) ListModulesPage(ctx context.Context, bizLine string, programID int64, offset, limit int) ([]*DeliveryModule, int64, error) {
	tx := r.Db.WithContext(ctx).Model(&DeliveryModule{}).
		Where("biz_line = ?", bizLine).
		Where("program_id = ?", programID)

	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []*DeliveryModule
	err := tx.Offset(offset).Limit(limit).Order("seq asc, id asc").Find(&rows).Error
	return rows, total, err
}

func (r *DeliveryRepository) UpsertModule(ctx context.Context, row *DeliveryModule) error {
	var existing DeliveryModule
	err := r.Db.WithContext(ctx).Model(&DeliveryModule{}).
		Where("biz_line = ? AND program_id = ? AND module_key = ?", row.BizLine, row.ProgramID, row.ModuleKey).
		First(&existing).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		row.CreatedTime = time.Now()
		row.UpdatedTime = row.CreatedTime
		return r.Db.WithContext(ctx).Create(row).Error
	}
	if err != nil {
		return err
	}
	return r.Db.WithContext(ctx).Model(&DeliveryModule{}).Where("id = ?", existing.Id).
		Updates(map[string]any{
			"seq":          row.Seq,
			"name":         row.Name,
			"weight":       row.Weight,
			"kind":         row.Kind,
			"updated_time": time.Now(),
		}).Error
}

func (r *DeliveryRepository) CountItemsByModule(ctx context.Context, bizLine string, programID int64, moduleKey string) (int64, error) {
	var total int64
	err := r.Db.WithContext(ctx).Model(&DeliveryItem{}).
		Where("biz_line = ?", bizLine).
		Where("program_id = ?", programID).
		Where("module_key = ?", moduleKey).
		Count(&total).Error
	return total, err
}

func (r *DeliveryRepository) ListModuleItemCounts(ctx context.Context, bizLine string, programID int64) (map[string]int64, error) {
	type countRow struct {
		ModuleKey string `gorm:"column:module_key"`
		Total     int64  `gorm:"column:total"`
	}
	var rows []countRow
	err := r.Db.WithContext(ctx).Model(&DeliveryItem{}).
		Select("module_key, COUNT(*) AS total").
		Where("biz_line = ? AND program_id = ?", bizLine, programID).
		Group("module_key").Find(&rows).Error
	if err != nil {
		return nil, err
	}
	counts := make(map[string]int64, len(rows))
	for _, row := range rows {
		counts[row.ModuleKey] = row.Total
	}
	return counts, nil
}

func (r *DeliveryRepository) FindModule(ctx context.Context, bizLine string, programID int64, moduleKey string) (*DeliveryModule, error) {
	var row DeliveryModule
	err := r.Db.WithContext(ctx).Model(&DeliveryModule{}).
		Where("biz_line = ? AND program_id = ? AND module_key = ?", bizLine, programID, moduleKey).
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// MoveItemsToModule is only used by the module deletion workflow. It leaves
// requirement_document_path intact: the workspace file belongs to the task,
// while module_key only controls its current board grouping.
func (r *DeliveryRepository) MoveItemsToModule(ctx context.Context, bizLine string, programID int64, sourceModuleKey, targetModuleKey string) (int64, error) {
	tx := r.Db.WithContext(ctx).Model(&DeliveryItem{}).
		Where("biz_line = ? AND program_id = ? AND module_key = ?", bizLine, programID, sourceModuleKey).
		Updates(map[string]any{
			"module_key":   targetModuleKey,
			"version":      gorm.Expr("version + 1"),
			"updated_time": time.Now(),
		})
	return tx.RowsAffected, tx.Error
}

func (r *DeliveryRepository) DeleteModule(ctx context.Context, bizLine string, programID int64, moduleKey string) (int64, error) {
	tx := r.Db.WithContext(ctx).Where("biz_line = ? AND program_id = ? AND module_key = ?", bizLine, programID, moduleKey).
		Delete(&DeliveryModule{})
	return tx.RowsAffected, tx.Error
}
