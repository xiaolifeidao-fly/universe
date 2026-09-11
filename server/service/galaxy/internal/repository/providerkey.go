package repository

import (
	"context"
	"time"

	"gorm.io/gorm"
)

// 提供者接入密钥的持久化。与算力密钥（consumer.go）形状一致：
// 明文只在签发那一刻返回一次，这里只认 sha256。

func (r *GalaxyRepository) CreateProviderKey(ctx context.Context, row *GalaxyProviderKey) error {
	return r.Db.WithContext(ctx).Create(row).Error
}

// FindProviderKeyByHash 注册接口的鉴权入口。吊销后 status 变 revoked，
// 这里照样查得到 —— 由调用方分辨「密钥不存在」和「密钥已吊销」，
// 两句提示对拿着一把旧密钥的人是完全不同的处置建议。
func (r *GalaxyRepository) FindProviderKeyByHash(ctx context.Context, bizLine, keyHash string) (*GalaxyProviderKey, error) {
	var row GalaxyProviderKey
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).
		Where("key_hash = ?", keyHash).
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *GalaxyRepository) ListProviderKeysByOwner(ctx context.Context, bizLine, ownerUserID string) ([]*GalaxyProviderKey, error) {
	var rows []*GalaxyProviderKey
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).
		Where("owner_user_id = ?", ownerUserID).
		Order("created_time desc").Find(&rows).Error
	return rows, err
}

// RevokeProviderKey 吊销。key_hash 一并置空：留着它，一把已经吊销的密钥仍然能
// 命中唯一索引，主人想用同一串明文重新签发时会撞 1062。
func (r *GalaxyRepository) RevokeProviderKey(ctx context.Context, bizLine, ownerUserID, keyID string) error {
	result := r.Db.WithContext(ctx).Model(&GalaxyProviderKey{}).
		Where("biz_line = ?", bizLine).
		Where("owner_user_id = ?", ownerUserID).
		Where("key_id = ?", keyID).
		Updates(map[string]any{"status": "revoked", "key_hash": ""})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

// TouchProviderKey 记一次成功的注册。失败一律不记 —— 「最近一次使用」是给主人
// 判断「这把密钥还有谁在用」的，把失败的尝试也算进去会让它永远显示成活跃的。
func (r *GalaxyRepository) TouchProviderKey(ctx context.Context, bizLine, keyID, nodeID string, at time.Time) error {
	return r.Db.WithContext(ctx).Model(&GalaxyProviderKey{}).
		Where("biz_line = ?", bizLine).Where("key_id = ?", keyID).
		Updates(map[string]any{"last_used_at": at, "last_node_id": nodeID}).Error
}
