// 任务流水表的读写。

package repository

import (
	"context"
	"sort"
	"time"
)

// 流水表的 from_value / to_value 是 varchar(255)、comment 是 varchar(1024)，
// 但调用方传进来的可能是任务描述、测试用例这类长文本。写库前统一截断：
// 一条流水不该因为超长（MySQL 1406 Data too long）把整次业务操作带失败。
const (
	eventValueMaxRunes   = 255
	eventCommentMaxRunes = 1024
)

func clampEventText(value string, max int) string {
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max-1]) + "…"
}

// ---------- 流水 ----------

func (r *DeliveryRepository) AppendEvents(ctx context.Context, rows []*DeliveryItemEvent) error {
	if len(rows) == 0 {
		return nil
	}
	now := time.Now()
	for _, row := range rows {
		if row.CreatedTime.IsZero() {
			row.CreatedTime = now
		}
		row.FromValue = clampEventText(row.FromValue, eventValueMaxRunes)
		row.ToValue = clampEventText(row.ToValue, eventValueMaxRunes)
		row.Comment = clampEventText(row.Comment, eventCommentMaxRunes)
	}
	return r.Db.WithContext(ctx).Create(rows).Error
}

type EventQuery struct {
	BizLine   string
	ProgramID int64
	ItemKey   string
	Offset    int
	Limit     int
}

func (r *DeliveryRepository) ListEvents(ctx context.Context, q EventQuery) ([]*DeliveryItemEvent, int64, error) {
	tx := r.Db.WithContext(ctx).Model(&DeliveryItemEvent{}).
		Where("biz_line = ?", q.BizLine).
		Where("program_id = ?", q.ProgramID)
	if q.ItemKey != "" {
		tx = tx.Where("item_key = ?", q.ItemKey)
	}

	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	if q.Limit > 0 {
		tx = tx.Offset(q.Offset).Limit(q.Limit)
	}

	var rows []*DeliveryItemEvent
	err := tx.Order("id desc").Find(&rows).Error
	return rows, total, err
}

func (r *DeliveryRepository) AppendRequirementEvents(ctx context.Context, rows []*DeliveryRequirementEvent) error {
	if len(rows) == 0 {
		return nil
	}
	now := time.Now()
	for _, row := range rows {
		if row.CreatedTime.IsZero() {
			row.CreatedTime = now
		}
		row.FromValue = clampEventText(row.FromValue, eventValueMaxRunes)
		row.ToValue = clampEventText(row.ToValue, eventValueMaxRunes)
		row.Comment = clampEventText(row.Comment, eventCommentMaxRunes)
	}
	return r.Db.WithContext(ctx).Create(rows).Error
}

type RequirementTimelineQuery struct {
	BizLine        string
	ProgramID      int64
	RequirementKey string
	Offset         int
	Limit          int
}

// RequirementTimelineRow 是两张事件表统一后的持久层读模型；EventID 仅用于稳定排序，不出现在 API 中。
type RequirementTimelineRow struct {
	Source    string    `gorm:"column:source"`
	ItemKey   string    `gorm:"column:item_key"`
	Kind      string    `gorm:"column:kind"`
	Field     string    `gorm:"column:field"`
	FromValue string    `gorm:"column:from_value"`
	ToValue   string    `gorm:"column:to_value"`
	Comment   string    `gorm:"column:comment"`
	ActorID   string    `gorm:"column:actor_id"`
	ActorName string    `gorm:"column:actor_name"`
	CreatedAt time.Time `gorm:"column:created_at"`
	EventID   int64     `gorm:"column:event_id"`
}

// ListRequirementTimeline 合并需求事件与任务事件。任务事件先按写入时冻结的 requirement_key 命中；
// 再兼容旧数据中为空的键，借当前任务归属补齐历史读取。
func (r *DeliveryRepository) ListRequirementTimeline(ctx context.Context, q RequirementTimelineQuery) ([]RequirementTimelineRow, int64, error) {
	var requirementRows []RequirementTimelineRow
	if err := r.Db.WithContext(ctx).Model(&DeliveryRequirementEvent{}).
		Select("'requirement' AS source, '' AS item_key, kind, field, from_value, to_value, comment, actor_id, actor_name, created_time AS created_at, id AS event_id").
		Where("biz_line = ? AND program_id = ? AND requirement_key = ?", q.BizLine, q.ProgramID, q.RequirementKey).
		Find(&requirementRows).Error; err != nil {
		return nil, 0, err
	}

	itemScope := r.Db.WithContext(ctx).Table("zt_delivery_item_event AS event").
		Joins("LEFT JOIN zt_delivery_item AS item ON item.biz_line = event.biz_line AND item.program_id = event.program_id AND item.item_key = event.item_key").
		Where("event.biz_line = ? AND event.program_id = ?", q.BizLine, q.ProgramID).
		Where("event.requirement_key = ? OR (event.requirement_key = '' AND item.requirement_key = ?)", q.RequirementKey, q.RequirementKey)
	var itemRows []RequirementTimelineRow
	if err := itemScope.Select("'item' AS source, event.item_key, event.kind, event.field, event.from_value, event.to_value, event.comment, event.actor_id, event.actor_name, event.created_time AS created_at, event.id AS event_id").
		Find(&itemRows).Error; err != nil {
		return nil, 0, err
	}

	rows := append(requirementRows, itemRows...)
	sort.SliceStable(rows, func(left, right int) bool {
		if rows[left].CreatedAt.Equal(rows[right].CreatedAt) {
			return rows[left].EventID > rows[right].EventID
		}
		return rows[left].CreatedAt.After(rows[right].CreatedAt)
	})
	total := int64(len(rows))
	start := q.Offset
	if start > len(rows) {
		start = len(rows)
	}
	end := len(rows)
	if q.Limit > 0 && start+q.Limit < end {
		end = start + q.Limit
	}
	return rows[start:end], total, nil
}
