package repository

import (
	"context"

	"gorm.io/gorm"
)

// 商品与订单：**只剩读**。额度包已经下架，不会再有新的商品或订单 ——
// 建单、支付、履约、余额转移那一整套跟着删了，留下的是运营翻历史订单要的那两条查询。

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

// ---------- 订单：运营侧 ----------

// AdminOrderQuery 运营翻全站订单的过滤条件。
type AdminOrderQuery struct {
	BizLine string
	Status  string
	UserID  string
	// Keyword 按单号、下单人、渠道流水号模糊找 —— 运营手上常常只有渠道那边的一串号。
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
