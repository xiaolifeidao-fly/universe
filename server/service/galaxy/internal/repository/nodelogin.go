package repository

import (
	"context"
)

// 远端登录：节点自报的登录会话，加上一条待下发的「去登录 / 这是码」指令。
//
// 同 nodetools.go 的提醒：这几列**不能**走 SaveNode。那个 upsert 的白名单是为
// hello 准备的，把它们列进去，一次 pair 或 register 就会拿零值把刚点下的指令抹掉。

// SaveNodeLogins 写节点自报的那份登录会话（一段 JSON）。
//
// 「没变就别写」由调用方判断，理由同 SaveNodeTools。登录期间节点会把心跳提速到
// 5 秒一跳，那几分钟里这一列确实每跳都在变 —— 那是应该写的。
func (r *GalaxyRepository) SaveNodeLogins(ctx context.Context, bizLine, nodeID, loginsJSON string) error {
	return r.updateNode(ctx, bizLine, nodeID, map[string]any{"logins_json": loginsJSON})
}

// SaveNodeLoginCommand 记一条待下发的登录指令，或者把它清掉（四个值全传零值）。
//
// 四列一起写：它们是同一条指令的四个部分，分开写会出现「有 id 没时刻」这种
// 判不了超时的半条记录。
func (r *GalaxyRepository) SaveNodeLoginCommand(ctx context.Context, bizLine, nodeID string, fields map[string]any) error {
	return r.updateNode(ctx, bizLine, nodeID, fields)
}
