// 需求拆解批次表的读写。批次是「一次拆解写入的一批任务」，任务侧只留一个弱引用键。

package repository

import (
	"context"
)

// ---------- 需求拆解批次 ----------

func (r *DeliveryRepository) ListRequirementPlanningBatches(
	ctx context.Context,
	bizLine string, programID int64, requirementKey string,
) ([]*DeliveryRequirementPlanningBatch, error) {
	tx := r.Db.WithContext(ctx).Model(&DeliveryRequirementPlanningBatch{}).
		Where("biz_line = ? AND program_id = ?", bizLine, programID)
	if requirementKey != "" {
		tx = tx.Where("requirement_key = ?", requirementKey)
	}
	var rows []*DeliveryRequirementPlanningBatch
	err := tx.Order("seq asc, id asc").Find(&rows).Error
	return rows, err
}

func (r *DeliveryRepository) FindRequirementPlanningBatch(
	ctx context.Context,
	bizLine string, programID int64, batchKey string,
) (*DeliveryRequirementPlanningBatch, error) {
	var row DeliveryRequirementPlanningBatch
	err := r.Db.WithContext(ctx).Model(&DeliveryRequirementPlanningBatch{}).
		Where("biz_line = ? AND program_id = ? AND batch_key = ?", bizLine, programID, batchKey).
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// NextRequirementPlanningBatchSeq 取这条需求的下一个拆解序号。
// 调用方必须已经锁住项目，否则并发写入会拿到同一个序号。
func (r *DeliveryRepository) NextRequirementPlanningBatchSeq(
	ctx context.Context,
	bizLine string, programID int64, requirementKey string,
) (int, error) {
	var maxSeq *int
	err := r.Db.WithContext(ctx).Model(&DeliveryRequirementPlanningBatch{}).
		Where("biz_line = ? AND program_id = ? AND requirement_key = ?", bizLine, programID, requirementKey).
		Select("MAX(seq)").Scan(&maxSeq).Error
	if err != nil {
		return 0, err
	}
	if maxSeq == nil {
		return 1, nil
	}
	return *maxSeq + 1, nil
}

func (r *DeliveryRepository) CreateRequirementPlanningBatch(ctx context.Context, row *DeliveryRequirementPlanningBatch) error {
	return r.Db.WithContext(ctx).Create(row).Error
}

func (r *DeliveryRepository) DeleteRequirementPlanningBatches(ctx context.Context, bizLine string, programID int64, requirementKey string) error {
	return r.Db.WithContext(ctx).
		Where("biz_line = ? AND program_id = ? AND requirement_key = ?", bizLine, programID, requirementKey).
		Delete(&DeliveryRequirementPlanningBatch{}).Error
}
