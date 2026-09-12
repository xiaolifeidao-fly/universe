package galaxy

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"

	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 信誉跟着谁走，看提供者的身份：
//
//	散户（默认）  跟着账号。名下几台机器共用一份分数，换机器、重配对都不清零。
//	工作室        跟着设备。按设备指纹记，每台机器各算各的，换账号去配也还是那份。
//
// 不挂在节点或贡献上：每配一次对就是一个新 nodeId，贡献 id 又带着 nodeId 前缀，
// 记在那两处等于解绑重配就清零。
//
// 扣分同时记在账号和设备两份上，读哪一份看账号当下的身份 —— 管理端改身份时分数不清零，
// 另一份一直在记。设备指纹由节点自己上报，能被改过的客户端伪造；工作室的这层风险
// 靠后续的接口加签和设备指纹管控来收。
//
// 分数只在出事时往下扣（抽检、争议、节点故障、用量对不上），平时按天回升，封顶 1。
// 库里存「上次结算时的分数 + 结算时刻」，此刻的分数现算，不需要定时任务去加。

// DefaultReputationRecoveryPerDay 每天回升多少。节点故障一次扣 0.05，一天回来；
// 抽检判伪造一次扣 0.5，十天回来；从 0 回到满分二十天。
const DefaultReputationRecoveryPerDay = 0.05

// EffectiveReputation 此刻的信誉：上次结算的分数，加上从那以后回升的部分，封顶 1。
func EffectiveReputation(settled float64, settledAt time.Time, recoveryPerDay float64, now time.Time) float64 {
	score := settled
	if !settledAt.IsZero() && now.After(settledAt) && recoveryPerDay > 0 {
		score += recoveryPerDay * now.Sub(settledAt).Hours() / 24
	}
	return clamp01(score)
}

var fingerprintPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// normalizeFingerprint 只认节点侧算出来的 sha256 十六进制串，别的一律当没报。
//
// 不合格也不报错：指纹决定工作室的信誉记在哪，不是接入的前提 —— 老版本节点根本不报。
func normalizeFingerprint(raw string) string {
	value := strings.ToLower(strings.TrimSpace(raw))
	if !fingerprintPattern.MatchString(value) {
		return ""
	}
	return value
}

func accountSubject(ownerUserID string) string { return "account:" + ownerUserID }

// deviceSubject 设备那一份。报过指纹的按指纹；没报过的老版本节点只能拿节点自己当设备。
func deviceSubject(node *repository.GalaxyNode) string {
	if node.MachineFingerprint != "" {
		return "device:" + node.MachineFingerprint
	}
	return "node:" + node.NodeID
}

// reputationSubject 这台节点的信誉读哪一份：散户看账号，工作室看设备。
func reputationSubject(node *repository.GalaxyNode, providerType string) string {
	if providerType == dto.ProviderStudio {
		return deviceSubject(node)
	}
	return accountSubject(node.OwnerUserID)
}

// rememberMachine 记下节点报上来的设备指纹。只补不改（见 FillNodeFingerprint）。
func (s *service) rememberMachine(ctx context.Context, nodeID, rawFingerprint string) error {
	fingerprint := normalizeFingerprint(rawFingerprint)
	if fingerprint == "" {
		return nil
	}
	return s.repository.FillNodeFingerprint(ctx, bizLine, nodeID, fingerprint)
}

// providerTypes 这些账号的身份。没有行的是散户。
func (s *service) providerTypes(ctx context.Context, ownerUserIDs []string) (map[string]string, error) {
	rows, err := s.repository.ListProviders(ctx, bizLine, ownerUserIDs)
	if err != nil {
		return nil, err
	}
	types := make(map[string]string, len(ownerUserIDs))
	for _, owner := range ownerUserIDs {
		types[owner] = dto.ProviderIndividual
	}
	for _, row := range rows {
		if row.ProviderType == dto.ProviderStudio {
			types[row.OwnerUserID] = dto.ProviderStudio
		}
	}
	return types, nil
}

