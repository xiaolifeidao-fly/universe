package galaxy

import (
	"context"
	"errors"
	"strings"

	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 封禁名单。
//
// 封禁记在**设备指纹**上（zt_galaxy_machine_ban），而此前唯一的解封入口 BanNode 是
// 按 node_id 找机器的：机器一旦从 zt_galaxy_node 里消失 —— 撤销、重装、换了 node_id ——
// 那个指纹就再也没有入口碰得到，封禁变成永久的，而且在管理端任何一页上都看不见。
//
// 这一页是那些指纹唯一的去处：列得出来，也解得开。

// AdminBannedMachines 封禁名单。bannedOnly 为真只列还封着的。
func (s *service) AdminBannedMachines(ctx context.Context, bannedOnly bool, limit int) ([]dto.BannedMachineView, error) {
	rows, err := s.repository.ListMachineBans(ctx, bizLine, bannedOnly, pageLimit(limit, 100, 500))
	if err != nil {
		return nil, err
	}
	fingerprints := make([]string, 0, len(rows))
	for _, row := range rows {
		fingerprints = append(fingerprints, row.MachineFingerprint)
	}
	nodes, err := s.repository.NodesByFingerprints(ctx, bizLine, fingerprints)
	if err != nil {
		return nil, err
	}
	owners := make([]string, 0, len(rows))
	for _, group := range nodes {
		for _, node := range group {
			owners = append(owners, node.OwnerUserID)
		}
	}
	names, err := s.userNames(ctx, dto.SideProvider, owners)
	if err != nil {
		return nil, err
	}
	views := make([]dto.BannedMachineView, 0, len(rows))
	for _, row := range rows {
		view := dto.BannedMachineView{
			Fingerprint: row.MachineFingerprint, Banned: row.Banned,
			Reason: row.Reason, UpdatedBy: row.UpdatedBy,
			UpdatedTime: row.UpdatedTime,
			Nodes:       make([]dto.BannedMachineNode, 0, len(nodes[row.MachineFingerprint])),
		}
		for _, node := range nodes[row.MachineFingerprint] {
			view.Nodes = append(view.Nodes, dto.BannedMachineNode{
				NodeID: node.NodeID, DisplayName: node.DisplayName,
				OwnerUserID: node.OwnerUserID, OwnerName: names[node.OwnerUserID],
				Status: node.Status,
			})
		}
		views = append(views, view)
	}
	return views, nil
}

// BanMachine 按设备指纹封禁 / 解封。
//
// 和 BanNode 的区别只在**拿什么定位**，之后做的事一模一样：封禁要把这个指纹下
// 还活着的节点逐台从控制面摘掉、把贡献行关掉。少了这一步，被封的机器在下一次
// Hub 重启时会被连人带贡献装回池子。
func (s *service) BanMachine(ctx context.Context, req dto.BanMachineRequest) error {
	fingerprint := strings.TrimSpace(req.Fingerprint)
	if fingerprint == "" {
		return errors.New("缺少设备指纹")
	}
	if err := s.repository.SetMachineBanned(ctx, &repository.GalaxyMachineBan{
		BizLine: bizLine, MachineFingerprint: fingerprint, Banned: req.Banned,
		Reason: truncate(req.Reason, 255), UpdatedBy: truncate(req.UpdatedBy, 64),
	}); err != nil {
		return err
	}
	if !req.Banned {
		return nil
	}
	targets, err := s.repository.NodeIDsByFingerprint(ctx, bizLine, fingerprint)
	if err != nil {
		return err
	}
	for _, target := range targets {
		if err := s.dropBannedNode(ctx, target); err != nil {
			return err
		}
	}
	return nil
}
