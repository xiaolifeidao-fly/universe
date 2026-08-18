// 任务表的读写。

package repository

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"
)

// ---------- 任务 ----------

// ItemQuery 是 Repository 内部的查询条件，字段已经是 string/int，
// 不带 contract.BizLine 这类领域类型 —— Repository 不认领域概念。
type ItemQuery struct {
	BizLine        string
	ProgramID      int64
	StageKey       string
	ModuleKey      string
	RequirementKey string
	Status         string
	Phase          string
	Kind           string
	OwnerName      string
	Keyword        string
	RecentFirst    bool
	Offset         int
	Limit          int
}

func (r *DeliveryRepository) itemScope(ctx context.Context, q ItemQuery) *gorm.DB {
	tx := r.Db.WithContext(ctx).Model(&DeliveryItem{}).
		Where("biz_line = ?", q.BizLine).
		Where("program_id = ?", q.ProgramID)
	if q.StageKey != "" {
		tx = tx.Where("stage_key = ?", q.StageKey)
	}
	if q.ModuleKey != "" {
		tx = tx.Where("module_key = ?", q.ModuleKey)
	}
	if q.RequirementKey != "" {
		tx = tx.Where("requirement_key = ?", q.RequirementKey)
	}
	if q.Status != "" {
		tx = tx.Where("status = ?", q.Status)
	}
	if q.Phase != "" {
		tx = tx.Where("phase = ?", q.Phase)
	}
	if q.Kind != "" {
		tx = tx.Where("kind = ?", q.Kind)
	}
	if q.OwnerName != "" {
		tx = tx.Where("owner_name = ?", q.OwnerName)
	}
	if q.Keyword != "" {
		like := "%" + q.Keyword + "%"
		tx = tx.Where("title LIKE ? OR description LIKE ? OR note LIKE ? OR item_key LIKE ?", like, like, like, like)
	}
	return tx
}

func (r *DeliveryRepository) ListItems(ctx context.Context, q ItemQuery) ([]*DeliveryItem, int64, error) {
	tx := r.itemScope(ctx, q)

	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	if q.Limit > 0 {
		tx = tx.Offset(q.Offset).Limit(q.Limit)
	}

	var rows []*DeliveryItem
	// 大文本只在详情接口中读取，避免任务面板、全景和插件上下文反复传输执行记录。
	order := "sort_order asc, id asc"
	if q.RecentFirst {
		order = "created_time desc, id desc"
	}
	err := tx.Omit("requirement_document", "execution_output", "testing_cases").Order(order).Find(&rows).Error
	return rows, total, err
}

// ListAllItems 不分页，看板与统计用。一个项目的推进任务是几十到几百条量级，
// 分页反而让「按阶段分列」这种视图要多轮往返。
func (r *DeliveryRepository) ListAllItems(ctx context.Context, q ItemQuery) ([]*DeliveryItem, error) {
	var rows []*DeliveryItem
	err := r.itemScope(ctx, q).Omit("requirement_document", "execution_output", "testing_cases").Order("sort_order asc, id asc").Find(&rows).Error
	return rows, err
}

func (r *DeliveryRepository) FindItem(ctx context.Context, bizLine string, programID int64, itemKey string) (*DeliveryItem, error) {
	var row DeliveryItem
	err := r.Db.WithContext(ctx).Model(&DeliveryItem{}).
		Where("biz_line = ? AND program_id = ? AND item_key = ?", bizLine, programID, itemKey).
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *DeliveryRepository) CreateItem(ctx context.Context, row *DeliveryItem) error {
	row.CreatedTime = time.Now()
	row.UpdatedTime = row.CreatedTime
	if row.Version <= 0 {
		row.Version = 1
	}
	return r.Db.WithContext(ctx).Create(row).Error
}

// UpdateItem 带版本条件的更新，返回受影响行数。
// 0 行有两种可能：记录不存在，或版本已被别人改过 —— 由 Service 区分，
// Repository 不做业务判断。
func (r *DeliveryRepository) UpdateItem(ctx context.Context, bizLine string, programID int64, itemKey string, version int, values map[string]any) (int64, error) {
	values["version"] = gorm.Expr("version + 1")
	values["updated_time"] = time.Now()
	tx := r.Db.WithContext(ctx).Model(&DeliveryItem{}).
		Where("biz_line = ? AND program_id = ? AND item_key = ? AND version = ?", bizLine, programID, itemKey, version).
		Updates(values)
	return tx.RowsAffected, tx.Error
}

// UpdateItemTestingCases 仅更新测试用例产物，不递增版本也不触碰任务状态。
// 研发中的任务可同时更新 action_output / status，二者不存在覆盖关系。
func (r *DeliveryRepository) UpdateItemTestingCases(
	ctx context.Context, bizLine string, programID int64, itemKey string, values map[string]any,
) (int64, error) {
	values["updated_time"] = time.Now()
	tx := r.Db.WithContext(ctx).Model(&DeliveryItem{}).
		Where("biz_line = ? AND program_id = ? AND item_key = ?", bizLine, programID, itemKey).
		Updates(values)
	return tx.RowsAffected, tx.Error
}

func (r *DeliveryRepository) DeleteItem(ctx context.Context, bizLine string, programID int64, itemKey string) (int64, error) {
	tx := r.Db.WithContext(ctx).
		Where("biz_line = ? AND program_id = ? AND item_key = ?", bizLine, programID, itemKey).
		Delete(&DeliveryItem{})
	return tx.RowsAffected, tx.Error
}

// UpsertItem 导入专用：按 item_key 覆盖。日常改动走 UpdateItem 的乐观锁路径。
func (r *DeliveryRepository) UpsertItem(ctx context.Context, row *DeliveryItem) (created bool, err error) {
	var existing DeliveryItem
	err = r.Db.WithContext(ctx).Model(&DeliveryItem{}).
		Where("biz_line = ? AND program_id = ? AND item_key = ?", row.BizLine, row.ProgramID, row.ItemKey).
		First(&existing).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return true, r.CreateItem(ctx, row)
	}
	if err != nil {
		return false, err
	}
	return false, r.Db.WithContext(ctx).Model(&DeliveryItem{}).Where("id = ?", existing.Id).
		Updates(map[string]any{
			"stage_key":                 row.StageKey,
			"module_key":                row.ModuleKey,
			"kind":                      row.Kind,
			"prototype_task":            row.PrototypeTask,
			"title":                     row.Title,
			"description":               row.Description,
			"requirement_document":      row.RequirementDocument,
			"requirement_document_path": row.RequirementDocumentPath,
			"execution_output":          row.ExecutionOutput,
			"action_output":             row.ActionOutput,
			"testing_report":            row.TestingReport,
			"testing_cases_status":      row.TestingCasesStatus,
			"testing_cases":             row.TestingCases,
			"testing_cases_path":        row.TestingCasesPath,
			"phase":                     row.Phase,
			"requirement_status":        row.RequirementStatus,
			"development_status":        row.DevelopmentStatus,
			"testing_status":            row.TestingStatus,
			"status":                    row.Status,
			"progress":                  row.Progress,
			"owner_id":                  row.OwnerID,
			"owner_name":                row.OwnerName,
			"due_date":                  row.DueDate,
			"note":                      row.Note,
			"sort_order":                row.SortOrder,
			"updated_by":                row.UpdatedBy,
			"version":                   gorm.Expr("version + 1"),
			"updated_time":              time.Now(),
		}).Error
}
