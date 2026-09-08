package repository

import (
	"context"
	"time"

	"gorm.io/gorm/clause"
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

func (r *GalaxyRepository) UpsertBalance(ctx context.Context, rows []*GalaxyConsumerBalance) error {
	if len(rows) == 0 {
		return nil
	}
	return r.Db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "biz_line"}, {Name: "key_id"}, {Name: "unit"}},
		DoUpdates: clause.Assignments(map[string]any{"balance": clause.Expr{SQL: "zt_galaxy_consumer_balance.balance + VALUES(balance)"}}),
	}).Create(rows).Error
}

func (r *GalaxyRepository) ListBalances(ctx context.Context, bizLine, keyID string) ([]*GalaxyConsumerBalance, error) {
	var rows []*GalaxyConsumerBalance
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("key_id = ?", keyID).
		Order("unit").Find(&rows).Error
	return rows, err
}

// ConsumeBalance 扣减余额。条件更新保证不会扣成负数：影响行数为 0 即余额不足。
func (r *GalaxyRepository) ConsumeBalance(ctx context.Context, bizLine, keyID, unit string, amount int64) (bool, error) {
	if amount <= 0 {
		return true, nil
	}
	result := r.Db.WithContext(ctx).Model(&GalaxyConsumerBalance{}).
		Where("biz_line = ?", bizLine).Where("key_id = ?", keyID).Where("unit = ?", unit).
		Where("balance >= ?", amount).
		Update("balance", clause.Expr{SQL: "balance - ?", Vars: []any{amount}})
	if result.Error != nil {
		return false, result.Error
	}
	return result.RowsAffected > 0, nil
}
