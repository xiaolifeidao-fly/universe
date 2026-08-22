// 需求完成消息的持久化。消息的接收人和已读状态属于通知本身，不能放回需求记录。
package repository

import (
	"context"
	"time"

	"gorm.io/gorm/clause"
)

// UpsertRequirementCompletionNotifications 在需求进入 done 时创建或刷新每位接收人的消息。
// 同一需求再次完成时，已读状态重新置空，表示这是一轮新的完成提醒。
func (r *DeliveryRepository) UpsertRequirementCompletionNotifications(ctx context.Context, rows []*DeliveryRequirementCompletionNotification) error {
	if len(rows) == 0 {
		return nil
	}
	now := time.Now()
	for _, row := range rows {
		row.NotificationReadAt = nil
		row.CompletedAt = now
		row.CreatedTime = now
		row.UpdatedTime = now
	}
	return r.Db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{
			{Name: "biz_line"}, {Name: "program_id"}, {Name: "requirement_key"}, {Name: "recipient_id"},
		},
		DoUpdates: clause.AssignmentColumns([]string{
			"requirement_name", "recipient_name", "notification_read_at", "completed_at", "updated_time",
		}),
	}).Create(&rows).Error
}

func (r *DeliveryRepository) ListRequirementCompletionNotifications(
	ctx context.Context, bizLine string, programID int64, recipientID string,
) ([]*DeliveryRequirementCompletionNotification, error) {
	var rows []*DeliveryRequirementCompletionNotification
	err := r.Db.WithContext(ctx).Model(&DeliveryRequirementCompletionNotification{}).
		Where("biz_line = ? AND program_id = ? AND recipient_id = ?", bizLine, programID, recipientID).
		Order("completed_at desc, id desc").Limit(50).Find(&rows).Error
	return rows, err
}

func (r *DeliveryRepository) FindRequirementCompletionNotification(
	ctx context.Context, bizLine string, programID int64, requirementKey, recipientID string,
) (*DeliveryRequirementCompletionNotification, error) {
	var row DeliveryRequirementCompletionNotification
	err := r.Db.WithContext(ctx).Model(&DeliveryRequirementCompletionNotification{}).
		Where("biz_line = ? AND program_id = ? AND requirement_key = ? AND recipient_id = ?", bizLine, programID, requirementKey, recipientID).
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *DeliveryRepository) MarkRequirementCompletionNotificationRead(
	ctx context.Context, bizLine string, programID int64, requirementKey, recipientID string, readAt time.Time,
) (int64, error) {
	tx := r.Db.WithContext(ctx).Model(&DeliveryRequirementCompletionNotification{}).
		Where("biz_line = ? AND program_id = ? AND requirement_key = ? AND recipient_id = ?", bizLine, programID, requirementKey, recipientID).
		Updates(map[string]any{"notification_read_at": &readAt, "updated_time": readAt})
	return tx.RowsAffected, tx.Error
}

func (r *DeliveryRepository) DeleteRequirementCompletionNotifications(ctx context.Context, bizLine string, programID int64, requirementKey string) error {
	return r.Db.WithContext(ctx).
		Where("biz_line = ? AND program_id = ? AND requirement_key = ?", bizLine, programID, requirementKey).
		Delete(&DeliveryRequirementCompletionNotification{}).Error
}
