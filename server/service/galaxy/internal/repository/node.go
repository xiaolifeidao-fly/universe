package repository

import (
	"context"
	"fmt"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func (r *GalaxyRepository) CreatePairingCode(ctx context.Context, row *GalaxyPairingCode) error {
	return r.Db.WithContext(ctx).Create(row).Error
}

// TakePairingCode 兑换配对码：一次性，只有未过期未兑换的那一行能被更新到。
// 用条件更新而不是「先查后写」，两台机器同时拿同一个码时只有一台成功。
func (r *GalaxyRepository) TakePairingCode(ctx context.Context, bizLine, code, nodeID string, now time.Time) (*GalaxyPairingCode, error) {
	result := r.Db.WithContext(ctx).Model(&GalaxyPairingCode{}).
		Where("biz_line = ?", bizLine).
		Where("code = ?", code).
		Where("consumed_at IS NULL").
		Where("expires_at > ?", now).
		Updates(map[string]any{"consumed_at": now, "node_id": nodeID})
	if result.Error != nil {
		return nil, result.Error
	}
	if result.RowsAffected == 0 {
		return nil, gorm.ErrRecordNotFound
	}
	var row GalaxyPairingCode
	err := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine).Where("code = ?", code).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// SaveNode 建行或更新一台机器。
//
// **token_hash 与 display_name 刻意不在 DoUpdates 里。** 这个方法有两个调用方：
// Pair 建行时带着新签的令牌和主人起的名字（走 INSERT，不经 DoUpdates），
// Hello 每次上报只带版本、资源和状态（这两个字段是零值）。把它们列进 DoUpdates，
// hello 就会用空串覆盖掉真值 —— 节点在 hello 成功的那一刻把自己的令牌抹掉，
// 紧接着的心跳、领活、回报全部 401「节点令牌无效」，而且再也回不来。
// 撤销令牌有 RevokeNode 专门管，不需要从这里走。
func (r *GalaxyRepository) SaveNode(ctx context.Context, row *GalaxyNode) error {
	// 先补本轮在线起点，再 upsert。合成一条 UPDATE 做不到：判断依据是**旧的** status，
	// 而同一条语句里 status 已经被改成 active 了，赋值顺序还由 map 的遍历顺序决定。
	if row.Status == "active" {
		at := time.Now()
		if row.LastBeatAt != nil {
			at = *row.LastBeatAt
		}
		if err := r.markOnlineSince(ctx, row.BizLine, row.NodeID, at); err != nil {
			return err
		}
		if row.OnlineSince == nil {
			row.OnlineSince = &at
		}
	}
	return r.Db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "biz_line"}, {Name: "node_id"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"owner_user_id", "bridge_version", "contract_version", "resources_json", "status", "last_beat_at", "updated_time",
		}),
	}).Create(row).Error
}

// FindNodeByTokenHash 是节点通道的鉴权入口：凭证认定的身份覆盖请求体里的任何节点字段。
func (r *GalaxyRepository) FindNodeByTokenHash(ctx context.Context, bizLine, tokenHash string) (*GalaxyNode, error) {
	var row GalaxyNode
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).
		Where("token_hash = ?", tokenHash).
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *GalaxyRepository) FindNode(ctx context.Context, bizLine, nodeID string) (*GalaxyNode, error) {
	var row GalaxyNode
	err := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine).Where("node_id = ?", nodeID).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// ListNodesByOwner 主人自己看得到的机器。**撤销掉的不算**。
//
// 不过滤的话，撤销之后那一行还在列表里，而且渲染成「离线」—— 和撤销前一模一样，
// 撤销按钮也还在。用户点了没有任何变化，只会认为这个功能坏了。
// 平台侧的 ListNodes 不过滤，运营排障要看得到撤销记录。
func (r *GalaxyRepository) ListNodesByOwner(ctx context.Context, bizLine, ownerUserID string) ([]*GalaxyNode, error) {
	var rows []*GalaxyNode
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).
		Where("owner_user_id = ?", ownerUserID).
		Where("status <> ?", "revoked").
		Order("created_time desc").Find(&rows).Error
	return rows, err
}

