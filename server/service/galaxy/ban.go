package galaxy

import (
	"context"
	"fmt"
	"strings"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 平台封禁跟着设备走，不跟着节点记录走。
//
// 节点记录封不住一台机器：每配一次对就是一个新 nodeId，配对闸（pairedOnline）也不看封禁的节点，
// 被封的机器解绑重配、或者换个账号去配，回来的就是一条干净的记录。所以报过设备指纹的节点，
// 封的是它的指纹（zt_galaxy_machine_ban），和提供者是散户还是工作室无关：同一台设备上的每条记录，
// 不管挂在哪个账号下，一起封、一起解。
//
// 请求路径上唯一看的仍然是节点行上的 banned —— 节点通道的每个请求都要过鉴权，不能为它每次多查一张表。
// 封禁表的结论在两个时刻落到节点行上：
//
//	封禁 / 解封时  带这个指纹的节点记录一起改（BanNode → repository.SetMachineBanned）
//	hello 时       指纹要到 hello 才报上来，新配出来的记录在这里补标（refuseBannedMachine）
//
// 配对和接入密钥注册认不出是哪台设备：那两个请求里没有指纹。被封的机器照样能拿到一条新记录，
// 到第一次 hello 才被拒、被标上；在那之前这条记录一行贡献都没有，派不到活。
//
// 没报过指纹的老节点认不出是哪台设备，只能封那一条记录，和以前一样。
//
// 指纹是节点自己报的：改过的客户端可以报一个假的；拿不到系统机器 id 的环境（容器、精简系统）
// 用的是运行目录里的随机 id，删掉重装就换了一个。所以它挡的是正常客户端重新配对、换账号，
// 挡不住有意的伪造。

// BanNode 封禁 / 解封一台机器。
//
// 和主人自己「撤销」的区别：撤销是把令牌作废，主人重新配对就能回来；
// 封禁是平台的处置，主人解不开，而且立刻把它的贡献从候选里摘掉。
//
// 解封不把贡献打开，和以前一样：那些贡献是封禁时关的，还要不要共享得主人自己回控制台点。
func (s *service) BanNode(ctx context.Context, req dto.BanNodeRequest) error {
	nodeID := strings.TrimSpace(req.NodeID)
	if nodeID == "" {
		return fmt.Errorf("缺少要处置的机器")
	}
	node, err := s.repository.FindNode(ctx, bizLine, nodeID)
	if notFound(err) {
		return fmt.Errorf("找不到这台机器")
	}
	if err != nil {
		return err
	}
	if node.MachineFingerprint == "" {
		err = s.repository.SetNodeBanned(ctx, bizLine, node.NodeID, req.Banned)
	} else {
		err = s.repository.SetMachineBanned(ctx, &repository.GalaxyMachineBan{
			BizLine: bizLine, MachineFingerprint: node.MachineFingerprint, Banned: req.Banned,
			Reason: truncate(req.Reason, 255), UpdatedBy: truncate(req.UpdatedBy, 64),
		})
	}
	if err != nil || !req.Banned {
		return err
	}
	targets := []string{node.NodeID}
	if node.MachineFingerprint != "" {
		if targets, err = s.repository.NodeIDsByFingerprint(ctx, bizLine, node.MachineFingerprint); err != nil {
			return err
		}
	}
	for _, target := range targets {
		if err := s.dropBannedNode(ctx, target); err != nil {
			return err
		}
	}
	return nil
}

// dropBannedNode 把一台被封的机器从池子里摘干净：控制面里的贡献立刻摘掉，库里的贡献行关掉。
// 只摘控制面不够，理由见 DisableContributionsByNode：留下的 active 贡献行会进池水位，
// Hub 重启时还会被装回控制面。
func (s *service) dropBannedNode(ctx context.Context, nodeID string) error {
	if err := s.control.DropNode(ctx, nodeID); err != nil {
		return err
	}
	return s.repository.DisableContributionsByNode(ctx, bizLine, nodeID)
}

// refuseBannedMachine hello 的封禁闸：这台机器被封了，hello 就到此为止。
//
// 调用方要把它排在 rememberMachine 之后、同步能力清单之前：新配出来的记录补上指纹那一刻
// 才认得出是哪台设备；被拒的记录一行贡献都不落，就没有东西进池子。
func (s *service) refuseBannedMachine(ctx context.Context, nodeID, rawFingerprint string) error {
	if err := s.repository.BanNodeIfMachineBanned(ctx, bizLine, nodeID); err != nil {
		return err
	}
	node, err := s.repository.FindNode(ctx, bizLine, nodeID)
	if err != nil {
		return err
	}
	// 读回来再判，不看上面那条语句改没改到行：管理端的封禁可能刚好先一步把这条记录标上了。
	if node.Banned {
		// 顺手清场：老版本节点升级后第一次报指纹，身上可能还带着开着的贡献。清不掉也照样拒 ——
		// 记录已经标上，之后的请求在鉴权就被挡下；漏下的贡献行，管理端对这台设备再封一次会补清。
		_ = s.dropBannedNode(ctx, node.NodeID)
		return contract.ErrNodeBanned
	}
	other := reportedOtherMachine(node, rawFingerprint)
	if other == "" {
		return nil
	}
	banned, err := s.repository.MachineBanned(ctx, bizLine, other)
	if err != nil {
		return err
	}
	if banned {
		return contract.ErrNodeBanned
	}
	return nil
}

// reportedOtherMachine 这次 hello 报上来的指纹和记录上的不一样时返回它：令牌被拷到了另一台机器上。
//
// 那台机器被封了，也不许它 hello 成功；但不去标这条记录 —— 记录代表的是配对时的那台机器
// （见 FillNodeFingerprint），被封的不是它。报的和记录上一样、没报、报得不合格，都返回空串。
func reportedOtherMachine(node *repository.GalaxyNode, rawFingerprint string) string {
	reported := normalizeFingerprint(rawFingerprint)
	if reported == "" || reported == node.MachineFingerprint {
		return ""
	}
	return reported
}
