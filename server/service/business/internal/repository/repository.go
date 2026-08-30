package repository

import (
	"context"
	"time"

	"common/middleware/db"
)

type RequirementQuery struct {
	BizLine   string
	CreatorID string
	Offset    int
	Limit     int
}

type CollectedRequirementQuery struct {
	BizLine string
	Offset  int
	Limit   int
}

type BusinessRepository struct {
	db.Repository[*BusinessRequirement]
}

// AutoMigrate is provided for local initialization. Production schema changes
// are applied explicitly through server/migrations rather than at app startup.
func (r *BusinessRepository) AutoMigrate() error {
	return r.Db.AutoMigrate(&BusinessRequirement{}, &BusinessRequirementMessage{}, &BusinessRequirementDocument{})
}

func (r *BusinessRepository) ListRequirements(ctx context.Context, query RequirementQuery) ([]*BusinessRequirement, int64, error) {
	database := r.Db.WithContext(ctx).Model(&BusinessRequirement{}).
		Where("biz_line = ? AND created_by = ?", query.BizLine, query.CreatorID)
	var total int64
	if err := database.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []*BusinessRequirement
	if err := database.Order("created_time desc, id desc").Offset(query.Offset).Limit(query.Limit).Find(&rows).Error; err != nil {
		return nil, 0, err
	}
	return rows, total, nil
}

// ListCollectedRequirements returns every business demand in the selected
// space for product/research collection. The caller's space authorization is
// checked at the HTTP boundary; this repository only owns its domain query.
func (r *BusinessRepository) ListCollectedRequirements(ctx context.Context, query CollectedRequirementQuery) ([]*BusinessRequirement, int64, error) {
	database := r.Db.WithContext(ctx).Model(&BusinessRequirement{}).
		Where("biz_line = ?", query.BizLine)
	var total int64
	if err := database.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []*BusinessRequirement
	if err := database.Order("updated_time desc, id desc").Offset(query.Offset).Limit(query.Limit).Find(&rows).Error; err != nil {
		return nil, 0, err
	}
	return rows, total, nil
}

func (r *BusinessRepository) CreateRequirement(ctx context.Context, row *BusinessRequirement) error {
	now := time.Now()
	row.CreatedTime = now
	row.UpdatedTime = now
	return r.Db.WithContext(ctx).Create(row).Error
}

func (r *BusinessRepository) FindRequirement(ctx context.Context, bizLine string, requirementID int64, creatorID string) (*BusinessRequirement, error) {
	var row BusinessRequirement
	if err := r.Db.WithContext(ctx).Where("biz_line = ? AND id = ? AND created_by = ?", bizLine, requirementID, creatorID).First(&row).Error; err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *BusinessRepository) FindCollectedRequirement(ctx context.Context, bizLine string, requirementID int64) (*BusinessRequirement, error) {
	var row BusinessRequirement
	if err := r.Db.WithContext(ctx).Where("biz_line = ? AND id = ?", bizLine, requirementID).First(&row).Error; err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *BusinessRepository) UpdateRequirementSummary(ctx context.Context, requirementID int64, title, detail string) error {
	return r.Db.WithContext(ctx).Model(&BusinessRequirement{}).Where("id = ?", requirementID).Updates(map[string]any{
		"title": title, "detail": detail, "updated_time": time.Now(),
	}).Error
}

func (r *BusinessRepository) ListMessages(ctx context.Context, bizLine string, requirementID int64) ([]*BusinessRequirementMessage, error) {
	var rows []*BusinessRequirementMessage
	if err := r.Db.WithContext(ctx).Where("biz_line = ? AND requirement_id = ?", bizLine, requirementID).Order("id asc").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func (r *BusinessRepository) CreateMessage(ctx context.Context, row *BusinessRequirementMessage) error {
	row.CreatedTime = time.Now()
	return r.Db.WithContext(ctx).Create(row).Error
}

func (r *BusinessRepository) ListDocuments(ctx context.Context, bizLine string, requirementID int64) ([]*BusinessRequirementDocument, error) {
	var rows []*BusinessRequirementDocument
	if err := r.Db.WithContext(ctx).Where("biz_line = ? AND requirement_id = ?", bizLine, requirementID).Order("version desc, id desc").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func (r *BusinessRepository) CreateDocument(ctx context.Context, row *BusinessRequirementDocument) error {
	row.CreatedTime = time.Now()
	return r.Db.WithContext(ctx).Create(row).Error
}
