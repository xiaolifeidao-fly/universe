package repository

import (
	"context"
	"fmt"

	"gorm.io/gorm/clause"
)

// SetMachineBanned 封禁 / 解封一台设备：先记下这个指纹的处置，再把库里带这个指纹的节点记录一起改。
//
// 顺序不能换。hello 是先补指纹、再按封禁表把自己标上（BanNodeIfMachineBanned）；这边先写封禁表、
// 再改节点，两边怎么交错，一台刚补上指纹的节点都至少会被其中一边标到 —— hello 那一步要是赶在
// 封禁表写入之前，这边改节点时它的指纹早就补上了。反过来先改节点，就会漏掉「节点改完才补上指纹、
// 封禁表还没写就查过」的那一台。
//
// 不包事务：hello 那条语句要锁节点行，同时给读到的封禁行加共享锁，先后由优化器定；这里要是在一个事务里
// 先锁封禁行、再锁节点行，两边就可能锁成一个环。拆成两条各自提交的语句，中途失败最坏是封禁表记上了、
// 节点还没标，管理端看到报错再点一次就齐了。
//
// 空指纹直接报错：按空串去匹配 machine_fingerprint，会命中所有没报过指纹的老节点，一次封禁就成了全池封禁。
func (r *GalaxyRepository) SetMachineBanned(ctx context.Context, row *GalaxyMachineBan) error {
	if row.MachineFingerprint == "" {
		return fmt.Errorf("缺少设备指纹，不能按设备封禁")
	}
	err := r.Db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "biz_line"}, {Name: "machine_fingerprint"}},
		DoUpdates: clause.AssignmentColumns([]string{"banned", "reason", "updated_by", "updated_time"}),
	}).Create(row).Error
	if err != nil {
		return err
	}
	// 走 idx_gx_node_fingerprint。没有这个索引，这条 UPDATE 要扫全表、把每台机器的行都锁上，
	// 心跳写节点行时全得等它。
	return r.Db.WithContext(ctx).Model(&GalaxyNode{}).
		Where("biz_line = ?", row.BizLine).Where("machine_fingerprint = ?", row.MachineFingerprint).
		Update("banned", row.Banned).Error
}

// NodeIDsByFingerprint 这台设备上还没撤销的节点记录。封禁时逐台摘控制面、关贡献用；
// 撤销掉的不要，它们的贡献和控制面在撤销时就清过了。
//
// 只取 node_id：这张表上存着回连密钥的明文，用不着的列别往内存里捞（同 NodeNames）。
// 空指纹不查 —— 那会捞出全部没报过指纹的老节点。
func (r *GalaxyRepository) NodeIDsByFingerprint(ctx context.Context, bizLine, fingerprint string) ([]string, error) {
	if fingerprint == "" {
		return nil, nil
	}
	var nodeIDs []string
	err := r.Db.WithContext(ctx).Model(&GalaxyNode{}).
		Where("biz_line = ?", bizLine).Where("machine_fingerprint = ?", fingerprint).
		Where("status <> ?", "revoked").
		Pluck("node_id", &nodeIDs).Error
	return nodeIDs, err
}

// BanNodeIfMachineBanned hello 时用：这条节点记录上的指纹已经被封，就把这条记录也标上封禁。
//
// 判断和标记是同一条语句。先查封禁表、再单独写节点的话，查完那一刻管理端恰好解封：解封清掉的是
// 当时带这个指纹的节点，这边随后又把它标回去 —— 管理端点了解封，那台机器还是连不上。
// 没报过指纹的记录这里一条都命中不了，老节点的封禁照旧只看它自己那一行。
func (r *GalaxyRepository) BanNodeIfMachineBanned(ctx context.Context, bizLine, nodeID string) error {
	banned := r.Db.Model(&GalaxyMachineBan{}).Select("machine_fingerprint").
		Where("biz_line = ?", bizLine).Where("banned = ?", true)
	return r.Db.WithContext(ctx).Model(&GalaxyNode{}).
		Where("biz_line = ?", bizLine).Where("node_id = ?", nodeID).
		Where("machine_fingerprint IN (?)", banned).
		Update("banned", true).Error
}