// ListRevokedNodesByOwner 主人解绑掉的机器，账户页「已解绑」那一栏用。和 ListNodesByOwner 正好互补。
//
// 分两个列表而不是给那边加个开关：「我的机器」里混进解绑的行，就回到了上面说的
// 「撤销了看着像没撤」。解绑是终态（见 MarkNodeOffline），这些行只留着对得上账 ——
// 执行记录和积分里还有它们跑出来的那几笔。
//
// 最近解绑的在前：updated_time 在撤销那一刻被刷新，之后心跳、hello 都进不来（令牌已置空）。
// 只取展示要的列：这张表上存着回连密钥的明文，用不着的列别往内存里捞（同 NodeNames）。
func (r *GalaxyRepository) ListRevokedNodesByOwner(ctx context.Context, bizLine, ownerUserID string, limit int) ([]*GalaxyNode, error) {
	var rows []*GalaxyNode
	err := r.Db.WithContext(ctx).
		Select("node_id, display_name, bridge_version, access_mode, endpoint_url, status, banned, last_beat_at, created_time, updated_time").
		Where("biz_line = ?", bizLine).
		Where("owner_user_id = ?", ownerUserID).
		Where("status = ?", "revoked").
		Order("updated_time desc").Limit(limit).Find(&rows).Error
	return rows, err
}

// NodeNames 按 id 取主人名下机器的名字，**撤销掉的也要**。
//
// 给执行记录标「哪台机器跑的」用，和 ListNodesByOwner 正好相反：跑活的那台可能早就解绑了，
// 「我的机器」里不该再有它，账上却还有它跑出来的积分，翻记录时得认得出是哪台。
// 只取两列：这张表上存着回连密钥的明文，用不着的列别往内存里捞。
func (r *GalaxyRepository) NodeNames(ctx context.Context, bizLine, ownerUserID string, nodeIDs []string) (map[string]string, error) {
	names := map[string]string{}
	if len(nodeIDs) == 0 {
		return names, nil
	}
	var rows []struct {
		NodeID      string
		DisplayName string
	}
	err := r.Db.WithContext(ctx).Model(&GalaxyNode{}).
		Where("biz_line = ?", bizLine).Where("owner_user_id = ?", ownerUserID).Where("node_id IN ?", nodeIDs).
		Select("node_id, display_name").Scan(&rows).Error
	if err != nil {
		return names, err
	}
	for _, row := range rows {
		names[row.NodeID] = row.DisplayName
	}
	return names, nil
}

func (r *GalaxyRepository) TouchNode(ctx context.Context, bizLine, nodeID string, at time.Time) error {
	if err := r.markOnlineSince(ctx, bizLine, nodeID, at); err != nil {
		return err
	}
	return r.Db.WithContext(ctx).Model(&GalaxyNode{}).
		Where("biz_line = ?", bizLine).Where("node_id = ?", nodeID).
		Updates(map[string]any{"last_beat_at": at, "status": "active"}).Error
}

// markOnlineSince 只在「刚回到在线」时刷新起点：已经是 active 且记过起点的不动。
// 撤销掉的机器不碰 —— 它不该被一次迟到的心跳复活成在线。
func (r *GalaxyRepository) markOnlineSince(ctx context.Context, bizLine, nodeID string, at time.Time) error {
	return r.Db.WithContext(ctx).Model(&GalaxyNode{}).
		Where("biz_line = ?", bizLine).Where("node_id = ?", nodeID).
		Where("status <> ?", "revoked").
		Where("status <> ? OR online_since IS NULL", "active").
		Update("online_since", at).Error
}

