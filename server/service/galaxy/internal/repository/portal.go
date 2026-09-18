package repository

import (
	"context"
	"time"

	"gorm.io/gorm/clause"
)

// 门户（未登录可见的那一面）要的两张表：对外模型目录、联系我们线索。

// ---------- 模型目录 ----------

func (r *GalaxyRepository) ListModels(ctx context.Context, bizLine string, listedOnly bool) ([]*GalaxyModel, error) {
	tx := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine)
	if listedOnly {
		tx = tx.Where("listed = ?", true)
	}
	var rows []*GalaxyModel
	err := tx.Order("sort_order, model_id").Find(&rows).Error
	return rows, err
}

func (r *GalaxyRepository) SaveModel(ctx context.Context, row *GalaxyModel) error {
	listed := row.Listed
	return r.Tx(ctx, func(tx *GalaxyRepository) error {
		if err := tx.Db.WithContext(ctx).Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: "biz_line"}, {Name: "model_id"}},
			DoUpdates: clause.AssignmentColumns([]string{
				"display_name", "vendor", "family", "kind",
				"context_tokens", "max_output_tokens",
				"input_price", "output_price", "cache_price", "cache_write_price",
				"list_input_price", "list_output_price", "currency",
				"tags_json", "summary", "badge_text", "badge_tone",
				"referral_bps", "listed", "featured", "sort_order", "updated_time",
			}),
		}).Create(row).Error; err != nil {
			return err
		}
		// 同 SavePackage：listed 的默认值是 true，false 不单独写一次就存不进去。
		return tx.writeListed(ctx, &GalaxyModel{}, "model_id", row.BizLine, row.ModelID, listed)
	})
}

func (r *GalaxyRepository) FindModel(ctx context.Context, bizLine, modelID string) (*GalaxyModel, error) {
	var row GalaxyModel
	err := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine).Where("model_id = ?", modelID).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *GalaxyRepository) DeleteModel(ctx context.Context, bizLine, modelID string) error {
	return r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("model_id = ?", modelID).
		Delete(&GalaxyModel{}).Error
}

// ---------- 联系我们 ----------

func (r *GalaxyRepository) CreateLead(ctx context.Context, row *GalaxyLead) error {
	return r.Db.WithContext(ctx).Create(row).Error
}

// CountLeadsFromIP 同一 IP 在某个时间窗内提交了几条。
//
// 限流放在库里而不是进程内存里：门户是无状态的，多实例部署时进程内计数各算各的，
// 等于把窗口乘以实例数。这条查询走 idx_gx_lead_ip，代价是一次索引扫描。
func (r *GalaxyRepository) CountLeadsFromIP(ctx context.Context, bizLine, ip string, since time.Time) (int64, error) {
	var count int64
	err := r.Db.WithContext(ctx).Model(&GalaxyLead{}).
		Where("biz_line = ?", bizLine).Where("ip = ?", ip).Where("created_time >= ?", since).
		Count(&count).Error
	return count, err
}

func (r *GalaxyRepository) ListLeads(ctx context.Context, bizLine, status string, offset, limit int) ([]*GalaxyLead, int64, error) {
	tx := r.Db.WithContext(ctx).Model(&GalaxyLead{}).Where("biz_line = ?", bizLine)
	if status != "" {
		tx = tx.Where("status = ?", status)
	}
	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []*GalaxyLead
	err := tx.Order("created_time desc").Offset(offset).Limit(limit).Find(&rows).Error
	return rows, total, err
}

func (r *GalaxyRepository) UpdateLeadStatus(ctx context.Context, bizLine, leadID, status, handledBy string, at time.Time) error {
	return r.Db.WithContext(ctx).Model(&GalaxyLead{}).
		Where("biz_line = ?", bizLine).Where("lead_id = ?", leadID).
		Updates(map[string]any{"status": status, "handled_by": handledBy, "handled_at": at}).Error
}
