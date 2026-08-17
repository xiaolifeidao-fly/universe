// 快照表的读写。

package repository

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"
)

// ---------- 快照 ----------

func (r *DeliveryRepository) UpsertSnapshot(ctx context.Context, row *DeliverySnapshot) error {
	var existing DeliverySnapshot
	err := r.Db.WithContext(ctx).Model(&DeliverySnapshot{}).
		Where("biz_line = ? AND program_id = ? AND stat_date = ? AND module_key = ?",
			row.BizLine, row.ProgramID, row.StatDate, row.ModuleKey).First(&existing).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		row.CreatedTime = time.Now()
		return r.Db.WithContext(ctx).Create(row).Error
	}
	if err != nil {
		return err
	}
	return r.Db.WithContext(ctx).Model(&DeliverySnapshot{}).Where("id = ?", existing.Id).
		Updates(map[string]any{
			"progress":       row.Progress,
			"maturity_score": row.MaturityScore,
			"total_count":    row.TotalCount,
			"done_count":     row.DoneCount,
			"doing_count":    row.DoingCount,
			"blocked_count":  row.BlockedCount,
			"created_time":   time.Now(),
		}).Error
}

type SnapshotQuery struct {
	BizLine   string
	ProgramID int64
	ModuleKey string
	From      *time.Time
	To        *time.Time
	Limit     int
}

func (r *DeliveryRepository) ListSnapshots(ctx context.Context, q SnapshotQuery) ([]*DeliverySnapshot, error) {
	tx := r.Db.WithContext(ctx).Model(&DeliverySnapshot{}).
		Where("biz_line = ?", q.BizLine).
		Where("program_id = ?", q.ProgramID).
		Where("module_key = ?", q.ModuleKey)
	if q.From != nil {
		tx = tx.Where("stat_date >= ?", *q.From)
	}
	if q.To != nil {
		tx = tx.Where("stat_date <= ?", *q.To)
	}
	if q.Limit > 0 {
		tx = tx.Limit(q.Limit)
	}

	var rows []*DeliverySnapshot
	err := tx.Order("stat_date asc").Find(&rows).Error
	return rows, err
}