// MachineBanned 这个指纹此刻是否被封禁。空指纹一律不算。
func (r *GalaxyRepository) MachineBanned(ctx context.Context, bizLine, fingerprint string) (bool, error) {
	if fingerprint == "" {
		return false, nil
	}
	var count int64
	err := r.Db.WithContext(ctx).Model(&GalaxyMachineBan{}).
		Where("biz_line = ?", bizLine).Where("machine_fingerprint = ?", fingerprint).Where("banned = ?", true).
		Count(&count).Error
	return count > 0, err
}

// ListMachineBans 封禁名单。bannedOnly 为真只列还在封着的，否则连解封过的历史一起列。
//
// 有这张名单才谈得上「解封」：封禁记在指纹上，而解封那条路（BanNode）是按 node_id 找机器的 ——
// 机器一旦从 zt_galaxy_node 里消失（撤销、重装、换了 node_id），那个指纹就再也没有入口能碰到，
// 封禁变成永久的，而且在管理端任何一页上都看不见。
func (r *GalaxyRepository) ListMachineBans(ctx context.Context, bizLine string, bannedOnly bool, limit int) ([]*GalaxyMachineBan, error) {
	tx := r.Db.WithContext(ctx).Model(&GalaxyMachineBan{}).Where("biz_line = ?", bizLine)
	if bannedOnly {
		tx = tx.Where("banned = ?", true)
	}
	if limit > 0 {
		tx = tx.Limit(limit)
	}
	var rows []*GalaxyMachineBan
	err := tx.Order("banned desc, updated_time desc, id desc").Find(&rows).Error
	return rows, err
}

// NodesByFingerprints 这些指纹下还有哪些节点记录，按指纹归组。
//
// 封禁名单上光有一串指纹哈希没法用：运营要认出「这是谁的哪台机器」才敢解封。
// 含已撤销的 —— 一台被封之后又撤销的机器，恰恰是最需要在名单上解释清楚的那种。
func (r *GalaxyRepository) NodesByFingerprints(ctx context.Context, bizLine string, fingerprints []string) (map[string][]*GalaxyNode, error) {
	grouped := map[string][]*GalaxyNode{}
	if len(fingerprints) == 0 {
		return grouped, nil
	}
	// 只取要显示的那几列：这张表上存着回连密钥的明文，用不着的列别往内存里捞（同 NodeIDsByFingerprint）。
	var rows []*GalaxyNode
	err := r.Db.WithContext(ctx).Model(&GalaxyNode{}).
		Select("node_id", "display_name", "owner_user_id", "status", "machine_fingerprint", "last_beat_at").
		Where("biz_line = ?", bizLine).Where("machine_fingerprint IN ?", fingerprints).
		Order("last_beat_at desc").Find(&rows).Error
	if err != nil {
		return grouped, err
	}
	for _, row := range rows {
		grouped[row.MachineFingerprint] = append(grouped[row.MachineFingerprint], row)
	}
	return grouped, nil
}

// CountBannedMachines 此刻还封着的机器数。运营总览那一排数字用它。
func (r *GalaxyRepository) CountBannedMachines(ctx context.Context, bizLine string) (int64, error) {
	var total int64
	err := r.Db.WithContext(ctx).Model(&GalaxyMachineBan{}).
		Where("biz_line = ?", bizLine).Where("banned = ?", true).Count(&total).Error
	return total, err
}

// NodesByOwners 这些账号名下的节点记录，按 owner_user_id 归组。
//
// 信誉名单要用：account: 那一类的信誉管的是这个人名下**所有**机器，
// 而设备指纹查不到它们 —— 按指纹查会一台都查不到，界面上就成了
// 「节点记录已不在」，而那台机器其实好端端地在线。
func (r *GalaxyRepository) NodesByOwners(ctx context.Context, bizLine string, ownerIDs []string) (map[string][]*GalaxyNode, error) {
	grouped := map[string][]*GalaxyNode{}
	if len(ownerIDs) == 0 {
		return grouped, nil
	}
	var rows []*GalaxyNode
	err := r.Db.WithContext(ctx).Model(&GalaxyNode{}).
		Select("node_id", "display_name", "owner_user_id", "status", "machine_fingerprint", "last_beat_at").
		Where("biz_line = ?", bizLine).Where("owner_user_id IN ?", ownerIDs).
		Order("last_beat_at desc").Find(&rows).Error
	if err != nil {
		return grouped, err
	}
	for _, row := range rows {
		grouped[row.OwnerUserID] = append(grouped[row.OwnerUserID], row)
	}
	return grouped, nil
}
