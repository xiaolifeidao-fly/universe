package galaxy

import (
	"context"
	"time"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 平台运营视角。这些接口只读或只做处置动作，不参与请求路径 ——
// 后台查一次全量节点是几十毫秒的事，放在放置路径上就是灾难。

// AdminNodes 平台视角的全部节点与贡献。
func (s *service) AdminNodes(ctx context.Context, limit int) ([]dto.AdminNodeView, error) {
	nodes, err := s.repository.ListNodes(ctx, bizLine, limit)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	views := make([]dto.AdminNodeView, 0, len(nodes))
	reputations, providerTypes, err := s.nodeReputations(ctx, nodes, now)
	if err != nil {
		return nil, err
	}
	ownerNames, err := s.ownerNames(ctx, nodes)
	if err != nil {
		return nil, err
	}
	for _, node := range nodes {
		rows, err := s.repository.ListContributionsByNode(ctx, bizLine, node.NodeID)
		if err != nil {
			return nil, err
		}
		// 和 ListNodes 同一个理由：nil 切片序列化成 null，会覆盖掉前端的默认 []。
		view := dto.AdminNodeView{
			NodeView: dto.NodeView{
				NodeID: node.NodeID, DisplayName: node.DisplayName, BridgeVersion: node.BridgeVersion,
				Status: node.Status, Banned: node.Banned, LastBeatAt: node.LastBeatAt,
				Contributions: make([]dto.ContributionView, 0, len(rows)),
				// 运营视图不给机器上的工具（那是主人自己的事），但这一列不能是 null。
				Tools: []dto.NodeToolView{},
			},
			OwnerUserID:  node.OwnerUserID,
			OwnerName:    ownerNames[node.OwnerUserID],
			ProviderType: providerTypes[node.OwnerUserID],
		}
		grants, err := s.loadGrants(ctx, cidsOf(rows))
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			view.Contributions = append(view.Contributions, s.contributionView(ctx, row, grants[row.CID], now, reputations[node.NodeID]))
		}
		views = append(views, view)
	}
	return views, nil
}

// ownerNames 这些机器的主人叫什么，按 ownerUserId 索引。
func (s *service) ownerNames(ctx context.Context, nodes []*repository.GalaxyNode) (map[string]string, error) {
	owners := make([]string, 0, len(nodes))
	for _, node := range nodes {
		owners = append(owners, node.OwnerUserID)
	}
	return s.userNames(ctx, dto.SideProvider, owners)
}

// userNames 账号 id → 「昵称（用户名）」，昵称和用户名一样时只留用户名。批量查一次账号表，
// 查不到的（账号被删、迁移前的老数据）不在结果里，界面退回显示 id。
//
// side 是这批 id 属于哪一端 —— 两端各一张账号表，机器的主人只可能在共享端那张，
// 密钥和积分的主人只可能在使用端那张。传错端的结果是一个名字都查不到，界面上全是裸 id。
func (s *service) userNames(ctx context.Context, side string, userIDs []string) (map[string]string, error) {
	rows, err := s.repository.ListUsersByIDs(ctx, bizLine, side, uniqueStrings(userIDs))
	if err != nil {
		return nil, err
	}
	names := make(map[string]string, len(rows))
	for _, row := range rows {
		names[row.UserID] = row.Username
		if row.DisplayName != "" && row.DisplayName != row.Username {
			names[row.UserID] = row.DisplayName + "（" + row.Username + "）"
		}
	}
	return names, nil
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

// AdminProbes 最近的抽检结果。只返回签名与判定，请求原文在比对完成时就已清掉。
func (s *service) AdminProbes(ctx context.Context, cid string, limit int) ([]dto.AuditProbeView, error) {
	rows, err := s.repository.ListRecentProbes(ctx, bizLine, cid, limit)
	if err != nil {
		return nil, err
	}
	views := make([]dto.AuditProbeView, 0, len(rows))
	for _, row := range rows {
		views = append(views, dto.AuditProbeView{
			ProbeID: row.ProbeID, CID: row.CID, UnitID: row.UnitID,
			Family: row.Family, Model: row.Model, Similarity: row.Similarity,
			Verdict: row.Verdict, Detail: row.Detail,
			CreatedAt: row.CreatedAt, CheckedAt: row.CheckedAt,
		})
	}
	return views, nil
}

// AdminUsage 平台维度的用量与结算。不带 consumerKey 就是全池汇总。
func (s *service) AdminUsage(ctx context.Context, query dto.UsageQuery) (dto.UsageReport, error) {
	return s.Usage(ctx, query)
}

var _ = contract.GalaxyBizLine
