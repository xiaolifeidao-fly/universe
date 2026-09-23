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
					"groups_json", "seats", "seat_concurrency",
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

// SyncContributionInventory 用节点上报的**能力清单**对齐贡献表。
//
// 和 ReplaceContributions 的区别是权威归属反过来了：
//
//	ReplaceContributions  节点说了算 —— 这次没报的贡献直接置 disabled，额度整组重写
//	SyncContributionInventory  节点只报「本机有什么、能不能用」，
//	                           「共享不共享、共享多少」是主人在控制台定的
//
// 所以这里**只写节点报得出来的那几列**：kind / provider / available / 原因。
// status、seats、groups、schedule 一律不碰 —— 它们是主人的设置，
// 被一次心跳覆盖掉，等于主人每次重启插件都要重新配一遍。额度更不碰，
// 那是 quota_grant 的事，走控制台的改额度接口。
//
// 这次没报上来的能力不删行，只置 available=false：Claude 登录态过期是常事，
// 删了的话主人的勾选跟着没了，登录回来还得重配。
func (r *GalaxyRepository) SyncContributionInventory(ctx context.Context, bizLine, nodeID string, rows []*GalaxyContribution) error {
	return r.Tx(ctx, func(tx *GalaxyRepository) error {
		reported := make([]string, 0, len(rows))
		for _, row := range rows {
			reported = append(reported, row.CID)
		}
		gone := tx.Db.WithContext(ctx).Model(&GalaxyContribution{}).
			Where("biz_line = ?", bizLine).Where("node_id = ?", nodeID)
		if len(reported) > 0 {
			gone = gone.Where("cid NOT IN ?", reported)
		}
		if err := gone.Updates(map[string]any{
			"available":          false,
			"unavailable_reason": "节点最近一次上报里没有这项能力",
		}).Error; err != nil {
			return err
		}
		for _, row := range rows {
			if err := tx.Db.WithContext(ctx).Clauses(clause.OnConflict{
				Columns: []clause.Column{{Name: "biz_line"}, {Name: "cid"}},
				DoUpdates: clause.AssignmentColumns([]string{
					"node_id", "owner_user_id", "kind", "kind_version", "provider",
					"available", "unavailable_reason", "models_available_json", "updated_time",
				}),
			}).Create(row).Error; err != nil {
				return err
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

// ListContributionsByNode 一台机器上的**全部**贡献，包含 disabled 的。
//
// 这里曾经过滤 status <> 'disabled'，那是个死锁：Hello 把新探测到的能力一律建成
// disabled（「探测到不等于愿意共享」），而控制台的机器列表走的就是这个查询 ——
// 于是新能力永远不显示，主人也就永远没机会把它打开。用户看到的是「配对成功了，
// 但找不到任何可以配置共享内容的地方」。
//
// 过滤要放在各调用方，因为每个人的判据不一样：
//
//	· effectiveContributions（调度）自己就按「主人没关 + 本机可用」筛，不依赖这里；
//	· 心跳只拿它同步额度计数器，多几行 disabled 无害；
//	· 撤销清理**必须**看到全部，否则 disabled 的贡献会被漏掉。
func (r *GalaxyRepository) ListContributionsByNode(ctx context.Context, bizLine, nodeID string) ([]*GalaxyContribution, error) {
	var rows []*GalaxyContribution
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("node_id = ?", nodeID).
		Order("cid").Find(&rows).Error
	return rows, err
}

// ListContributionsByOwner 主人名下的**全部**贡献，包含 disabled 的。
//
// 和 ListContributionsByNode 同一个坑：这里曾经过滤 status <> 'disabled'，
// 而 findOwnedContribution（开关、改额度都走它）用的就是这个查询 —— 于是对一条
// 关着的贡献做任何操作都报「贡献不存在」。而关着的贡献唯一能做的操作就是打开它，
// 所以那是个完整的死锁：看得见、点不动。
//
// 调度侧不受影响，它走的是 ListActiveContributions（显式列 active/draining/paused）。
func (r *GalaxyRepository) ListContributionsByOwner(ctx context.Context, bizLine, ownerUserID string) ([]*GalaxyContribution, error) {
	var rows []*GalaxyContribution
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("owner_user_id = ?", ownerUserID).
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

// SetContributionStatus 落状态，并把「等排空」的意图一并清掉。
//
// 两件事必须一起写：意图就是为了走到某个状态，状态一落地它就没有意义了。留着的话，
// 主人重新打开共享之后，下一次在途归零时那条陈年意图会把刚开的共享又关掉。
func (r *GalaxyRepository) SetContributionStatus(ctx context.Context, bizLine, cid, status string) error {
	return r.Db.WithContext(ctx).Model(&GalaxyContribution{}).
		Where("biz_line = ?", bizLine).Where("cid = ?", cid).
		Updates(map[string]any{"status": status, "pending_status": ""}).Error
}

// SetContributionPending 记下「主人想关，但还有请求在跑」。
//
// 只改意图那一列，不动 status —— status 这时候由调用方写成 draining（停止接新单、
// 在跑的正常跑完），那是额度触顶时用的同一套语义，节点侧不需要为此多认一种状态。
func (r *GalaxyRepository) SetContributionPending(ctx context.Context, bizLine, cid, pending string) error {
	return r.Db.WithContext(ctx).Model(&GalaxyContribution{}).
		Where("biz_line = ?", bizLine).Where("cid = ?", cid).
		Update("pending_status", pending).Error
}

// DisableContributionsByNode 把一台机器名下的贡献全部关掉。撤销与封禁都走它。
//
// 撤销**必须**做这一步，光摘控制面不够：巡检按贡献倒推节点状态，留下来的 active
// 贡献行会让它把刚撤销的机器判成离线（见 MarkNodeOffline 上的注释），而且这些
// 幽灵行还会进池水位、Hub 重启时被重新装回控制面。
//
// 和 ReplaceContributions 一样只置 disabled 不删行：历史用量与账本还引用着这些 cid。
func (r *GalaxyRepository) DisableContributionsByNode(ctx context.Context, bizLine, nodeID string) error {
	return r.Db.WithContext(ctx).Model(&GalaxyContribution{}).
		Where("biz_line = ?", bizLine).Where("node_id = ?", nodeID).
		Update("status", "disabled").Error
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

// ContributionOwnersByCIDs 这些贡献各自的主人，按 cid 索引。
//
// 一次 IN 查完，不是逐个 FindContribution —— 偏差列表一页二十行、排行再十行，
// 逐个查就是三十次往返，而这三十次问的是同一张表的同一列。
func (r *GalaxyRepository) ContributionOwnersByCIDs(ctx context.Context, bizLine string, cids []string) (map[string]string, error) {
	owners := map[string]string{}
	if len(cids) == 0 {
		return owners, nil
	}
	var rows []struct {
		CID         string
		OwnerUserID string
	}
	err := r.Db.WithContext(ctx).Model(&GalaxyContribution{}).
		Select("cid", "owner_user_id").
		Where("biz_line = ?", bizLine).Where("cid IN ?", cids).Scan(&rows).Error
	for _, row := range rows {
		owners[row.CID] = row.OwnerUserID
	}
	return owners, err
}

// SaveUpstreamUsage 落一条贡献的上游余量快照。
//
// 心跳每 15 秒带一次，但这里**只在变了的时候才被调用**（见 service 的 Heartbeat）：
// 一条不变的快照每 15 秒写一次库，是按机器数乘以 240 的空写。
func (r *GalaxyRepository) SaveUpstreamUsage(ctx context.Context, bizLine, cid, payload string, at time.Time) error {
	return r.Db.WithContext(ctx).Model(&GalaxyContribution{}).
		Where("biz_line = ?", bizLine).Where("cid = ?", cid).
		Updates(map[string]any{"upstream_usage_json": payload, "upstream_usage_at": at}).Error
}
