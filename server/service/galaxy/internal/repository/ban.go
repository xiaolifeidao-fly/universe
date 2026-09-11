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
