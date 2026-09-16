package galaxy

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"service/galaxy/dto"
)

// 信誉的运营视角。
//
// 信誉表此前在管理端只露出一个派生值：节点列表上每条贡献旁边那个分数。
// 那有两个问题 ——
//
//  1. **被扣了分的主体不一定还在节点列表上**。信誉按 account: / device: 记，
//     机器撤销、重装、换了 node_id 之后，那份 device: 记录就没有任何入口看得到了
//     （和封禁名单同一个毛病）。
//  2. **没有任何地方能把分数改回去**。抽检误判、探针本身出错，扣掉的分只能等它
//     按天自己回升 —— 而回升速率是按天算的，一次误判够那台机器少接好几天单。

// defaultReputationThreshold 名单默认只列低于它的。满分是 1。
const defaultReputationThreshold = 0.999

// AdminReputations 信誉名单：分数没满的那些主体。
func (s *service) AdminReputations(ctx context.Context, threshold float64, limit int) (dto.ReputationPage, error) {
	if threshold <= 0 || threshold > 1 {
		threshold = defaultReputationThreshold
	}
	// 库里存的是「结算时刻的分数」，此刻的要按回升速率现算。所以取的时候放宽到 1：
	// 按库里的数去卡阈值，会把早就自然回满的主体一直挂在名单上。
	rows, err := s.repository.ListLowReputations(ctx, bizLine, 1, pageLimit(limit, 100, 500))
	if err != nil {
		return dto.ReputationPage{}, err
	}
	now := time.Now()
	page := dto.ReputationPage{
		Threshold: threshold, RecoveryPerDay: s.cfg().ReputationRecoveryPerDay,
		Records: make([]dto.ReputationView, 0, len(rows)),
	}

	fingerprints := make([]string, 0, len(rows))
	accounts := make([]string, 0, len(rows))
	kept := make([]dto.ReputationView, 0, len(rows))
	for _, row := range rows {
		effective := EffectiveReputation(row.Reputation, row.ReputationAt, s.cfg().ReputationRecoveryPerDay, now)
		if effective >= threshold {
			continue // 已经自己回满了，不该还挂在名单上
		}
		kind, ref := splitSubject(row.Subject)
		kept = append(kept, dto.ReputationView{
			Subject: row.Subject, Kind: kind, Ref: ref,
			Settled: row.Reputation, Effective: effective,
			SettledAt: row.ReputationAt, UpdatedAt: row.UpdatedTime,
			Nodes: []dto.BannedMachineNode{},
		})
		switch kind {
		case "device":
			fingerprints = append(fingerprints, ref)
		case "account":
			accounts = append(accounts, ref)
		}
	}

	// 两条不同的路：device: 那一类按指纹找机器，account: 那一类按主人找。
	// 只走指纹的话，账号型的信誉一台机器都查不到，界面上会说「节点记录已不在」——
	// 而那些机器其实好端端地在线。
	byFingerprint, err := s.repository.NodesByFingerprints(ctx, bizLine, uniqueStrings(fingerprints))
	if err != nil {
		return dto.ReputationPage{}, err
	}
	byOwner, err := s.repository.NodesByOwners(ctx, bizLine, uniqueStrings(accounts))
	if err != nil {
		return dto.ReputationPage{}, err
	}
	owners := append([]string{}, accounts...)
	for _, group := range byFingerprint {
		for _, node := range group {
			owners = append(owners, node.OwnerUserID)
		}
	}
	names, err := s.userNames(ctx, dto.SideProvider, owners)
	if err != nil {
		return dto.ReputationPage{}, err
	}

	for _, view := range kept {
		nodes := byFingerprint[view.Ref]
		if view.Kind == "account" {
			view.OwnerName = names[view.Ref]
			nodes = byOwner[view.Ref]
		}
		for _, node := range nodes {
			view.Nodes = append(view.Nodes, dto.BannedMachineNode{
				NodeID: node.NodeID, DisplayName: node.DisplayName,
				OwnerUserID: node.OwnerUserID, OwnerName: names[node.OwnerUserID],
				Status: node.Status,
			})
		}
		page.Records = append(page.Records, view)
	}
	return page, nil
}

// splitSubject 把 account:cu_01J… 拆成 ("account", "cu_01J…")。
// 没有前缀的（老数据）算 node，整串当引用 —— 不硬塞进已知的三类里，
// 界面照样显示得出来，而把它归成 account 会让人以为那是个账号 id。
func splitSubject(subject string) (string, string) {
	index := strings.Index(subject, ":")
	if index <= 0 {
		return "node", subject
	}
	return subject[:index], subject[index+1:]
}

// SetReputation 人工把一个主体的信誉设成某个值。
//
// **设成，不是加减**：运营想的是「这次是误判，恢复到满分」这种确定结果，
// 而叠加式的 +0.3 在一个被扣到 0.2 的主体上给出的是 0.5 —— 点两次又是另一个数。
//
// 设完把结算时刻推到此刻：不推的话，这个新分数会立刻被「从上次结算到现在」的
// 回升量再加一遍，运营设的 0.5 实际落地成 0.5 + 好几天的回升。
func (s *service) SetReputation(ctx context.Context, req dto.SetReputationRequest) error {
	subject := strings.TrimSpace(req.Subject)
	if subject == "" {
		return errors.New("缺少要处置的主体")
	}
	if req.Value < 0 || req.Value > 1 {
		return fmt.Errorf("信誉分要在 0 到 1 之间，收到 %v", req.Value)
	}
	if strings.TrimSpace(req.Reason) == "" {
		// 信誉直接决定这台机器还能不能接到单。改它要说得出为什么。
		return errors.New("请写明为什么改这个分数")
	}
	return s.repository.SetReputation(ctx, bizLine, subject, req.Value, time.Now())
}