// nodeReputations 这些节点此刻的信誉，按 nodeId 索引；顺带交出每个主人的身份，列表视图要显示。
// 没被扣过分的主体没有行，是满分。
func (s *service) nodeReputations(ctx context.Context, nodes []*repository.GalaxyNode, now time.Time) (map[string]float64, map[string]string, error) {
	owners := make([]string, 0, len(nodes))
	seen := map[string]bool{}
	for _, node := range nodes {
		if !seen[node.OwnerUserID] {
			seen[node.OwnerUserID] = true
			owners = append(owners, node.OwnerUserID)
		}
	}
	types, err := s.providerTypes(ctx, owners)
	if err != nil {
		return nil, nil, err
	}
	subjects := make([]string, 0, len(nodes))
	for _, node := range nodes {
		subjects = append(subjects, reputationSubject(node, types[node.OwnerUserID]))
	}
	rows, err := s.repository.ListReputations(ctx, bizLine, subjects)
	if err != nil {
		return nil, nil, err
	}
	bySubject := make(map[string]*repository.GalaxyReputation, len(rows))
	for _, row := range rows {
		bySubject[row.Subject] = row
	}
	out := make(map[string]float64, len(nodes))
	for _, node := range nodes {
		out[node.NodeID] = 1
		if row, ok := bySubject[reputationSubject(node, types[node.OwnerUserID])]; ok {
			out[node.NodeID] = EffectiveReputation(row.Reputation, row.ReputationAt, s.config.ReputationRecoveryPerDay, now)
		}
	}
	return out, types, nil
}

func (s *service) nodeReputation(ctx context.Context, node *repository.GalaxyNode, now time.Time) (float64, error) {
	reputations, _, err := s.nodeReputations(ctx, []*repository.GalaxyNode{node}, now)
	if err != nil {
		return 0, err
	}
	return reputations[node.NodeID], nil
}

// adjustReputation 给承接这条贡献的机器和它的主人扣分：账号、设备两份都记。
//
// 不在这里写控制面：下一次心跳（15 秒内）会把新分数带过去；而扣分往往正是因为
// 这台机器出了事，它的快照这时候可能已经过期，写也写不进去。
func (s *service) adjustReputation(ctx context.Context, cid string, delta float64) error {
	contribution, err := s.repository.FindContribution(ctx, bizLine, cid)
	if err != nil {
		return err
	}
	node, err := s.repository.FindNode(ctx, bizLine, contribution.NodeID)
	if err != nil {
		return err
	}
	subjects := []string{accountSubject(node.OwnerUserID), deviceSubject(node)}
	return s.repository.AdjustReputation(ctx, bizLine, subjects, delta, s.config.ReputationRecoveryPerDay, time.Now())
}

// SetProviderType 管理端改账号身份。立刻生效在库里；派单读到的分数随下一次心跳（15 秒内）换过去。
//
// 只认存在的共享端账号：身份表没有外键，不查的话一个打错的 id、一个使用端的 id
// 都能写进去一行，看起来设成功了，却永远不会有哪台机器按它读分。
func (s *service) SetProviderType(ctx context.Context, req dto.SetProviderTypeRequest) error {
	owner := strings.TrimSpace(req.OwnerUserID)
	if owner == "" {
		return fmt.Errorf("缺少要设置的账号")
	}
	switch req.ProviderType {
	case dto.ProviderIndividual, dto.ProviderStudio:
	default:
		return fmt.Errorf("非法的提供者身份: %s", req.ProviderType)
	}
	// 只在共享端那张表里找：散户 / 工作室是共享端才有的身份，
	// 一个使用端的账号 id 传进来查不到，报的就是「共享端账号不存在」。
	if _, err := s.repository.FindUser(ctx, bizLine, dto.SideProvider, owner); repository.IsNotFound(err) {
		return fmt.Errorf("共享端账号不存在: %s", owner)
	} else if err != nil {
		return err
	}
	return s.repository.SaveProviderType(ctx, &repository.GalaxyProvider{
		BizLine: bizLine, OwnerUserID: owner, ProviderType: req.ProviderType, UpdatedBy: truncate(req.UpdatedBy, 64),
	})
}
