// 项目表的读写。

package repository

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm/clause"
)

// ---------- 项目 ----------

func (r *DeliveryRepository) ListPrograms(ctx context.Context, bizLine string) ([]*DeliveryProgram, error) {
	var rows []*DeliveryProgram
	err := r.Db.WithContext(ctx).Model(&DeliveryProgram{}).
		Where("biz_line = ?", bizLine).
		Order("created_time asc").Find(&rows).Error
	return rows, err
}

func (r *DeliveryRepository) CountPrograms(ctx context.Context, bizLine string) (int64, error) {
	var total int64
	err := r.Db.WithContext(ctx).Model(&DeliveryProgram{}).Where("biz_line = ?", bizLine).Count(&total).Error
	return total, err
}

func (r *DeliveryRepository) FindProgram(ctx context.Context, bizLine string, programID int64) (*DeliveryProgram, error) {
	var row DeliveryProgram
	err := r.Db.WithContext(ctx).Model(&DeliveryProgram{}).
		Where("biz_line = ? AND id = ?", bizLine, programID).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// FindProgramByID 以全局项目主键定位项目，供 HTTP 层从项目解析其归属业务线。
func (r *DeliveryRepository) FindProgramByID(ctx context.Context, programID int64) (*DeliveryProgram, error) {
	var row DeliveryProgram
	err := r.Db.WithContext(ctx).Model(&DeliveryProgram{}).
		Where("id = ?", programID).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// LockProgram 把一个项目作为依赖图修改的事务锁，避免两条并发改边请求各自校验通过后合成环。
func (r *DeliveryRepository) LockProgram(ctx context.Context, bizLine string, programID int64) error {
	var row DeliveryProgram
	return r.Db.WithContext(ctx).Model(&DeliveryProgram{}).
		Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("biz_line = ? AND id = ?", bizLine, programID).
		First(&row).Error
}

func (r *DeliveryRepository) SaveProgram(ctx context.Context, row *DeliveryProgram) error {
	if row.Id == 0 {
		row.CreatedTime = time.Now()
		row.UpdatedTime = row.CreatedTime
		return r.Db.WithContext(ctx).Create(row).Error
	}
	var existing DeliveryProgram
	err := r.Db.WithContext(ctx).Model(&DeliveryProgram{}).
		Where("id = ?", row.Id).First(&existing).Error
	if err != nil {
		return err
	}
	if existing.BizLine != row.BizLine {
		return errors.New("项目不属于当前业务线")
	}
	return r.Db.WithContext(ctx).Model(&DeliveryProgram{}).Where("id = ?", existing.Id).
		Updates(map[string]any{
			"program_code": row.ProgramCode,
			"name":         row.Name,
			"summary":      row.Summary,
			"status":       row.Status,
			"updated_by":   row.UpdatedBy,
			"updated_time": time.Now(),
		}).Error
}

// MoveProgramBizLine 迁移项目及其全部交付数据。调用方必须包在同一事务中，
// 这样任一表的唯一键冲突都会让整次迁移回滚。
func (r *DeliveryRepository) MoveProgramBizLine(
	ctx context.Context,
	sourceBizLine, targetBizLine string, programID int64,
	values map[string]any,
) (int64, error) {
	programValues := map[string]any{"biz_line": targetBizLine}
	for key, value := range values {
		programValues[key] = value
	}
	program := r.Db.WithContext(ctx).Model(&DeliveryProgram{}).
		Where("biz_line = ? AND id = ?", sourceBizLine, programID).
		Updates(programValues)
	if program.Error != nil || program.RowsAffected == 0 {
		return program.RowsAffected, program.Error
	}

	for _, entity := range []any{
		&DeliveryStage{}, &DeliveryModule{}, &DeliveryRequirement{}, &DeliveryRequirementEvent{}, &DeliveryRequirementPlanningSession{},
		&DeliveryItem{}, &DeliveryItemExecutionSession{}, &DeliveryItemDependency{},
		&DeliveryItemEvent{}, &DeliverySnapshot{},
	} {
		if err := r.Db.WithContext(ctx).Model(entity).
			Where("biz_line = ? AND program_id = ?", sourceBizLine, programID).
			Updates(map[string]any{"biz_line": targetBizLine}).Error; err != nil {
			return 0, err
		}
	}
	return program.RowsAffected, nil
}
