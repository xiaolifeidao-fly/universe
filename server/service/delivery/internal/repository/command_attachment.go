package repository

import (
	"context"
	"time"
)

func (r *DeliveryRepository) CreateCommandAttachments(ctx context.Context, rows []*DeliveryCommandAttachment) error {
	if len(rows) == 0 {
		return nil
	}
	now := time.Now()
	for _, row := range rows {
		row.CreatedTime = now
	}
	return r.Db.WithContext(ctx).Create(&rows).Error
}

func (r *DeliveryRepository) FindCommandAttachment(
	ctx context.Context, bizLine, userID string, programID int64, attachmentID string,
) (*DeliveryCommandAttachment, error) {
	var row DeliveryCommandAttachment
	err := r.Db.WithContext(ctx).Model(&DeliveryCommandAttachment{}).
		Where("biz_line = ?", bizLine).
		Where("user_id = ?", userID).
		Where("program_id = ?", programID).
		Where("attachment_id = ?", attachmentID).
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}
