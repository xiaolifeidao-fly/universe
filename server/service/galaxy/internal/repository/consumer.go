package repository

import (
	"context"
	"time"
)

func (r *GalaxyRepository) CreateConsumerKey(ctx context.Context, row *GalaxyConsumerKey) error {
	return r.Db.WithContext(ctx).Create(row).Error
}

// FindConsumerKeyByHash 是消费者鉴权入口。只按哈希查，明文永不入库、不入日志。
func (r *GalaxyRepository) FindConsumerKeyByHash(ctx context.Context, bizLine, keyHash string) (*GalaxyConsumerKey, error) {
	var row GalaxyConsumerKey
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("key_hash = ?", keyHash).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *GalaxyRepository) FindConsumerKey(ctx context.Context, bizLine, keyID string) (*GalaxyConsumerKey, error) {
	var row GalaxyConsumerKey
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("key_id = ?", keyID).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *GalaxyRepository) ListConsumerKeys(ctx context.Context, bizLine, ownerUserID string) ([]*GalaxyConsumerKey, error) {
	var rows []*GalaxyConsumerKey
	tx := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine)
	if ownerUserID != "" {
		tx = tx.Where("owner_user_id = ?", ownerUserID)
	}
	err := tx.Order("created_time desc").Find(&rows).Error
	return rows, err
}

func (r *GalaxyRepository) UpdateConsumerKey(ctx context.Context, bizLine, keyID string, values map[string]any) error {
	return r.Db.WithContext(ctx).Model(&GalaxyConsumerKey{}).
		Where("biz_line = ?", bizLine).Where("key_id = ?", keyID).
		Updates(values).Error
}

// ExpireConsumerKeys 到期转冻结。放在巡检里跑，不依赖请求触发 ——
// 一把长期不用的密钥也必须按时失效。
func (r *GalaxyRepository) ExpireConsumerKeys(ctx context.Context, bizLine string, now time.Time, freezeFor time.Duration) (int64, error) {
	result := r.Db.WithContext(ctx).Model(&GalaxyConsumerKey{}).
		Where("biz_line = ?", bizLine).
		Where("status = ?", "active").
		Where("expires_at <= ?", now).
		Updates(map[string]any{"status": "expired", "frozen_until": now.Add(freezeFor)})
	return result.RowsAffected, result.Error
}

// ---------- 余额 ----------
//
// zt_galaxy_consumer_balance 是额度包那一版的东西：额度按 (密钥, 模型, 计量单位) 挂在
// 密钥上。改成按账户积分余额逐笔扣费之后，这张表上没有任何读写了 —— 表和数据留着可查，
// 但不再有仓储方法：留着一组没人调的写方法，下次有人顺手用上就又分叉出第二套额度。
