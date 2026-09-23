package repository

import (
	"context"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// TrackingDailyStat 是管理端按日期读取的事件合计。
// 同一天同一事件下的不同 TargetKey 在 SQL 里汇总，避免把所有模型行搬回应用层。
type TrackingDailyStat struct {
	EventDate time.Time `gorm:"column:event_date"`
	EventKey  string    `gorm:"column:event_key"`
	Count     int64     `gorm:"column:count"`
}

// IncrementTrackingDaily 原子累加一个日桶。
//
// 不能先 SELECT 再 UPDATE：官网同时进来两个人时，两边都会读到同一个旧值，最后少记一次。
// 唯一键配合 ON DUPLICATE KEY UPDATE 让数据库串行完成累加。
func (r *GalaxyRepository) IncrementTrackingDaily(ctx context.Context, row *GalaxyTrackingDaily) error {
	return r.Db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{
			{Name: "biz_line"}, {Name: "event_date"}, {Name: "event_key"}, {Name: "target_key"},
		},
		DoUpdates: clause.Assignments(map[string]any{
			"count":        gorm.Expr("count + ?", 1),
			"updated_time": row.UpdatedTime,
		}),
	}).Create(row).Error
}

// ListTrackingDaily 汇总 [from, to) 内每种事件每天的次数。
func (r *GalaxyRepository) ListTrackingDaily(ctx context.Context, bizLine string, from, to time.Time) ([]TrackingDailyStat, error) {
	var rows []TrackingDailyStat
	err := r.Db.WithContext(ctx).Model(&GalaxyTrackingDaily{}).
		Select("event_date, event_key, CAST(SUM(count) AS SIGNED) AS count").
		Where("biz_line = ?", bizLine).
		Where("event_date >= ?", from).Where("event_date < ?", to).
		Group("event_date, event_key").Order("event_date, event_key").Scan(&rows).Error
	return rows, err
}
