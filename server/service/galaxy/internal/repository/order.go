package repository

import (
	"context"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func (r *GalaxyRepository) SavePackage(ctx context.Context, row *GalaxyPackage) error {
	return r.Db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "biz_line"}, {Name: "package_code"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"title", "units_json", "amount", "currency", "ttl_days",
			"allowed_kinds_json", "model_tier_json", "concurrency", "rpm", "listed", "sort_order", "updated_time",
		}),
	}).Create(row).Error
}

func (r *GalaxyRepository) ListPackages(ctx context.Context, bizLine string, listedOnly bool) ([]*GalaxyPackage, error) {
	tx := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine)
	if listedOnly {
		tx = tx.Where("listed = ?", true)
	}
	var rows []*GalaxyPackage
	err := tx.Order("sort_order, package_code").Find(&rows).Error
	return rows, err
}

func (r *GalaxyRepository) FindPackage(ctx context.Context, bizLine, code string) (*GalaxyPackage, error) {
	var row GalaxyPackage
	err := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine).Where("package_code = ?", code).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *GalaxyRepository) CreateOrder(ctx context.Context, row *GalaxyOrder) error {
	return r.Db.WithContext(ctx).Create(row).Error
}

func (r *GalaxyRepository) FindOrder(ctx context.Context, bizLine, orderID string) (*GalaxyOrder, error) {
	var row GalaxyOrder
	err := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine).Where("order_id = ?", orderID).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *GalaxyRepository) ListOrders(ctx context.Context, bizLine, userID string, limit int) ([]*GalaxyOrder, error) {
	tx := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine)
	if userID != "" {
		tx = tx.Where("user_id = ?", userID)
	}
	if limit > 0 {
		tx = tx.Limit(limit)
	}
	var rows []*GalaxyOrder
	err := tx.Order("created_time desc, id desc").Find(&rows).Error
	return rows, err
}

// MarkOrderPaid 把订单从 pending 推到 paid。条件更新保证支付回调可以安全重放：
// 第二次回调影响 0 行，调用方据此跳过重复履约。
func (r *GalaxyRepository) MarkOrderPaid(ctx context.Context, bizLine, orderID, paymentRef string, paidAt time.Time) (bool, error) {
	result := r.Db.WithContext(ctx).Model(&GalaxyOrder{}).
		Where("biz_line = ?", bizLine).Where("order_id = ?", orderID).Where("status = ?", "pending").
		Updates(map[string]any{"status": "paid", "payment_ref": paymentRef, "paid_at": paidAt})
	if result.Error != nil {
		return false, result.Error
	}
	return result.RowsAffected > 0, nil
}

// MarkOrderFulfilled 把订单推到 fulfilled 并记下落到哪把密钥。
// 同样用条件更新：并发的两次履约只有一次能成功。
func (r *GalaxyRepository) MarkOrderFulfilled(ctx context.Context, bizLine, orderID, keyID string, at time.Time) (bool, error) {
	result := r.Db.WithContext(ctx).Model(&GalaxyOrder{}).
		Where("biz_line = ?", bizLine).Where("order_id = ?", orderID).Where("status = ?", "paid").
		Updates(map[string]any{"status": "fulfilled", "key_id": keyID, "fulfilled_at": at})
	if result.Error != nil {
		return false, result.Error
	}
	return result.RowsAffected > 0, nil
}

func (r *GalaxyRepository) CancelOrder(ctx context.Context, bizLine, userID, orderID string) error {
	result := r.Db.WithContext(ctx).Model(&GalaxyOrder{}).
		Where("biz_line = ?", bizLine).Where("user_id = ?", userID).
		Where("order_id = ?", orderID).Where("status = ?", "pending").
		Update("status", "cancelled")
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

// TransferBalances 把一把密钥的余额整体搬到另一把。续期换发要它是原子的：
// 中途失败会让余额凭空消失或者凭空多出一份。
func (r *GalaxyRepository) TransferBalances(ctx context.Context, bizLine, fromKeyID, toKeyID string) ([]*GalaxyConsumerBalance, error) {
	var moved []*GalaxyConsumerBalance
	err := r.Tx(ctx, func(tx *GalaxyRepository) error {
		rows, err := tx.ListBalances(ctx, bizLine, fromKeyID)
		if err != nil {
			return err
		}
		for _, row := range rows {
			if row.Balance <= 0 {
				continue
			}
			if err := tx.Db.WithContext(ctx).Clauses(clause.OnConflict{
				Columns:   []clause.Column{{Name: "biz_line"}, {Name: "key_id"}, {Name: "unit"}},
				DoUpdates: clause.Assignments(map[string]any{"balance": clause.Expr{SQL: "zt_galaxy_consumer_balance.balance + VALUES(balance)"}}),
			}).Create(&GalaxyConsumerBalance{
				BizLine: bizLine, KeyID: toKeyID, Unit: row.Unit, Balance: row.Balance,
			}).Error; err != nil {
				return err
			}
			if err := tx.Db.WithContext(ctx).Model(&GalaxyConsumerBalance{}).
				Where("biz_line = ?", bizLine).Where("key_id = ?", fromKeyID).Where("unit = ?", row.Unit).
				Update("balance", 0).Error; err != nil {
				return err
			}
			moved = append(moved, row)
		}
		return nil
	})
	return moved, err
}
