package repository

import (
	"context"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func (r *GalaxyRepository) CreatePairingCode(ctx context.Context, row *GalaxyPairingCode) error {
	return r.Db.WithContext(ctx).Create(row).Error
}

// TakePairingCode 兑换配对码：一次性，只有未过期未兑换的那一行能被更新到。
// 用条件更新而不是「先查后写」，两台机器同时拿同一个码时只有一台成功。
func (r *GalaxyRepository) TakePairingCode(ctx context.Context, bizLine, code, nodeID string, now time.Time) (*GalaxyPairingCode, error) {
	result := r.Db.WithContext(ctx).Model(&GalaxyPairingCode{}).
		Where("biz_line = ?", bizLine).
		Where("code = ?", code).
		Where("consumed_at IS NULL").
		Where("expires_at > ?", now).
		Updates(map[string]any{"consumed_at": now, "node_id": nodeID})
	if result.Error != nil {
		return nil, result.Error
	}
	if result.RowsAffected == 0 {
		return nil, gorm.ErrRecordNotFound
	}
	var row GalaxyPairingCode
	err := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine).Where("code = ?", code).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *GalaxyRepository) SaveNode(ctx context.Context, row *GalaxyNode) error {
	return r.Db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "biz_line"}, {Name: "node_id"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"owner_user_id", "display_name", "token_hash", "bridge_version", "contract_version", "resources_json", "status", "last_beat_at", "updated_time",
		}),
	}).Create(row).Error
}

// FindNodeByTokenHash 是节点通道的鉴权入口：凭证认定的身份覆盖请求体里的任何节点字段。
func (r *GalaxyRepository) FindNodeByTokenHash(ctx context.Context, bizLine, tokenHash string) (*GalaxyNode, error) {
	var row GalaxyNode
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).
		Where("token_hash = ?", tokenHash).
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *GalaxyRepository) FindNode(ctx context.Context, bizLine, nodeID string) (*GalaxyNode, error) {
	var row GalaxyNode
	err := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine).Where("node_id = ?", nodeID).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *GalaxyRepository) ListNodesByOwner(ctx context.Context, bizLine, ownerUserID string) ([]*GalaxyNode, error) {
	var rows []*GalaxyNode
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).
		Where("owner_user_id = ?", ownerUserID).
		Order("created_time desc").Find(&rows).Error
	return rows, err
}

func (r *GalaxyRepository) TouchNode(ctx context.Context, bizLine, nodeID string, at time.Time) error {
	return r.Db.WithContext(ctx).Model(&GalaxyNode{}).
		Where("biz_line = ?", bizLine).Where("node_id = ?", nodeID).
		Updates(map[string]any{"last_beat_at": at, "status": "active"}).Error
}

func (r *GalaxyRepository) MarkNodeOffline(ctx context.Context, bizLine, nodeID string) error {
	return r.Db.WithContext(ctx).Model(&GalaxyNode{}).
		Where("biz_line = ?", bizLine).Where("node_id = ?", nodeID).
		Update("status", "offline").Error
}

// RevokeNode 撤销令牌。token_hash 置空后节点的下一次请求就是 401，它会停止重试。
func (r *GalaxyRepository) RevokeNode(ctx context.Context, bizLine, ownerUserID, nodeID string) error {
	return r.Db.WithContext(ctx).Model(&GalaxyNode{}).
		Where("biz_line = ?", bizLine).Where("owner_user_id = ?", ownerUserID).Where("node_id = ?", nodeID).
		Updates(map[string]any{"token_hash": "", "status": "revoked"}).Error
}

// ---------- 同意记录 ----------

func (r *GalaxyRepository) SaveConsent(ctx context.Context, row *GalaxyConsentRecord) error {
	return r.Db.WithContext(ctx).Create(row).Error
}

// LatestConsent 取某主体对某条款版本的最新一条同意。条款升版后旧同意不再命中。
func (r *GalaxyRepository) LatestConsent(ctx context.Context, bizLine, subjectType, userID, termsVersion string) (*GalaxyConsentRecord, error) {
	var row GalaxyConsentRecord
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).
		Where("subject_type = ?", subjectType).
		Where("user_id = ?", userID).
		Where("terms_version = ?", termsVersion).
		Order("accepted_at desc").First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// ListNodes 平台视角的全部节点。运营后台用，按最近心跳排序：
// 排障时最关心的永远是「刚刚还在、现在没了」那几台。
func (r *GalaxyRepository) ListNodes(ctx context.Context, bizLine string, limit int) ([]*GalaxyNode, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	var rows []*GalaxyNode
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).
		Order("last_beat_at desc, id desc").Limit(limit).Find(&rows).Error
	return rows, err
}

// SetNodeBanned 平台封禁 / 解封。撤销令牌是主人自己也能做的事，封禁不是。
func (r *GalaxyRepository) SetNodeBanned(ctx context.Context, bizLine, nodeID string, banned bool) error {
	return r.Db.WithContext(ctx).Model(&GalaxyNode{}).
		Where("biz_line = ?", bizLine).Where("node_id = ?", nodeID).
		Update("banned", banned).Error
}
