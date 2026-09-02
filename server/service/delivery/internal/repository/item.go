// 任务表的读写。

package repository

import (
	"context"
	"errors"
	"strings"
	"time"

	"gorm.io/gorm"
)

// splitFilterValues 把「a,b」这类多值筛选拆成去空后的切片，单值查询不受影响。
func splitFilterValues(value string) []string {
	values := make([]string, 0, 2)
	for _, part := range strings.Split(value, ",") {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			values = append(values, trimmed)
		}
	}
	return values
}

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
	// 消息中心一次要同时看「受阻」和「不做」，状态支持逗号分隔的多值。
	if statuses := splitFilterValues(q.Status); len(statuses) == 1 {
		tx = tx.Where("status = ?", statuses[0])
	} else if len(statuses) > 1 {
		tx = tx.Where("status IN ?", statuses)
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

// StartItemRun 记下这条任务最近一轮执行的开始时刻。
//
// 执行计时不走乐观锁，也不动 version 和 updated_time：写它的是执行侧的回合边界，
// 和面板上的人工编辑互不相干；递增版本会把正在编辑这条任务的人挤掉。
func (r *DeliveryRepository) StartItemRun(
	ctx context.Context, bizLine string, programID int64, itemKey string, startedAt time.Time,
) error {
	return r.Db.WithContext(ctx).Model(&DeliveryItem{}).
		Where("biz_line = ? AND program_id = ? AND item_key = ?", bizLine, programID, itemKey).
		Updates(map[string]any{
			"last_run_started_at":  startedAt,
			"last_run_finished_at": nil,
		}).Error
}

// FinishItemRun 结算一轮执行：最近一轮按本轮覆盖，累计耗时和轮次只增不减。
// 累计用 SQL 表达式自增，同一条任务的多个阶段会话并发收尾时不会互相覆盖。
func (r *DeliveryRepository) FinishItemRun(
	ctx context.Context, bizLine string, programID int64, itemKey string,
	startedAt, finishedAt time.Time, durationMs int64,
) error {
	return r.Db.WithContext(ctx).Model(&DeliveryItem{}).
		Where("biz_line = ? AND program_id = ? AND item_key = ?", bizLine, programID, itemKey).
		Updates(map[string]any{
			"last_run_started_at":   startedAt,
			"last_run_finished_at":  finishedAt,
			"last_run_duration_ms":  durationMs,
			"total_run_duration_ms": gorm.Expr("total_run_duration_ms + ?", durationMs),
			"run_count":             gorm.Expr("run_count + 1"),
		}).Error
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
