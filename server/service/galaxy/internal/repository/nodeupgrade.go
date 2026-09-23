package repository

import (
	"context"
)

// 机器上的 ai-bridge：装的是什么、能不能远程升级、这一次升到哪儿了。
//
// 这几列都写在 zt_galaxy_node 上，但**不能**走 SaveNode：那个 upsert 的白名单是为
// hello 准备的（见 SaveNode 的注释），把这些列列进去，一次 pair 或 register 就会拿零值
// 把它们抹掉 —— 机器刚点完升级、紧接着自动重新注册一次，升级指令就没了。

// SaveNodeBridgeInfo 记下 hello 报上来的平台、分发方式与「此刻能不能远程升级」。
//
// 三个字段一起写：它们是同一次 hello 的同一份事实，分开写会出现「平台已经更新、
// 障碍还是上一版的说法」这种自相矛盾的一行。
func (r *GalaxyRepository) SaveNodeBridgeInfo(ctx context.Context, bizLine, nodeID, platform, distribution, blocker string) error {
	return r.Db.WithContext(ctx).Model(&GalaxyNode{}).
		Where("biz_line = ?", bizLine).Where("node_id = ?", nodeID).
		Updates(map[string]any{
			"bridge_platform":     platform,
			"bridge_distribution": distribution,
			"upgrade_blocker":     blocker,
		}).Error
}

// SaveNodeUpgrade 无条件写升级状态。发起升级、以及 Hub 自己判定的终态（超时、目标
// 版本下架、重启后版本对上了）走它。
func (r *GalaxyRepository) SaveNodeUpgrade(ctx context.Context, bizLine, nodeID string, fields map[string]any) error {
	if len(fields) == 0 {
		return nil
	}
	return r.Db.WithContext(ctx).Model(&GalaxyNode{}).
		Where("biz_line = ?", bizLine).Where("node_id = ?", nodeID).
		Updates(fields).Error
}

// UpdateNodeUpgrade 按 upgrade_id 有条件地写。节点回报进度走它。
//
// 条件不能省：指令 id 是「这一次升级」的身份。一条上一次升级的迟到回报
// （节点在网络恢复之后补发）如果能改当前这一次的状态，控制台上会看到
// 「正在下载 0.2.0」突然变成「升级到 0.1.9 失败」。返回 false 表示这条回报过期了。
func (r *GalaxyRepository) UpdateNodeUpgrade(ctx context.Context, bizLine, nodeID, upgradeID string, fields map[string]any) (bool, error) {
	if len(fields) == 0 {
		return false, nil
	}
	result := r.Db.WithContext(ctx).Model(&GalaxyNode{}).
		Where("biz_line = ?", bizLine).Where("node_id = ?", nodeID).
		Where("upgrade_id = ?", upgradeID).
		Updates(fields)
	if result.Error != nil {
		return false, result.Error
	}
	return result.RowsAffected > 0, nil
}
