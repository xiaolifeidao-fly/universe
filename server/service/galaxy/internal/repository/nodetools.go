package repository

import (
	"context"
)

// 机器上那两个**外部工具**（claude / codex）：节点自报的版本与安装进度，
// 加上一条待下发的「去装 / 去升」指令。
//
// 同 nodeupgrade.go 的提醒：这几列**不能**走 SaveNode。那个 upsert 的白名单是为
// hello 准备的，把它们列进去，一次 pair 或 register 就会拿零值把刚点下的指令抹掉。

// SaveNodeTools 写节点自报的那份工具状态（一段 JSON）。
//
// 「没变就别写」由调用方判断：心跳 15 秒一次，不比就写是每台机器每天四千多次空
// UPDATE，而且全落在派单路径要读的这张表上。
func (r *GalaxyRepository) SaveNodeTools(ctx context.Context, bizLine, nodeID, toolsJSON string) error {
	return r.updateNode(ctx, bizLine, nodeID, map[string]any{"tools_json": toolsJSON})
}

// SaveNodeToolCommand 记一条待下发的指令，或者把它清掉（三个值全传零值）。
//
// 三列一起写：它们是同一条指令的三个部分，分开写会出现「有 id 没时刻」这种
// 判不了超时的半条记录。
func (r *GalaxyRepository) SaveNodeToolCommand(ctx context.Context, bizLine, nodeID string, fields map[string]any) error {
	return r.updateNode(ctx, bizLine, nodeID, fields)
}

func (r *GalaxyRepository) updateNode(ctx context.Context, bizLine, nodeID string, fields map[string]any) error {
	if len(fields) == 0 {
		return nil
	}
	return r.Db.WithContext(ctx).Model(&GalaxyNode{}).
		Where("biz_line = ?", bizLine).Where("node_id = ?", nodeID).
		Updates(fields).Error
}
