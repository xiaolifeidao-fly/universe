package repository

import (
	"context"
	"errors"
	"strings"
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
	// DocumentTitle names the document this turn produces, and doubles as the
	// switch for producing one at all: an ordinary interview turn leaves it
	// empty and only appends its reply to the chat. A conversation therefore
	// carries exactly one document, written when the business user confirms it.
	DocumentTitle string
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

// StartRemoteConversation marks a turn as running and records what it was
// asked to produce. Mode is written only here: the poll that finalizes the
// turn runs in a different request and has nothing else to read it from.
func (r *BusinessRepository) StartRemoteConversation(ctx context.Context, requirementID int64, threadID, turnID, mode string) error {
	return r.Db.WithContext(ctx).Model(&BusinessRequirement{}).Where("id = ?", requirementID).Updates(map[string]any{
		"remote_thread_id": threadID,
		"remote_turn_id":   turnID,
		"remote_status":    "running",
		"remote_error":     "",
		"remote_mode":      mode,
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
// writing the document twice.
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

		if err := tx.Create(&BusinessRequirementMessage{
			BizLine: input.BizLine, RequirementID: input.RequirementID, Role: "assistant", Content: input.Reply, CreatedTime: now,
		}).Error; err != nil {
			return err
		}
		if strings.TrimSpace(input.DocumentTitle) != "" {
			if err := writeIntakeDocument(tx, input, now); err != nil {
				return err
			}
		}
		return tx.Model(&BusinessRequirement{}).Where("id = ? AND biz_line = ?", input.RequirementID, input.BizLine).Updates(map[string]any{
			"title":            input.Title,
			"detail":           input.Reply,
			"remote_thread_id": input.ThreadID,
			"remote_turn_id":   input.TurnID,
			"remote_status":    "idle",
			"remote_error":     "",
			"remote_mode":      "",
			"updated_time":     now,
		}).Error
	})
	return finalized, err
}

// writeIntakeDocument keeps one intake document per conversation. Confirming
// again is a rewrite, not a new version: the business user asked for a single
// document, and a second row would immediately reopen the "which one is
// current" question the single document exists to close.
//
// The version column is still bumped, because it is part of the row's unique
// index and reviewing how often a conversation was re-confirmed is cheap to
// keep. Legacy rows written per turn stay untouched below the newest one; the
// conversation read only ever surfaces that newest row.
func writeIntakeDocument(tx *gorm.DB, input RemoteConversationFinalization, now time.Time) error {
	var latest BusinessRequirementDocument
	err := tx.Where("biz_line = ? AND requirement_id = ? AND type = ?", input.BizLine, input.RequirementID, "ai_intake").
		Order("version desc, id desc").First(&latest).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return tx.Create(&BusinessRequirementDocument{
			BizLine: input.BizLine, RequirementID: input.RequirementID, Type: "ai_intake",
			Title: input.DocumentTitle, Content: input.Reply, Version: 1, CreatedTime: now,
		}).Error
	}
	if err != nil {
		return err
	}
	return tx.Model(&BusinessRequirementDocument{}).Where("id = ?", latest.ID).Updates(map[string]any{
		"title":        input.DocumentTitle,
		"content":      input.Reply,
		"version":      latest.Version + 1,
		"created_time": now,
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

// FindLatestDocument returns the one document a conversation carries, or nil
// when the business user has not confirmed one yet. Conversations created
// before the per-turn document was dropped still hold their old rows, so the
// read is "newest wins" rather than "there is only ever one row".
func (r *BusinessRepository) FindLatestDocument(ctx context.Context, bizLine string, requirementID int64) (*BusinessRequirementDocument, error) {
	var row BusinessRequirementDocument
	err := r.Db.WithContext(ctx).Where("biz_line = ? AND requirement_id = ?", bizLine, requirementID).
		Order("version desc, id desc").First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// 明确列出投影的列：`document.*` 里的 biz_line / type 用不到，而 title 在两张表
// 里同名，靠通配符选出来会被 r.title 覆盖。
const programDocumentColumns = `zt_business_requirement_document.id AS id,
	zt_business_requirement_document.requirement_id AS requirement_id,
	zt_business_requirement_document.title AS title,
	zt_business_requirement_document.content AS content,
	zt_business_requirement_document.version AS version,
	zt_business_requirement_document.created_time AS created_time,
	r.title AS requirement_title`

// ProgramDocument is one @-able document plus the interview it came from.
// It is a flat projection on purpose: embedding the document row would make the
// join's extra column depend on GORM's embedded-struct scanning rules.
type ProgramDocument struct {
	ID               int64     `gorm:"column:id"`
	RequirementID    int64     `gorm:"column:requirement_id"`
	RequirementTitle string    `gorm:"column:requirement_title"`
	Title            string    `gorm:"column:title"`
	Content          string    `gorm:"column:content"`
	Version          int       `gorm:"column:version"`
	CreatedTime      time.Time `gorm:"column:created_time"`
}

// ProgramDocumentQuery selects earlier interview documents of one project.
// ExcludeRequirementID drops the conversation the user is currently in: its own
// documents are already part of that thread and are noise in the @ picker.
//
// CreatorID is required. The workbench only ever shows a business user their
// own intake, so the @ picker must not become a side channel into another
// user's interviews in the same project.
type ProgramDocumentQuery struct {
	BizLine              string
	ProgramID            int64
	CreatorID            string
	ExcludeRequirementID int64
	Keyword              string
	Limit                int
}

// ListProgramDocuments returns the latest interview documents of one project,
// newest first. Only the newest version of each requirement/type is offered:
// attaching an outdated revision of the same document is almost never what the
// business user means by "the document from that conversation".
func (r *BusinessRepository) ListProgramDocuments(ctx context.Context, query ProgramDocumentQuery) ([]*ProgramDocument, error) {
	limit := query.Limit
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	db := r.Db.WithContext(ctx).
		Model(&BusinessRequirementDocument{}).
		Select(programDocumentColumns).
		Joins("JOIN zt_business_requirement r ON r.id = zt_business_requirement_document.requirement_id AND r.biz_line = zt_business_requirement_document.biz_line").
		Where("zt_business_requirement_document.biz_line = ? AND r.program_id = ? AND r.created_by = ?", query.BizLine, query.ProgramID, query.CreatorID).
		// 只留每个需求+类型的最高版本，避免同一份文档的十几个历史版本挤满候选列表。
		Where(`zt_business_requirement_document.version = (
			SELECT MAX(d2.version) FROM zt_business_requirement_document d2
			WHERE d2.biz_line = zt_business_requirement_document.biz_line
			  AND d2.requirement_id = zt_business_requirement_document.requirement_id
			  AND d2.type = zt_business_requirement_document.type)`)
	if query.ExcludeRequirementID > 0 {
		db = db.Where("zt_business_requirement_document.requirement_id <> ?", query.ExcludeRequirementID)
	}
	if keyword := strings.TrimSpace(query.Keyword); keyword != "" {
		like := "%" + keyword + "%"
		db = db.Where("zt_business_requirement_document.title LIKE ? OR r.title LIKE ?", like, like)
	}
	var rows []*ProgramDocument
	if err := db.Order("zt_business_requirement_document.created_time desc").Limit(limit).Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// FindProgramDocuments resolves @-attached documents back to their content.
// It re-applies the project and creator scope rather than trusting the ids the
// browser sent: a forged id must not read another project's or another user's
// interview into this prompt.
func (r *BusinessRepository) FindProgramDocuments(ctx context.Context, bizLine string, programID int64, creatorID string, ids []int64) ([]*ProgramDocument, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	var rows []*ProgramDocument
	err := r.Db.WithContext(ctx).
		Model(&BusinessRequirementDocument{}).
		Select(programDocumentColumns).
		Joins("JOIN zt_business_requirement r ON r.id = zt_business_requirement_document.requirement_id AND r.biz_line = zt_business_requirement_document.biz_line").
		Where("zt_business_requirement_document.biz_line = ? AND r.program_id = ? AND r.created_by = ? AND zt_business_requirement_document.id IN ?", bizLine, programID, creatorID, ids).
		Order("zt_business_requirement_document.created_time asc").
		Find(&rows).Error
	if err != nil {
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
