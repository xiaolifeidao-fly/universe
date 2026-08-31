package repository

import (
	"context"
	"errors"
	"time"

	"common/middleware/db"

	"gorm.io/gorm"
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

// RemoteConversationFinalization is the complete local record that is
// committed once a remote Kodes turn has ended. ExpectedThreadID and TurnID
// identify the exact running turn that may be finalized.
type RemoteConversationFinalization struct {
	BizLine          string
	RequirementID    int64
	ExpectedThreadID string
	ThreadID         string
	TurnID           string
	Title            string
	Reply            string
}

type BusinessRepository struct {
	db.Repository[*BusinessRequirement]
}

// AutoMigrate is provided for local initialization. Production schema changes
// are applied explicitly through server/migrations rather than at app startup.
func (r *BusinessRepository) AutoMigrate() error {
	return r.Db.AutoMigrate(
		&BusinessRequirement{}, &BusinessRequirementMessage{},
		&BusinessRequirementDocument{}, &BusinessRequirementAttachment{},
	)
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

// UpdateRemoteConversation stores only the remote conversation cursor and its
// state; chat messages and AI documents stay in their own domain tables.
func (r *BusinessRepository) UpdateRemoteConversation(ctx context.Context, requirementID int64, threadID, turnID, status, remoteError string) error {
	return r.Db.WithContext(ctx).Model(&BusinessRequirement{}).Where("id = ?", requirementID).Updates(map[string]any{
		"remote_thread_id": threadID,
		"remote_turn_id":   turnID,
		"remote_status":    status,
		"remote_error":     remoteError,
		"updated_time":     time.Now(),
	}).Error
}

func (r *BusinessRepository) UpdateRemoteWorkspace(ctx context.Context, requirementID int64, workspace string) error {
	return r.Db.WithContext(ctx).Model(&BusinessRequirement{}).Where("id = ?", requirementID).Updates(map[string]any{
		"remote_workspace": workspace,
		"updated_time":     time.Now(),
	}).Error
}

// FailRunningRemoteConversation records a polling failure only while the
// exact turn is still running. A late failure response must not overwrite a
// concurrently finalized answer.
func (r *BusinessRepository) FailRunningRemoteConversation(ctx context.Context, requirementID int64, threadID, turnID, remoteError string) (bool, error) {
	result := r.Db.WithContext(ctx).Model(&BusinessRequirement{}).
		Where("id = ? AND remote_status = ? AND remote_thread_id = ? AND remote_turn_id = ?", requirementID, "running", threadID, turnID).
		Updates(map[string]any{
			"remote_status": "failed",
			"remote_error":  remoteError,
			"updated_time":  time.Now(),
		})
	return result.RowsAffected > 0, result.Error
}

// FinalizeRemoteConversation atomically claims a running remote turn and
// stores its final answer. The conditional state transition prevents two
// concurrent polling requests from creating duplicate assistant messages or
// duplicate document versions.
func (r *BusinessRepository) FinalizeRemoteConversation(ctx context.Context, input RemoteConversationFinalization) (bool, error) {
	now := time.Now()
	finalized := false
	err := r.Db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		claim := tx.Model(&BusinessRequirement{}).
			Where("id = ? AND biz_line = ? AND remote_status = ? AND remote_thread_id = ? AND remote_turn_id = ?",
				input.RequirementID, input.BizLine, "running", input.ExpectedThreadID, input.TurnID).
			Updates(map[string]any{
				"remote_status": "finalizing",
				"updated_time":  now,
			})
		if claim.Error != nil {
			return claim.Error
		}
		if claim.RowsAffected == 0 {
			return nil
		}
		finalized = true

		version := 1
		var latest BusinessRequirementDocument
		err := tx.Where("biz_line = ? AND requirement_id = ? AND type = ?", input.BizLine, input.RequirementID, "ai_intake").
			Order("version desc, id desc").First(&latest).Error
		if err == nil {
			version = latest.Version + 1
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}

		if err := tx.Create(&BusinessRequirementMessage{
			BizLine: input.BizLine, RequirementID: input.RequirementID, Role: "assistant", Content: input.Reply, CreatedTime: now,
		}).Error; err != nil {
			return err
		}
		if err := tx.Create(&BusinessRequirementDocument{
			BizLine: input.BizLine, RequirementID: input.RequirementID, Type: "ai_intake",
			Title: "AI 访谈整理 · " + input.Title, Content: input.Reply, Version: version, CreatedTime: now,
		}).Error; err != nil {
			return err
		}
		return tx.Model(&BusinessRequirement{}).Where("id = ? AND biz_line = ?", input.RequirementID, input.BizLine).Updates(map[string]any{
			"title":            input.Title,
			"detail":           input.Reply,
			"remote_thread_id": input.ThreadID,
			"remote_turn_id":   input.TurnID,
			"remote_status":    "idle",
			"remote_error":     "",
			"updated_time":     now,
		}).Error
	})
	return finalized, err
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

// CreateAttachments records uploads that are not bound to a message yet.
func (r *BusinessRepository) CreateAttachments(ctx context.Context, rows []*BusinessRequirementAttachment) error {
	if len(rows) == 0 {
		return nil
	}
	return r.Db.WithContext(ctx).Create(&rows).Error
}

// ListAttachments returns every attachment of one requirement, sent or not.
func (r *BusinessRepository) ListAttachments(ctx context.Context, bizLine string, requirementID int64) ([]*BusinessRequirementAttachment, error) {
	var rows []*BusinessRequirementAttachment
	err := r.Db.WithContext(ctx).Model(&BusinessRequirementAttachment{}).
		Where("biz_line = ? AND requirement_id = ?", bizLine, requirementID).
		Order("created_time asc, id asc").Find(&rows).Error
	return rows, err
}

// FindAttachment resolves one attachment inside its own requirement.
func (r *BusinessRepository) FindAttachment(ctx context.Context, bizLine string, requirementID int64, remoteID string) (*BusinessRequirementAttachment, error) {
	var row BusinessRequirementAttachment
	err := r.Db.WithContext(ctx).Model(&BusinessRequirementAttachment{}).
		Where("biz_line = ? AND requirement_id = ? AND remote_id = ?", bizLine, requirementID, remoteID).
		First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, errors.New("附件不存在")
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// BindAttachmentsToMessage attaches previously uploaded files to the message
// that carries them. Only rows that are still unsent may be bound, so the same
// upload cannot be re-attached to a second message.
func (r *BusinessRepository) BindAttachmentsToMessage(ctx context.Context, bizLine string, requirementID, messageID int64, remoteIDs []string) error {
	if len(remoteIDs) == 0 {
		return nil
	}
	result := r.Db.WithContext(ctx).Model(&BusinessRequirementAttachment{}).
		Where("biz_line = ? AND requirement_id = ? AND message_id = 0 AND remote_id IN ?", bizLine, requirementID, remoteIDs).
		Update("message_id", messageID)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != int64(len(remoteIDs)) {
		return errors.New("附件不存在或已被其他消息使用")
	}
	return nil
}
