// 时间计划表的读写，以及需求侧的时间计划关联。

package repository

import (
	"context"
	"time"

	"gorm.io/gorm"
)

// ---------- 时间计划 ----------

func (r *DeliveryRepository) ListTimePlans(ctx context.Context, bizLine string, programID int64, status string) ([]*DeliveryTimePlan, error) {
	tx := r.Db.WithContext(ctx).Model(&DeliveryTimePlan{}).
		Where("biz_line = ? AND program_id = ?", bizLine, programID)
	if status != "" {
		tx = tx.Where("status = ?", status)
	}
	var rows []*DeliveryTimePlan
	// 截止日期近的排前面；没填截止日期的排最后，不让它们挤在头部。
	err := tx.Order("end_at IS NULL asc, end_at asc, id desc").Find(&rows).Error
	return rows, err
}

func (r *DeliveryRepository) ListTimePlansPage(ctx context.Context, bizLine string, programID int64, status, keyword string, offset, limit int) ([]*DeliveryTimePlan, int64, error) {
	tx := r.Db.WithContext(ctx).Model(&DeliveryTimePlan{}).
		Where("biz_line = ?", bizLine).
		Where("program_id = ?", programID)
	if status != "" {
		tx = tx.Where("status = ?", status)
	}
	if keyword != "" {
		like := "%" + keyword + "%"
		tx = tx.Where("name LIKE ? OR plan_key LIKE ? OR branch LIKE ?", like, like, like)
	}
	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []*DeliveryTimePlan
	err := tx.Offset(offset).Limit(limit).
		Order("end_at IS NULL asc, end_at asc, id desc").Find(&rows).Error
	return rows, total, err
}

func (r *DeliveryRepository) FindTimePlan(ctx context.Context, bizLine string, programID int64, planKey string) (*DeliveryTimePlan, error) {
	var row DeliveryTimePlan
	err := r.Db.WithContext(ctx).Model(&DeliveryTimePlan{}).
		Where("biz_line = ? AND program_id = ? AND plan_key = ?", bizLine, programID, planKey).
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// FindTimePlanByBranch 用于建计划前的重名判定：同一个项目里一条分支只能挂一个计划，
// 否则两个计划各自往同一条分支上合，谁也说不清这条分支到底代表哪一批需求。
func (r *DeliveryRepository) FindTimePlanByBranch(ctx context.Context, bizLine string, programID int64, branch string) (*DeliveryTimePlan, error) {
	var row DeliveryTimePlan
	err := r.Db.WithContext(ctx).Model(&DeliveryTimePlan{}).
		Where("biz_line = ? AND program_id = ? AND branch = ?", bizLine, programID, branch).
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *DeliveryRepository) CreateTimePlan(ctx context.Context, row *DeliveryTimePlan) error {
	row.CreatedTime = time.Now()
	row.UpdatedTime = row.CreatedTime
	return r.Db.WithContext(ctx).Create(row).Error
}

// UpdateTimePlan 带版本比对，0 行即冲突，交回给调用方翻译成版本冲突错误。
func (r *DeliveryRepository) UpdateTimePlan(ctx context.Context, bizLine string, programID int64, planKey string, version int, values map[string]any) (int64, error) {
	values["version"] = gorm.Expr("version + 1")
	values["updated_time"] = time.Now()
	tx := r.Db.WithContext(ctx).Model(&DeliveryTimePlan{}).
		Where("biz_line = ? AND program_id = ? AND plan_key = ? AND version = ?", bizLine, programID, planKey, version).
		Updates(values)
	return tx.RowsAffected, tx.Error
}

// TouchTimePlan 只记录一次合并动作的时间与操作人，不参与乐观锁：
// 合并是本机动作，和别人正在改计划名称不冲突，不该因为版本对不上就丢掉这条事实。
func (r *DeliveryRepository) TouchTimePlan(ctx context.Context, bizLine string, programID int64, planKey string, values map[string]any) (int64, error) {
	values["updated_time"] = time.Now()
	tx := r.Db.WithContext(ctx).Model(&DeliveryTimePlan{}).
		Where("biz_line = ? AND program_id = ? AND plan_key = ?", bizLine, programID, planKey).
		Updates(values)
	return tx.RowsAffected, tx.Error
}

func (r *DeliveryRepository) DeleteTimePlan(ctx context.Context, bizLine string, programID int64, planKey string) (int64, error) {
	tx := r.Db.WithContext(ctx).
		Where("biz_line = ? AND program_id = ? AND plan_key = ?", bizLine, programID, planKey).
		Delete(&DeliveryTimePlan{})
	return tx.RowsAffected, tx.Error
}

// ---------- 需求侧的时间计划关联 ----------

// ListRequirementsByTimePlan 返回一个时间计划下的全部需求，合并需求分支时按它取分支清单。
func (r *DeliveryRepository) ListRequirementsByTimePlan(ctx context.Context, bizLine string, programID int64, planKey string) ([]*DeliveryRequirement, error) {
	var rows []*DeliveryRequirement
	err := r.Db.WithContext(ctx).Model(&DeliveryRequirement{}).
		Where("biz_line = ? AND program_id = ? AND time_plan_key = ?", bizLine, programID, planKey).
		Order("id asc").Find(&rows).Error
	return rows, err
}

// CountRequirementsByTimePlan 供计划列表展示需求条数，不拉需求明细。
func (r *DeliveryRepository) CountRequirementsByTimePlan(ctx context.Context, bizLine string, programID int64) (map[string]int64, error) {
	type countRow struct {
		TimePlanKey string `gorm:"column:time_plan_key"`
		Total       int64  `gorm:"column:total"`
	}
	var rows []countRow
	err := r.Db.WithContext(ctx).Model(&DeliveryRequirement{}).
		Select("time_plan_key, COUNT(*) AS total").
		Where("biz_line = ? AND program_id = ? AND time_plan_key <> ''", bizLine, programID).
		Group("time_plan_key").Find(&rows).Error
	if err != nil {
		return nil, err
	}
	counts := make(map[string]int64, len(rows))
	for _, row := range rows {
		counts[row.TimePlanKey] = row.Total
	}
	return counts, nil
}

// BindRequirementTimePlan 单独更新关联列并推进版本：关联时间计划不该和需求正文编辑抢版本号，
// 传空串即解除关联。
func (r *DeliveryRepository) BindRequirementTimePlan(ctx context.Context, bizLine string, programID int64, requirementKey, planKey, actor string, now time.Time) (int64, error) {
	tx := r.Db.WithContext(ctx).Model(&DeliveryRequirement{}).
		Where("biz_line = ? AND program_id = ? AND requirement_key = ?", bizLine, programID, requirementKey).
		Updates(map[string]any{
			"time_plan_key": planKey,
			"updated_by":    actor,
			"version":       gorm.Expr("version + 1"),
			"updated_time":  now,
		})
	return tx.RowsAffected, tx.Error
}

// ClearTimePlanRequirements 在计划删除的同一个事务里解除全部关联，不留悬挂的计划键。
func (r *DeliveryRepository) ClearTimePlanRequirements(ctx context.Context, bizLine string, programID int64, planKey string) (int64, error) {
	tx := r.Db.WithContext(ctx).Model(&DeliveryRequirement{}).
		Where("biz_line = ? AND program_id = ? AND time_plan_key = ?", bizLine, programID, planKey).
		Updates(map[string]any{
			"time_plan_key": "",
			"version":       gorm.Expr("version + 1"),
			"updated_time":  time.Now(),
		})
	return tx.RowsAffected, tx.Error
}
