package repository

import (
	"context"
	"time"

	"gorm.io/gorm/clause"
)

// ReplaceContributions 是 hello 的持久化语义：全量替换该节点申报的贡献集合。
// 没有再申报的贡献置为 disabled 而不是删除 —— 历史用量与账本还引用着它的 cid。
func (r *GalaxyRepository) ReplaceContributions(ctx context.Context, bizLine, nodeID string, rows []*GalaxyContribution, grants map[string][]*GalaxyQuotaGrant) error {
	return r.Tx(ctx, func(tx *GalaxyRepository) error {
		keep := make([]string, 0, len(rows))
		for _, row := range rows {
			keep = append(keep, row.CID)
		}
		disable := tx.Db.WithContext(ctx).Model(&GalaxyContribution{}).
			Where("biz_line = ?", bizLine).Where("node_id = ?", nodeID)
		if len(keep) > 0 {
			disable = disable.Where("cid NOT IN ?", keep)
		}
		if err := disable.Update("status", "disabled").Error; err != nil {
			return err
		}
		for _, row := range rows {
			if err := tx.Db.WithContext(ctx).Clauses(clause.OnConflict{
				Columns: []clause.Column{{Name: "biz_line"}, {Name: "cid"}},
				DoUpdates: clause.AssignmentColumns([]string{
					"node_id", "owner_user_id", "kind", "kind_version", "provider",
					"models_allow_json", "models_deny_json", "seats", "seat_concurrency",
					"schedule_json", "status", "updated_time",
				}),
			}).Create(row).Error; err != nil {
				return err
			}
			// 授权行整组替换：主人把某个单位从额度里去掉时，旧行必须消失而不是留成幽灵上限。
			if err := tx.Db.WithContext(ctx).
				Where("biz_line = ?", bizLine).Where("cid = ?", row.CID).
				Delete(&GalaxyQuotaGrant{}).Error; err != nil {
				return err
			}
			for _, grant := range grants[row.CID] {
				if err := tx.Db.WithContext(ctx).Create(grant).Error; err != nil {
					return err
				}
			}
		}
		return nil
	})
}

func (r *GalaxyRepository) FindContribution(ctx context.Context, bizLine, cid string) (*GalaxyContribution, error) {
	var row GalaxyContribution
	err := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine).Where("cid = ?", cid).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *GalaxyRepository) ListContributionsByNode(ctx context.Context, bizLine, nodeID string) ([]*GalaxyContribution, error) {
	var rows []*GalaxyContribution
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("node_id = ?", nodeID).Where("status <> ?", "disabled").
		Order("cid").Find(&rows).Error
	return rows, err
}

func (r *GalaxyRepository) ListContributionsByOwner(ctx context.Context, bizLine, ownerUserID string) ([]*GalaxyContribution, error) {
	var rows []*GalaxyContribution
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("owner_user_id = ?", ownerUserID).Where("status <> ?", "disabled").
		Order("node_id, cid").Find(&rows).Error
	return rows, err
}

// ListActiveContributions 供 Hub 启动时重建控制面快照，以及后台读池水位。
func (r *GalaxyRepository) ListActiveContributions(ctx context.Context, bizLine string) ([]*GalaxyContribution, error) {
	var rows []*GalaxyContribution
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("status IN ?", []string{"active", "draining", "paused"}).
		Order("node_id, cid").Find(&rows).Error
	return rows, err
}

func (r *GalaxyRepository) SetContributionStatus(ctx context.Context, bizLine, cid, status string) error {
	return r.Db.WithContext(ctx).Model(&GalaxyContribution{}).
		Where("biz_line = ?", bizLine).Where("cid = ?", cid).
		Update("status", status).Error
}

func (r *GalaxyRepository) AdjustReputation(ctx context.Context, bizLine, cid string, delta float64) error {
	return r.Db.WithContext(ctx).Model(&GalaxyContribution{}).
		Where("biz_line = ?", bizLine).Where("cid = ?", cid).
		Update("reputation", clause.Expr{SQL: "GREATEST(0, LEAST(1, reputation + ?))", Vars: []any{delta}}).Error
}

func (r *GalaxyRepository) ListQuotaGrants(ctx context.Context, bizLine string, cids []string) ([]*GalaxyQuotaGrant, error) {
	if len(cids) == 0 {
		return nil, nil
	}
	var rows []*GalaxyQuotaGrant
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("cid IN ?", cids).
		Order("cid, unit").Find(&rows).Error
	return rows, err
}

// SnapshotQuotaWindow 把 Redis 计数器写回 MySQL，供对账与控制台展示。
func (r *GalaxyRepository) SnapshotQuotaWindow(ctx context.Context, rows []*GalaxyQuotaWindow) error {
	if len(rows) == 0 {
		return nil
	}
	return r.Db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "biz_line"}, {Name: "cid"}, {Name: "unit"}, {Name: "window_key"}},
		DoUpdates: clause.AssignmentColumns([]string{"used", "reserved", "snapshot_at"}),
	}).Create(rows).Error
}

func (r *GalaxyRepository) ListQuotaWindows(ctx context.Context, bizLine string, cids []string) ([]*GalaxyQuotaWindow, error) {
	if len(cids) == 0 {
		return nil, nil
	}
	var rows []*GalaxyQuotaWindow
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("cid IN ?", cids).
		Order("cid, unit").Find(&rows).Error
	return rows, err
}

// RecordSeatBinding 座位绑定留痕。权威在 Redis（带 TTL），这里只供审计与「我的机器上跑过谁」。
func (r *GalaxyRepository) RecordSeatBinding(ctx context.Context, row *GalaxySeatBinding) error {
	return r.Db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "biz_line"}, {Name: "cid"}, {Name: "consumer_key"}, {Name: "lane"}},
		DoUpdates: clause.AssignmentColumns([]string{"last_used_at", "released_at"}),
	}).Create(row).Error
}

func (r *GalaxyRepository) ReleaseSeatBinding(ctx context.Context, bizLine, cid, consumerKey, lane string, at time.Time) error {
	return r.Db.WithContext(ctx).Model(&GalaxySeatBinding{}).
		Where("biz_line = ?", bizLine).Where("cid = ?", cid).
		Where("consumer_key = ?", consumerKey).Where("lane = ?", lane).
		Update("released_at", at).Error
}

// SaveContributionLimits 控制台改授权：贡献本身与它的授权行必须一起改。
// 分开写的话，中间失败会留下「座位已经调大但额度还是旧的」这种半截状态。
func (r *GalaxyRepository) SaveContributionLimits(ctx context.Context, bizLine, cid string, values map[string]any, grants []*GalaxyQuotaGrant) error {
	return r.Tx(ctx, func(tx *GalaxyRepository) error {
		if err := tx.Db.WithContext(ctx).Model(&GalaxyContribution{}).
			Where("biz_line = ?", bizLine).Where("cid = ?", cid).
			Updates(values).Error; err != nil {
			return err
		}
		if err := tx.Db.WithContext(ctx).
			Where("biz_line = ?", bizLine).Where("cid = ?", cid).
			Delete(&GalaxyQuotaGrant{}).Error; err != nil {
			return err
		}
		for _, grant := range grants {
			if err := tx.Db.WithContext(ctx).Create(grant).Error; err != nil {
				return err
			}
		}
		return nil
	})
}
