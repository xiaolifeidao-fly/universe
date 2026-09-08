package galaxy

import (
	"context"
	"time"

	"contract"
	"service/galaxy/dto"
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
	for _, node := range nodes {
		view := dto.AdminNodeView{
			NodeView: dto.NodeView{
				NodeID: node.NodeID, DisplayName: node.DisplayName, BridgeVersion: node.BridgeVersion,
				Status: node.Status, Banned: node.Banned, LastBeatAt: node.LastBeatAt,
			},
			OwnerUserID: node.OwnerUserID,
		}
		rows, err := s.repository.ListContributionsByNode(ctx, bizLine, node.NodeID)
		if err != nil {
			return nil, err
		}
		grants, err := s.loadGrants(ctx, cidsOf(rows))
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			view.Contributions = append(view.Contributions, s.contributionView(ctx, row, grants[row.CID], now))
		}
		views = append(views, view)
	}
	return views, nil
}

// BanNode 封禁 / 解封一台机器。
//
// 和主人自己「撤销」的区别：撤销是把令牌作废，主人重新配对就能回来；
// 封禁是平台的处置，主人解不开，而且立刻把它的贡献从候选里摘掉。
func (s *service) BanNode(ctx context.Context, req dto.BanNodeRequest) error {
	if err := s.repository.SetNodeBanned(ctx, bizLine, req.NodeID, req.Banned); err != nil {
		return err
	}
	if !req.Banned {
		return nil
	}
	if err := s.control.DropNode(ctx, req.NodeID); err != nil {
		return err
	}
	rows, err := s.repository.ListContributionsByNode(ctx, bizLine, req.NodeID)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if err := s.repository.SetContributionStatus(ctx, bizLine, row.CID, statusDisabled); err != nil {
			return err
		}
	}
	return nil
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
