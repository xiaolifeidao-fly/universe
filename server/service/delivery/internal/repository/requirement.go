// 需求表的读写，以及需求维度的任务统计与解绑。

package repository

import (
	"context"
	"time"

	"gorm.io/gorm"
)

// TimePlanFilterNone 是需求列表「未排期」筛选项的取值：它不是某个计划的键，
// 而是「time_plan_key 为空」这一条件的显式写法。
const TimePlanFilterNone = "none"

// ---------- 需求 ----------

// RequirementQuery 需求列表条件。RelatedTo 命中「创建人 / 主负责人 / 辅助人是我」，
// AssignedTo 只命中「主负责人 / 辅助人是我」；两者空值均表示不限定。
type RequirementQuery struct {
	BizLine   string
	ProgramID int64
	Keyword   string
	Status    string
	// TimePlanKey 为 "none" 表示只看还没排进任何时间计划的需求；其余非空值按计划键精确匹配。
	TimePlanKey string
	RelatedTo   string
	AssignedTo  string
	Offset      int
	Limit       int
}

func (r *DeliveryRepository) requirementScope(ctx context.Context, q RequirementQuery) *gorm.DB {
	tx := r.Db.WithContext(ctx).Model(&DeliveryRequirement{}).
		Where("biz_line = ?", q.BizLine).
		Where("program_id = ?", q.ProgramID)
	if q.Status != "" {
		tx = tx.Where("status = ?", q.Status)
	}
	if q.Keyword != "" {
		like := "%" + q.Keyword + "%"
		tx = tx.Where("name LIKE ? OR detail LIKE ? OR requirement_key LIKE ?", like, like, like)
	}
	if q.TimePlanKey == TimePlanFilterNone {
		tx = tx.Where("time_plan_key = ''")
	} else if q.TimePlanKey != "" {
		tx = tx.Where("time_plan_key = ?", q.TimePlanKey)
	}
	if q.RelatedTo != "" {
		member := "%," + q.RelatedTo + ",%"
		tx = tx.Where("created_by = ? OR owner_ids LIKE ? OR assistant_ids LIKE ?", q.RelatedTo, member, member)
	}
	if q.AssignedTo != "" {
		member := "%," + q.AssignedTo + ",%"
		tx = tx.Where("owner_ids LIKE ? OR assistant_ids LIKE ?", member, member)
	}
	return tx
}

func (r *DeliveryRepository) ListRequirements(ctx context.Context, q RequirementQuery) ([]*DeliveryRequirement, int64, error) {
	tx := r.requirementScope(ctx, q)

	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	if q.Limit > 0 {
		tx = tx.Offset(q.Offset).Limit(q.Limit)
	}
	var rows []*DeliveryRequirement
	err := tx.Order("created_time desc, id desc").Find(&rows).Error
	return rows, total, err
}

func (r *DeliveryRepository) FindRequirement(ctx context.Context, bizLine string, programID int64, requirementKey string) (*DeliveryRequirement, error) {
	var row DeliveryRequirement
	err := r.Db.WithContext(ctx).Model(&DeliveryRequirement{}).
		Where("biz_line = ? AND program_id = ? AND requirement_key = ?", bizLine, programID, requirementKey).
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *DeliveryRepository) CreateRequirement(ctx context.Context, row *DeliveryRequirement) error {
	row.CreatedTime = time.Now()
	row.UpdatedTime = row.CreatedTime
	if row.Version <= 0 {
		row.Version = 1
	}
	return r.Db.WithContext(ctx).Create(row).Error
}

// UpdateRequirement 与任务同样走乐观锁：需求详情弹窗可能同时被两个人开着。
func (r *DeliveryRepository) UpdateRequirement(
	ctx context.Context,
	bizLine string, programID int64, requirementKey string,
	version int,
	values map[string]any,
) (int64, error) {
	values["version"] = gorm.Expr("version + 1")
	values["updated_time"] = time.Now()
	tx := r.Db.WithContext(ctx).Model(&DeliveryRequirement{}).
		Where("biz_line = ? AND program_id = ? AND requirement_key = ? AND version = ?", bizLine, programID, requirementKey, version).
		Updates(values)
	return tx.RowsAffected, tx.Error
}

// UpdateRequirementNameIfUnchanged 只在需求名称仍是 expected 时写入自动生成的标题。
// expected 为空表示「名称仍为空才写」，非空表示「只换掉这个自动占位名」。
// 条件写在 SQL 里而不是先查后写：拆解会话在后台结束，用户可能同时正在弹窗里补名字，
// 谁先落库谁算。同样不递增编辑 version，避免和用户正在编辑的需求互相制造乐观锁冲突。
func (r *DeliveryRepository) UpdateRequirementNameIfUnchanged(
	ctx context.Context,
	bizLine string, programID int64, requirementKey, name, expected, updatedBy string,
) (int64, error) {
	query := r.Db.WithContext(ctx).Model(&DeliveryRequirement{}).
		Where("biz_line = ? AND program_id = ? AND requirement_key = ?", bizLine, programID, requirementKey)
	if expected == "" {
		query = query.Where("name IS NULL OR name = ?", "")
	} else {
		query = query.Where("name = ?", expected)
	}
	tx := query.Updates(map[string]any{
		"name":         name,
		"updated_by":   updatedBy,
		"updated_time": time.Now(),
	})
	return tx.RowsAffected, tx.Error
}

