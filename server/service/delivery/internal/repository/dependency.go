// 任务依赖表的读写。

package repository

import (
	"context"
	"time"
)

// ---------- 任务依赖 ----------

func (r *DeliveryRepository) ListItemDependencies(ctx context.Context, bizLine string, programID int64) ([]*DeliveryItemDependency, error) {
	var rows []*DeliveryItemDependency
	err := r.Db.WithContext(ctx).Model(&DeliveryItemDependency{}).
		Where("biz_line = ? AND program_id = ?", bizLine, programID).
		Order("id asc").Find(&rows).Error
	return rows, err
}

// ReplaceItemDependencies 替换一条任务的全部前置任务。调用方负责事务与环检测。
func (r *DeliveryRepository) ReplaceItemDependencies(
	ctx context.Context,
	bizLine string, programID int64, successorItemKey string,
	predecessorItemKeys []string,
	sourceSides map[string]string,
	targetSides map[string]string,
	createdBy string,
) error {
	if err := r.Db.WithContext(ctx).
		Where("biz_line = ? AND program_id = ? AND successor_item_key = ?", bizLine, programID, successorItemKey).
		Delete(&DeliveryItemDependency{}).Error; err != nil {
		return err
	}
	if len(predecessorItemKeys) == 0 {
		return nil
	}
	now := time.Now()
	rows := make([]*DeliveryItemDependency, 0, len(predecessorItemKeys))
	for _, predecessorItemKey := range predecessorItemKeys {
		rows = append(rows, &DeliveryItemDependency{
			BizLine:            bizLine,
			ProgramID:          programID,
			PredecessorItemKey: predecessorItemKey,
			SuccessorItemKey:   successorItemKey,
			SourceSide:         sourceSides[predecessorItemKey],
			TargetSide:         targetSides[predecessorItemKey],
			CreatedBy:          createdBy,
			CreatedTime:        now,
		})
	}
	return r.Db.WithContext(ctx).Create(rows).Error
}

func (r *DeliveryRepository) DeleteItemDependencies(ctx context.Context, bizLine string, programID int64, itemKey string) error {
	return r.Db.WithContext(ctx).
		Where("biz_line = ? AND program_id = ?", bizLine, programID).
		Where("predecessor_item_key = ? OR successor_item_key = ?", itemKey, itemKey).
		Delete(&DeliveryItemDependency{}).Error
}
