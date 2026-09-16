package repository

import (
	"context"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func (r *GalaxyRepository) SavePackage(ctx context.Context, row *GalaxyPackage) error {
	listed := row.Listed
	return r.Tx(ctx, func(tx *GalaxyRepository) error {
		if err := tx.Db.WithContext(ctx).Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: "biz_line"}, {Name: "package_code"}},
			DoUpdates: clause.AssignmentColumns([]string{
				"title", "units_json", "amount", "currency", "ttl_days",
				"allowed_kinds_json", "model_tier_json", "concurrency", "rpm", "model_id", "listed", "sort_order", "updated_time",
			}),
		}).Create(row).Error; err != nil {
			return err
		}
		return tx.writeListed(ctx, &GalaxyPackage{}, "package_code", row.BizLine, row.PackageCode, listed)
	})
}

// writeListed 把上下架单独再写一次。
//
// listed 的标签默认值是 true：GORM 建记录时会把值为 false 的字段换成标签里的默认值再插入
// （还顺手把结构体上的值改掉），upsert 的 VALUES(listed) 于是也是 true —— 「下架」保存成功、库里却还是上架。
// 这个坑从有下架那天就在，套餐和模型目录都踩着。
func (r *GalaxyRepository) writeListed(ctx context.Context, model any, keyColumn, bizLine, key string, listed bool) error {
	return r.Db.WithContext(ctx).Model(model).
		Where("biz_line = ?", bizLine).Where(keyColumn+" = ?", key).
		UpdateColumn("listed", listed).Error
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

// ---------- 订单：运营侧 ----------

// AdminOrderQuery 运营翻全站订单的过滤条件。
//
// 和 ListOrders 的「只看某个人」是两件事，所以另起一个查询而不是给它加参数：
// 一个必填的过滤维度变成可选，调用方漏填就会静默地把全站的单子都列出来。
type AdminOrderQuery struct {
	BizLine string
	Status  string
	UserID  string
	// Keyword 按单号、下单人、渠道流水号模糊找。人工确认到账时手上只有一个流水号，
	// 而单号在对方那边 —— 不能按流水号找，那笔钱就对不回任何一张单。
	Keyword string
	Offset  int
	Limit   int
}

func (r *GalaxyRepository) adminOrderScope(query AdminOrderQuery) *gorm.DB {
	tx := r.Db.Model(&GalaxyOrder{}).Where("biz_line = ?", query.BizLine)
	if query.Status != "" {
		tx = tx.Where("status = ?", query.Status)
	}
	if query.UserID != "" {
		tx = tx.Where("user_id = ?", query.UserID)
	}
	if query.Keyword != "" {
		like := "%" + query.Keyword + "%"
		tx = tx.Where("order_id LIKE ? OR user_id LIKE ? OR payment_ref LIKE ?", like, like, like)
	}
	return tx
}

func (r *GalaxyRepository) ListAdminOrders(ctx context.Context, query AdminOrderQuery) ([]*GalaxyOrder, int64, error) {
	var total int64
	if err := r.adminOrderScope(query).WithContext(ctx).Count(&total).Error; err != nil {
		return nil, 0, err
	}
	tx := r.adminOrderScope(query).WithContext(ctx).Order("created_time desc, id desc")
	if query.Limit > 0 {
		tx = tx.Limit(query.Limit).Offset(query.Offset)
	}
	var rows []*GalaxyOrder
	err := tx.Find(&rows).Error
	return rows, total, err
}

// CountOrdersByStatus 各状态各有多少单。列表顶上那排数字用它，一次查完。
func (r *GalaxyRepository) CountOrdersByStatus(ctx context.Context, bizLine string) (map[string]int64, error) {
	var rows []struct {
		Status string
		Total  int64
	}
	err := r.Db.WithContext(ctx).Model(&GalaxyOrder{}).
		Where("biz_line = ?", bizLine).
		Select("status, COUNT(*) AS total").Group("status").Scan(&rows).Error
	counts := map[string]int64{}
	for _, row := range rows {
		counts[row.Status] = row.Total
	}
	return counts, err
}
