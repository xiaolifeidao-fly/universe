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
				// input_price / output_price / cache_price / cache_write_price 这四列
				// 已经被 20260920_galaxy_model_drop_display_price.sql 删掉了
				// （单价只剩 zt_galaxy_price 一个出处）。名字留在这里的后果不是
				// 「多更新一列」，是**每一次保存模型都报 1054 Unknown column** ——
				// 运营在模型目录上点一次保存就失败，而错误信息指向一个他没填过的字段。
				"list_input_price", "list_output_price", "list_cache_price", "currency",
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

// ---------- 模型分组 ----------

// ListModelGroups 分组目录。modelID 为空表示不限；listedOnly 只要上架的。
//
// 这张表很小（一个模型几个分组），所以一律整份取回、在内存里挑 —— 取价、
// 密钥候选、共享设置、派单前的策略解析都要它，按条点查会把同一批行查几十遍。
func (r *GalaxyRepository) ListModelGroups(ctx context.Context, bizLine, modelID string, listedOnly bool) ([]*GalaxyModelGroup, error) {
	tx := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine)
	if modelID != "" {
		tx = tx.Where("model_id = ?", modelID)
	}
	if listedOnly {
		tx = tx.Where("listed = ?", true)
	}
	var rows []*GalaxyModelGroup
	err := tx.Order("model_id, sort_order, name").Find(&rows).Error
	return rows, err
}

func (r *GalaxyRepository) FindModelGroup(ctx context.Context, bizLine, groupID string) (*GalaxyModelGroup, error) {
	var row GalaxyModelGroup
	err := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine).Where("group_id = ?", groupID).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// SaveModelGroup 新增或改一个分组。
//
// 默认分组在同一个事务里收口：一个模型只能有一个默认分组（uk_gx_model_group_default
// 靠 NULL 不参与唯一性来保证），所以要先把同模型下别的行降下来，再把这一行升上去。
// 两步分开做的话，中间那一瞬两行都是默认，唯一键会直接把这次保存打回去。
func (r *GalaxyRepository) SaveModelGroup(ctx context.Context, row *GalaxyModelGroup) error {
	listed, isDefault := row.Listed, row.Default()
	return r.Tx(ctx, func(tx *GalaxyRepository) error {
		if isDefault {
			if err := tx.Db.WithContext(ctx).Model(&GalaxyModelGroup{}).
				Where("biz_line = ?", row.BizLine).Where("model_id = ?", row.ModelID).
				Where("group_id <> ?", row.GroupID).
				UpdateColumn("is_default", nil).Error; err != nil {
				return err
			}
		}
		if err := tx.Db.WithContext(ctx).Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: "biz_line"}, {Name: "group_id"}},
			DoUpdates: clause.AssignmentColumns([]string{
				"model_id", "name", "summary", "efforts_json", "allow_fast",
				"listed", "is_default", "sort_order", "updated_time",
			}),
		}).Create(row).Error; err != nil {
			return err
		}
		// listed 与 is_default 的默认值分别是 true / NULL，落回「下架」「不是默认」
		// 时不单独写一次就存不进去（同 SaveModel 里那一行的理由）。
		return tx.Db.WithContext(ctx).Model(&GalaxyModelGroup{}).
			Where("biz_line = ?", row.BizLine).Where("group_id = ?", row.GroupID).
			UpdateColumns(map[string]any{"listed": listed, "is_default": row.IsDefault}).Error
	})
}

// DeleteModelGroup 删一个分组，连同它名下的价目行。
//
// 价一起删是有意的：分组没了，那些行就再也匹配不上任何一次请求，
// 留在表里只会让「有价」这件事在运营台上显示成真的。
func (r *GalaxyRepository) DeleteModelGroup(ctx context.Context, bizLine, groupID string) error {
	return r.Tx(ctx, func(tx *GalaxyRepository) error {
		if err := tx.DeletePricesOfGroup(ctx, bizLine, groupID); err != nil {
			return err
		}
		return tx.Db.WithContext(ctx).
			Where("biz_line = ?", bizLine).Where("group_id = ?", groupID).
			Delete(&GalaxyModelGroup{}).Error
	})
}

// CountKeysUsingGroup 还有几把**没失效**的密钥选中了这个分组。
//
// 删分组之前要问一次：把一个还在用的分组删掉，那些密钥的每一次请求都会落到
// 「选了一个不存在的分组」上 —— 而那既不是钱的问题也不是权限问题，排查起来
// 只看得到一条「模型不允许」。JSON 数组用 LIKE 匹配带引号的整串，避免
// mg_AB 匹配上 mg_ABCD。
func (r *GalaxyRepository) CountKeysUsingGroup(ctx context.Context, bizLine, groupID string) (int64, error) {
	var count int64
	err := r.Db.WithContext(ctx).Model(&GalaxyConsumerKey{}).
		Where("biz_line = ?", bizLine).
		Where("status = ?", "active").
		Where("groups_json LIKE ?", "%\""+groupID+"\"%").
		Count(&count).Error
	return count, err
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
