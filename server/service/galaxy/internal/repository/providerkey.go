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
// key_hash 原样留着，这里照样查得到 —— 由调用方分辨「密钥不存在」和
// 「密钥已吊销」，两句提示对拿着一把旧密钥的人是完全不同的处置建议。
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

// RevokeProviderKey 吊销。只翻 status，key_hash 一个字都不动。
//
// 抹掉 hash 看着像是「吊销了就别留着」，实际会砸掉两件事。一是 1062：
// uk_gx_provider_key_hash 是 (biz_line, key_hash) 上的唯一索引，把吊销的行统统
// 置成空串，等于让它们去抢同一个 ('galaxy',”) —— 第一把吊销得掉，第二把就撞死，
// 主人的密钥列表里从此有一把吊不掉的密钥。二是上面 FindProviderKeyByHash 那条
// 路：hash 没了就查不到这一行，拿着旧密钥的机器只会收到「接入密钥无效」，
// 而它真正需要听到的是「已经被吊销了，去控制台重新签发一把」—— 一句让人怀疑
// 自己抄错了，一句才指向真正该做的事。
//
// 那条注释担心的「主人拿同一串明文重新签发会撞 1062」不会发生：明文是签发时
// randomToken(24) 当场摇出来的，接口不收主人指定的值，192 位随机撞不上。
func (r *GalaxyRepository) RevokeProviderKey(ctx context.Context, bizLine, ownerUserID, keyID string) error {
	result := r.Db.WithContext(ctx).Model(&GalaxyProviderKey{}).
		Where("biz_line = ?", bizLine).
		Where("owner_user_id = ?", ownerUserID).
		Where("key_id = ?", keyID).
		Updates(map[string]any{"status": "revoked"})
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