// MarkStaleNodesOffline 把心跳过期的机器降为离线，返回降了几台。
//
// 它按**节点自己的** last_beat_at 判，不看贡献：一台刚配对、还没 hello 的机器
// 一条贡献都没有，靠遍历贡献的那条路永远扫不到它，status 会一直停在 active。
// last_beat_at 为空的一并降 —— 那是有行但从没心跳过，同样不该显示成在线。
func (r *GalaxyRepository) MarkStaleNodesOffline(ctx context.Context, bizLine string, before time.Time) (int64, error) {
	result := r.Db.WithContext(ctx).Model(&GalaxyNode{}).
		Where("biz_line = ?", bizLine).Where("status = ?", "active").
		Where("(last_beat_at IS NULL OR last_beat_at < ?)", before).
		Update("status", "offline")
	return result.RowsAffected, result.Error
}

// MarkNodeOffline 把一台机器降为离线。**撤销掉的不动。**
//
// 巡检是按贡献倒推节点的（ops.Sweep：贡献没有快照就把它那台机器记成离线），
// 而撤销只改节点行和控制面，库里的贡献行还在 —— 于是撤销之后最迟一分钟，
// 这条 UPDATE 就把 revoked 改回 offline，机器从「撤销后不再显示」变回列表里
// 一台离线的僵尸。用户看到的是「撤销了、也确实没了，过一会儿它自己又回来了」，
// 而它的令牌早已置空，永远连不回来，只能再撤一次 —— 再等一分钟又回来。
// 撤销是终态：那台机器要回来只能重新配对，而重新配对建的是新的一行。
func (r *GalaxyRepository) MarkNodeOffline(ctx context.Context, bizLine, nodeID string) error {
	return r.Db.WithContext(ctx).Model(&GalaxyNode{}).
		Where("biz_line = ?", bizLine).Where("node_id = ?", nodeID).
		Where("status <> ?", "revoked").
		Update("status", "offline").Error
}

// RevokeNode 撤销令牌。token_hash 置空后节点的下一次请求就是 401，它会停止重试。
func (r *GalaxyRepository) RevokeNode(ctx context.Context, bizLine, ownerUserID, nodeID string) error {
	result := r.Db.WithContext(ctx).Model(&GalaxyNode{}).
		Where("biz_line = ?", bizLine).Where("owner_user_id = ?", ownerUserID).Where("node_id = ?", nodeID).
		Updates(map[string]any{"token_hash": "", "status": "revoked"})
	if result.Error != nil {
		return result.Error
	}
	// 一行都没命中要报错。Updates 命中 0 行是不报错的，直接 return nil 的话
	// 前端会弹「已撤销」，而那台机器其实一点没动 —— 用户看到的就是「撤销不好用」，
	// 却没有任何线索说明为什么。
	if result.RowsAffected == 0 {
		return fmt.Errorf("找不到这台机器，或它不属于你")
	}
	return nil
}

// ---------- 同意记录 ----------

func (r *GalaxyRepository) SaveConsent(ctx context.Context, row *GalaxyConsentRecord) error {
	return r.Db.WithContext(ctx).Create(row).Error
}

// LatestConsent 取某主体对某条款版本的最新一条同意。条款升版后旧同意不再命中。
func (r *GalaxyRepository) LatestConsent(ctx context.Context, bizLine, subjectType, userID, termsVersion string) (*GalaxyConsentRecord, error) {
	var row GalaxyConsentRecord
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).
		Where("subject_type = ?", subjectType).
		Where("user_id = ?", userID).
		Where("terms_version = ?", termsVersion).
		Order("accepted_at desc").First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// ListNodes 平台视角的全部节点。运营后台用，按最近心跳排序：
// 排障时最关心的永远是「刚刚还在、现在没了」那几台。
func (r *GalaxyRepository) ListNodes(ctx context.Context, bizLine string, limit int) ([]*GalaxyNode, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	var rows []*GalaxyNode
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).
		Order("last_beat_at desc, id desc").Limit(limit).Find(&rows).Error
	return rows, err
}