// UpdateRequirementPrototype 由原型生成桥回写文件位置和生成时点。
// 它不改变需求的编辑版本，避免后台生成和用户编辑需求互相制造乐观锁冲突。
func (r *DeliveryRepository) UpdateRequirementPrototype(
	ctx context.Context,
	bizLine string, programID int64, requirementKey, relativePath, updatedBy string,
	generatedAt time.Time,
) (int64, error) {
	tx := r.Db.WithContext(ctx).Model(&DeliveryRequirement{}).
		Where("biz_line = ? AND program_id = ? AND requirement_key = ?", bizLine, programID, requirementKey).
		Updates(map[string]any{
			"prototype_html_path":    relativePath,
			"prototype_generated_at": generatedAt,
			"updated_by":             updatedBy,
			"updated_time":           generatedAt,
		})
	return tx.RowsAffected, tx.Error
}

// BindRequirementGitBranch 只在本机已经成功创建分支后写入关联结果。
// 不递增编辑 version，避免异步的 Git 操作和需求正文编辑互相冲突。
func (r *DeliveryRepository) BindRequirementGitBranch(
	ctx context.Context,
	bizLine string, programID int64, requirementKey, baseBranch, branch, updatedBy string,
	createdAt time.Time,
) (int64, error) {
	tx := r.Db.WithContext(ctx).Model(&DeliveryRequirement{}).
		Where("biz_line = ? AND program_id = ? AND requirement_key = ?", bizLine, programID, requirementKey).
		Updates(map[string]any{
			"git_enabled":           true,
			"git_base_branch":       baseBranch,
			"git_branch":            branch,
			"git_branch_created_at": createdAt,
			"updated_by":            updatedBy,
			"updated_time":          createdAt,
		})
	return tx.RowsAffected, tx.Error
}

// UpdateRequirementTesting 需求总体测试由桥接异步回写，不与用户编辑需求共用版本锁。
// 报告与测试用例都是独立测试产物，避免后台测试覆盖用户正在编辑的需求正文。
func (r *DeliveryRepository) UpdateRequirementTesting(
	ctx context.Context, bizLine string, programID int64, requirementKey string, values map[string]any,
) (int64, error) {
	tx := r.Db.WithContext(ctx).Model(&DeliveryRequirement{}).
		Where("biz_line = ? AND program_id = ? AND requirement_key = ?", bizLine, programID, requirementKey).
		Updates(values)
	return tx.RowsAffected, tx.Error
}

func (r *DeliveryRepository) DeleteRequirement(ctx context.Context, bizLine string, programID int64, requirementKey string) (int64, error) {
	tx := r.Db.WithContext(ctx).
		Where("biz_line = ? AND program_id = ? AND requirement_key = ?", bizLine, programID, requirementKey).
		Delete(&DeliveryRequirement{})
	return tx.RowsAffected, tx.Error
}

// DetachRequirementItems 需求删除后任务仍然留在看板上，只是不再属于任何需求。
func (r *DeliveryRepository) DetachRequirementItems(ctx context.Context, bizLine string, programID int64, requirementKey string) (int64, error) {
	tx := r.Db.WithContext(ctx).Model(&DeliveryItem{}).
		Where("biz_line = ? AND program_id = ? AND requirement_key = ?", bizLine, programID, requirementKey).
		Updates(map[string]any{
			"requirement_key": "",
			"version":         gorm.Expr("version + 1"),
			"updated_time":    time.Now(),
		})
	return tx.RowsAffected, tx.Error
}

func (r *DeliveryRepository) ListRequirementItemCounts(ctx context.Context, bizLine string, programID int64) (map[string]int64, error) {
	type countRow struct {
		RequirementKey string `gorm:"column:requirement_key"`
		Total          int64  `gorm:"column:total"`
	}
	var rows []countRow
	err := r.Db.WithContext(ctx).Model(&DeliveryItem{}).
		Select("requirement_key, COUNT(*) AS total").
		Where("biz_line = ? AND program_id = ?", bizLine, programID).
		Group("requirement_key").Find(&rows).Error
	if err != nil {
		return nil, err
	}
	counts := make(map[string]int64, len(rows))
	for _, row := range rows {
		counts[row.RequirementKey] = row.Total
	}
	return counts, nil
}