// SetNodeBanned 平台封禁 / 解封。撤销令牌是主人自己也能做的事，封禁不是。
func (r *GalaxyRepository) SetNodeBanned(ctx context.Context, bizLine, nodeID string, banned bool) error {
	return r.Db.WithContext(ctx).Model(&GalaxyNode{}).
		Where("biz_line = ?", bizLine).Where("node_id = ?", nodeID).
		Update("banned", banned).Error
}

// ---------- 接入方式（poll / export） ----------

// SaveNodeAccess 更新一台机器的接入方式与回连地址。
//
// 单独一条语句，不塞进 SaveNode 的 DoUpdates：那份白名单是给 hello 用的，
// 而 hello 的请求体里这几个字段可能是零值（poll 的机器根本不带）——
// 列进去就会在每次 hello 把一台 export 机器的公网地址抹成空串，
// Hub 从此再也回连不上它，而节点侧一切正常、日志里一个字都没有。
//
// 空 endpoint 是合法输入：一台机器从 export 改回 poll 时正需要把它清掉。
// 所以这里用显式的字段表而不是「非空才更新」。
func (r *GalaxyRepository) SaveNodeAccess(ctx context.Context, bizLine, nodeID, accessMode, endpointURL, endpointSecret string) error {
	return r.Db.WithContext(ctx).Model(&GalaxyNode{}).
		Where("biz_line = ?", bizLine).Where("node_id = ?", nodeID).
		Updates(map[string]any{
			"access_mode":     accessMode,
			"endpoint_url":    endpointURL,
			"endpoint_secret": endpointSecret,
		}).Error
}

// SaveEndpointHealth 记一次回连探测的结果。
//
// 只记结果、不改 status：一台回连不通的 export 机器仍然可能心跳正常
// （心跳是它主动出站的，不经过公网入口）。两件事分开显示，主人才看得出
// 「进程活着，但你的端口映射没配对」——这是 export 部署最常见的一种失败。
func (r *GalaxyRepository) SaveEndpointHealth(ctx context.Context, bizLine, nodeID, status, detail string, at time.Time) error {
	return r.Db.WithContext(ctx).Model(&GalaxyNode{}).
		Where("biz_line = ?", bizLine).Where("node_id = ?", nodeID).
		Updates(map[string]any{
			"endpoint_status":     status,
			"endpoint_error":      detail,
			"endpoint_checked_at": at,
		}).Error
}

// ListExportNodes 全部 export 接入、且还没被撤销/封禁的机器。
// Hub 的回连派单器启动时靠它把已有的机器恢复回来 —— 光靠 hello 是不够的，
// Hub 重启时那些机器可能几十秒内都不会再 hello 一次。
func (r *GalaxyRepository) ListExportNodes(ctx context.Context, bizLine string) ([]*GalaxyNode, error) {
	var rows []*GalaxyNode
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).
		Where("access_mode = ?", "export").
		Where("status <> ?", "revoked").
		Where("banned = ?", false).
		Find(&rows).Error
	return rows, err
}

// RotateNodeToken 换一把新令牌，顺带更新机器名。
//
// 为什么不能靠 SaveNode：那个方法的 DoUpdates 白名单**刻意**不含 token_hash 与
// display_name（见它上面的注释：hello 会拿零值把它们抹掉）。于是复用同一条节点
// 记录重新注册时，upsert 走的是 UPDATE 分支，新令牌根本没写进去 ——
// 节点拿着一把 Hub 不认的令牌，下一个请求就是 401，而注册接口刚刚回了它成功。
//
// 同时把 status 拉回 active：重新注册的机器往往上一轮是 offline 收场的，
// 留着那个状态会让它在控制台上显示成「刚注册就离线」。
func (r *GalaxyRepository) RotateNodeToken(ctx context.Context, bizLine, nodeID, tokenHash, displayName string) error {
	fields := map[string]any{"token_hash": tokenHash, "status": "active"}
	if displayName != "" {
		fields["display_name"] = displayName
	}
	return r.Db.WithContext(ctx).Model(&GalaxyNode{}).
		Where("biz_line = ?", bizLine).Where("node_id = ?", nodeID).
		Updates(fields).Error
}
