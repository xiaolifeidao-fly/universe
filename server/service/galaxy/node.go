package galaxy

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 提供者侧：同意 → 配对 → hello 申报贡献 → 心跳。
// 授权对象是平台，不指定消费者；请求路由到哪个贡献由放置算法决定（P-17）。

const (
	subjectProvider = "provider"
	subjectConsumer = "consumer"

	statusActive   = "active"
	statusDraining = "draining"
	statusPaused   = "paused"
	statusDisabled = "disabled"

	pairingCodeTTL = 10 * time.Minute
)

func (s *service) AcceptTerms(ctx context.Context, req dto.AcceptTermsRequest) error {
	if req.UserID == "" || req.TermsVersion == "" {
		return fmt.Errorf("缺少用户或条款版本")
	}
	subject := subjectProvider
	if req.SubjectType == subjectConsumer {
		subject = subjectConsumer
	}
	return s.repository.SaveConsent(ctx, &repository.GalaxyConsentRecord{
		BizLine:      bizLine,
		SubjectType:  subject,
		UserID:       req.UserID,
		TermsVersion: req.TermsVersion,
		AcceptedAt:   time.Now(),
		IP:           req.IP,
		UserAgent:    truncate(req.UserAgent, 256),
	})
}

func (s *service) HasConsent(ctx context.Context, subjectType, userID, termsVersion string) (bool, error) {
	if userID == "" {
		return false, nil
	}
	_, err := s.repository.LatestConsent(ctx, bizLine, subjectType, userID, termsVersion)
	if notFound(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// IssuePairingCode 只对已记录当前条款版本同意的提供者签发（P-16）。
func (s *service) IssuePairingCode(ctx context.Context, req dto.IssuePairingCodeRequest) (dto.PairingCodeView, error) {
	terms := req.TermsVersion
	if terms == "" {
		terms = s.cfg().ProviderTermsVersion
	}
	if terms != s.cfg().ProviderTermsVersion {
		return dto.PairingCodeView{}, fmt.Errorf("条款版本已更新，请重新阅读并同意")
	}
	agreed, err := s.HasConsent(ctx, subjectProvider, req.OwnerUserID, terms)
	if err != nil {
		return dto.PairingCodeView{}, err
	}
	if !agreed {
		return dto.PairingCodeView{}, contract.ErrConsentRequired
	}
	// 签发时不看名下有没有机器在线：码还不知道会被哪台电脑拿去用，
	// 「这台电脑是不是已经配过」只能在兑换时凭 previousNodeId 判断（见 Pair）。
	row := &repository.GalaxyPairingCode{
		BizLine:      bizLine,
		Code:         pairingCode(),
		OwnerUserID:  req.OwnerUserID,
		TermsVersion: terms,
		ExpiresAt:    time.Now().Add(pairingCodeTTL),
	}
	if err := s.repository.CreatePairingCode(ctx, row); err != nil {
		return dto.PairingCodeView{}, err
	}
	return dto.PairingCodeView{Code: row.Code, ExpiresAt: row.ExpiresAt}, nil
}

// Pair 兑换配对码换取长期 node token。同意记录在这里再校验一次 ——
// 配对码可能是条款升版之前签发的。
func (s *service) Pair(ctx context.Context, req dto.PairRequest) (dto.PairResult, error) {
	now := time.Now()
	nodeID := "n_" + NewULID(now)
	code, err := s.repository.TakePairingCode(ctx, bizLine, strings.ToUpper(strings.TrimSpace(req.Code)), nodeID, now)
	if notFound(err) {
		return dto.PairResult{}, fmt.Errorf("配对码无效或已过期")
	}
	if err != nil {
		return dto.PairResult{}, err
	}
	agreed, err := s.HasConsent(ctx, subjectProvider, code.OwnerUserID, s.cfg().ProviderTermsVersion)
	if err != nil {
		return dto.PairResult{}, err
	}
	if !agreed {
		return dto.PairResult{}, contract.ErrConsentRequired
	}
	if err := s.assertMachineNotPaired(ctx, code.OwnerUserID, req.PreviousNodeID); err != nil {
		return dto.PairResult{}, err
	}

	secret := "gnt_" + randomToken(32)
	node := &repository.GalaxyNode{
		BizLine:         bizLine,
		NodeID:          nodeID,
		OwnerUserID:     code.OwnerUserID,
		DisplayName:     truncate(req.DisplayName, 128),
		TokenHash:       HashSecret(secret),
		BridgeVersion:   truncate(req.BridgeVersion, 32),
		ContractVersion: s.cfg().ContractVersion,
		Status:          statusActive,
		LastBeatAt:      &now,
	}
	if err := s.repository.SaveNode(ctx, node); err != nil {
		return dto.PairResult{}, err
	}
	// 新节点已经落库，再去退役旧的那条 —— 顺序反了万一 SaveNode 失败，
	// 主人就既没有新节点、旧的也被撤了。
	if previous := strings.TrimSpace(req.PreviousNodeID); previous != "" && previous != nodeID {
		s.retirePreviousNode(ctx, previous, code.OwnerUserID)
	}
	return dto.PairResult{NodeID: nodeID, Token: secret}, nil
}

// assertMachineNotPaired 同一台电脑只能配对一次：它上一次配对出来的节点还在线，就不再放行。
//
// 以前这里拦的是「名下任何一台在线」。那是一个账号只有一台 Nova 的年代定的规矩；
// 现在主人名下常常同时有这台电脑和机房里用接入密钥注册的服务器，服务器在线
// 挡住这台电脑重新加入，等于逼主人为了配自己的笔记本去把服务器停掉。
// 所以只看**这台电脑自己**：它由本机令牌文件里上一次的 nodeId 认出来（previousNodeId）。
//
// 上一次的节点已经离线、被撤销（令牌被拒、在控制台解绑过）就放行 —— 配对成功后
// retirePreviousNode 会把旧记录退役，这台电脑名下始终只留一条。认不出来的
// （本机令牌文件没了）只能当新电脑处理。
func (s *service) assertMachineNotPaired(ctx context.Context, ownerUserID, previousNodeID string) error {
	previousNodeID = strings.TrimSpace(previousNodeID)
	if previousNodeID == "" {
		return nil
	}
	row, err := s.repository.FindNode(ctx, bizLine, previousNodeID)
	if notFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	paired := pairedOnline(row, ownerUserID)
	if paired == nil {
		return nil
	}
	name := paired.DisplayName
	if name == "" {
		name = paired.NodeID
	}
	return fmt.Errorf("这台电脑已经配对过（%s），现在在线，不需要再配对；确实要重新配对，请先在控制台解绑它", name)
}

// pairedOnline 这台电脑上一次配对出来的节点是否还「配着、在线」，是就返回它。
//
// 判活以节点 status 为准：巡检每分钟把心跳过期的降为 offline，控制台机器列表上
// 那个绿标看的也是它，两边必须是同一条标准。封禁的不算 —— 它已经接不了活，
// 拿它挡住配对只会让主人卡在一台没用的节点上。别的主人名下的也不算：
// previousNodeId 是客户端传的，只认同一个主人，和 retirePreviousNode 同一条线。
func pairedOnline(previous *repository.GalaxyNode, ownerUserID string) *repository.GalaxyNode {
	if previous == nil || previous.OwnerUserID != ownerUserID {
		return nil
	}
	if previous.Banned || previous.Status != statusActive {
		return nil
	}
	return previous
}

// retirePreviousNode 把同一台机器上一次配对出来的节点退役。
//
// 为什么需要：Pair 每次都新建 node（nodeID 是新的 ULID），所以同一台机器每重新
// 配对一次就多一条记录，旧的那条永远停在「离线」。主人看到的是列表里越堆越多的
// 僵尸机器；更糟的是它们的贡献行还留在库里 —— 「改授权改到了别的机器上」那个 bug
// 就是从这儿来的。
//
// 只退役**同一个主人**名下的节点：previousNodeId 是客户端传的，不校验的话，
// 任何拿到一张配对码的人都能顺手把别人的机器踢下线。
//
// 刻意不要求「证明你持有旧令牌」：重新配对的最常见原因恰恰是旧令牌已经失效
// （被撤销、库重建过）。校验到同主人就够了 —— 能拿到这张配对码的人，
// 本来就能往这个账号里加机器，退役他自己的一台不扩大任何权限。
//
// 失败一律静默：新节点已经建好，配对本身是成功的。为一次可选的清理让整个配对
// 报错回滚，代价远大于多留一个僵尸。
func (s *service) retirePreviousNode(ctx context.Context, nodeID, ownerUserID string) {
	row, err := s.repository.FindNode(ctx, bizLine, nodeID)
	if err != nil || row == nil || row.OwnerUserID != ownerUserID {
		return
	}
	// 走和主人自己点「撤销」同一条路：退役也要把那台机器的贡献行一起关掉，
	// 否则巡检又会把它判成离线、连人带贡献一起搬回总览 —— 重新配对之后
	// 看到的「同一台机器出现两次」就是这么来的。
	_ = s.RevokeNode(ctx, ownerUserID, nodeID)
}

// AuthenticateNode 节点通道的鉴权入口。撤销后 token_hash 置空，这里查不到即 401。
func (s *service) AuthenticateNode(ctx context.Context, token string) (NodeIdentity, error) {
	token = strings.TrimSpace(strings.TrimPrefix(token, "Bearer "))
	if token == "" {
		return NodeIdentity{}, fmt.Errorf("缺少节点令牌")
	}
	row, err := s.repository.FindNodeByTokenHash(ctx, bizLine, HashSecret(token))
	if notFound(err) {
		return NodeIdentity{}, fmt.Errorf("节点令牌无效")
	}
	if err != nil {
		return NodeIdentity{}, err
	}
	// 封禁只看节点行上这一列，不去查封禁表：每个节点请求都要过这里。按设备的封禁会在封禁时、
	// 以及新记录 hello 时落到这一列上（见 ban.go）。
	if row.Banned {
		return NodeIdentity{}, contract.ErrNodeBanned
	}
	if row.Status == "revoked" {
		return NodeIdentity{}, fmt.Errorf("节点已被停用")
	}
	return NodeIdentity{NodeID: row.NodeID, OwnerUserID: row.OwnerUserID, DisplayName: row.DisplayName, Banned: row.Banned}, nil
}

// Hello 对齐该节点的**能力清单**，并把主人在控制台定下的生效配置发回去。
//
// 权威归属：节点报「本机有什么、能不能用」，Hub 存「共享不共享、共享多少」。
// 所以这里既不删行、也不碰 status / seats / models / schedule / 额度 ——
// 那些是主人的设置，被一次重启覆盖掉等于每次都要重配一遍。
//
// 这推翻了原设计的 P-03「未勾选的能力 Hub 不可见」：要让主人在控制台上勾，
// 平台就必须先知道有什么可勾。代价是平台在主人同意共享之前就知道这台机器上
// 装了 Claude 还是 Codex —— 这是明确的产品决定，条款正文也要跟着改。
func (s *service) Hello(ctx context.Context, req dto.HelloRequest) (dto.HelloResult, error) {
	if req.Contract != s.cfg().ContractVersion {
		return dto.HelloResult{}, contract.NewUnitError(contract.ErrorClassProtocol, contract.CodeContractMismatch, false,
			fmt.Sprintf("节点契约版本 %d 与 Hub 的 %d 不一致，请升级 ai-bridge", req.Contract, s.cfg().ContractVersion))
	}
	agreed, err := s.HasConsent(ctx, subjectProvider, req.OwnerUserID, s.cfg().ProviderTermsVersion)
	if err != nil {
		return dto.HelloResult{}, err
	}
	if !agreed {
		return dto.HelloResult{}, contract.ErrConsentRequired
	}

	now := time.Now()
	result := dto.HelloResult{QuotaEffective: map[string][]dto.QuotaGrantInput{}}
	inventory := make([]*repository.GalaxyContribution, 0, len(req.Contributions))

	// 指纹要赶在下面算生效集合之前记下：快照里的信誉按它去找这台机器的分数。
	if err := s.rememberMachine(ctx, req.NodeID, req.MachineFingerprint); err != nil {
		return dto.HelloResult{}, err
	}
	// 封禁跟着设备走（见 ban.go）：指纹刚记下，这台设备被封了就停在这里，能力清单一行都不落。
	if err := s.refuseBannedMachine(ctx, req.NodeID, req.MachineFingerprint); err != nil {
		return dto.HelloResult{}, err
	}

	for _, input := range req.Contributions {
		spec, err := s.validateCapability(input)
		if err != nil {
			result.Rejected = append(result.Rejected, struct {
				CID    string `json:"cid"`
				Reason string `json:"reason"`
			}{CID: input.CID, Reason: err.Error()})
			continue
		}
		// 新能力默认是关的：探测到不等于愿意共享，那一下点头必须由主人来做。
		// 已经存在的行不会被这里的 Status 覆盖（见 SyncContributionInventory）。
		inventory = append(inventory, &repository.GalaxyContribution{
			BizLine: bizLine, CID: scopedCID(req.NodeID, input.CID),
			NodeID: req.NodeID, OwnerUserID: req.OwnerUserID,
			Kind: spec.Kind, KindVersion: spec.Version, Provider: input.Provider,
			Status:            statusDisabled,
			Available:         input.Available == nil || *input.Available,
			UnavailableReason: truncate(input.UnavailableReason, 256),
			// 截断而不是拒绝：模型清单只是候选项，一个上游返回几百个模型
			// 不该让整台机器的 hello 失败。
			ModelsAvailableJSON: truncate(encodeStrings(input.AvailableModels), 4096),
		})
		result.Accepted = append(result.Accepted, input.CID)
	}

	if err := s.repository.SyncContributionInventory(ctx, bizLine, req.NodeID, inventory); err != nil {
		return dto.HelloResult{}, err
	}

	node, err := s.repository.FindNode(ctx, bizLine, req.NodeID)
	if err != nil {
		return dto.HelloResult{}, err
	}
	plan, err := s.effectiveContributions(ctx, node, req.Resources, now)
	if err != nil {
		return dto.HelloResult{}, err
	}
	result.Enabled = plan.Enabled
	result.QuotaEffective = plan.Quota

	// 接入方式跟着 hello 一起对齐：公网地址会变，只在注册时记一次的话，
	// Hub 会拿着一个早就失效的地址一直回连不上（见 applyNodeAccess 的注释）。
	// 失败不阻断 hello —— 对不齐最坏是这台机器退回长轮询，而 hello 失败是它彻底不接活。
	if mode, err := s.applyNodeAccess(ctx, req.NodeID, req.AccessMode, req.Endpoint); err != nil {
		s.metrics.Count(MetricAccessSyncFailed, map[string]string{"nodeId": req.NodeID}, 1)
	} else {
		result.AccessMode = mode
	}

	if err := s.control.RegisterNode(ctx, NodeRuntime{
		NodeID:        req.NodeID,
		OwnerUserID:   req.OwnerUserID,
		BridgeVersion: req.BridgeVersion,
		Contract:      req.Contract,
		Resources:     req.Resources,
		Instance:      s.cfg().Instance,
		LastBeatAt:    now,
	}); err != nil {
		return dto.HelloResult{}, err
	}
	if err := s.pushToControlPlane(ctx, req.NodeID, plan, now); err != nil {
		return dto.HelloResult{}, err
	}
	if err := s.repository.SaveNode(ctx, &repository.GalaxyNode{
		BizLine: bizLine, NodeID: req.NodeID, OwnerUserID: req.OwnerUserID,
		BridgeVersion: truncate(req.BridgeVersion, 32), ContractVersion: req.Contract,
		ResourcesJSON: encodeJSON(req.Resources), Status: statusActive, LastBeatAt: &now,
	}); err != nil {
		return dto.HelloResult{}, err
	}
	// 机器上的 ai-bridge 是什么、能不能被远程升级：跟着每次 hello 更新。
	//
	// 写不进去不中断 hello。这几列只服务于展示与升级按钮，而 hello 失败意味着
	// 这台机器整个不接活 —— 两件事的代价差着数量级。
	if err := s.repository.SaveNodeBridgeInfo(ctx, bizLine, req.NodeID,
		truncate(req.Platform, 32), truncate(req.Distribution, 16), truncate(req.UpgradeBlocker, 255)); err != nil {
		s.metrics.Count(MetricNodeBridgeInfoFailed, map[string]string{"nodeId": req.NodeID}, 1)
	}
	// 一次远程升级成没成，只有重启之后的这一次 hello 说了算：节点报的「装好了」
	// 只说明文件换了，**跑起来的是哪一版**要看它现在报上来的版本。
	s.settleNodeUpgrade(ctx, node, req.BridgeVersion, now)
	// 空切片要发成 []，不能发成 null。
	//
	// Go 的 nil 切片序列化出去是 JSON 的 null，而节点侧是 Rust：serde 的 default
	// 只兜「字段缺失」，遇上显式 null 直接报错，于是**整个响应**解析失败，
	// 节点拿到一份默认值 —— enabled 成了 None，它当成「老版本 Hub，维持现状」，
	// 一条通道都不建。一个从来没人看的 rejected 字段，能让整台机器不接活。
	result.Accepted = orEmpty(result.Accepted)
	result.Rejected = orEmpty(result.Rejected)
	return result, nil
}

// validateCapability 校验节点上报的一项能力。只问「这套 Hub 认不认这个 kind /
// provider」——额度、座位、模型范围都是主人在控制台定的，节点报什么都不作数。
func unavailableReason(row *repository.GalaxyContribution) string {
	if row.Available {
		return ""
	}
	return row.UnavailableReason
}

func (s *service) validateCapability(input dto.ContributionInput) (contract.KindSpec, error) {
	return s.kinds.ValidateCapability(input.Kind, input.KindVersion, input.Provider)
}

// effectivePlan 是「这个节点这一刻该跑什么」算出来的结果，同时喂给节点和控制面。
type effectivePlan struct {
	// Enabled 下发给节点，让它按这个集合建通道。
	Enabled []dto.EnabledContribution
	// Snapshots 写进控制面，放置算法只看得到这些。
	Snapshots []ContributionSnapshot
	// Quota 是给节点更新展示副本用的生效额度。
	Quota  map[string][]dto.QuotaGrantInput
	Grants map[string][]QuotaGrant
	// Reputation 这台机器此刻的信誉，Snapshots 里每一条贡献带的都是它。
	Reputation float64
}

// effectiveContributions 把「主人开着 + 本机可用」的那些贡献算出来。
//
// 两个条件缺一不可，而且各自的失败要分得开：主人关掉的不该下发给节点，
// 本机不可用的（Claude 登录态过期）也不该进放置候选 —— 但后者主人的勾选要留着，
// 登录回来下一次心跳就自动恢复，不用他再点一次。
func (s *service) effectiveContributions(ctx context.Context, node *repository.GalaxyNode, resources map[string]any, now time.Time) (effectivePlan, error) {
	nodeID := node.NodeID
	rows, err := s.repository.ListContributionsByNode(ctx, bizLine, nodeID)
	if err != nil {
		return effectivePlan{}, err
	}
	// 按真正的此刻算，不用 now：syncNodeToControlPlane 传进来的 now 是这台机器最近一次心跳，
	// 拿它算回升会少算关机那段时间。
	reputation, err := s.nodeReputation(ctx, node, time.Now())
	if err != nil {
		return effectivePlan{}, err
	}
	live := make([]*repository.GalaxyContribution, 0, len(rows))
	for _, row := range rows {
		// 判据是「主人没关 + 本机可用」，不是「status == active」。
		//
		// draining 也要留在下发集合里：额度触顶时心跳会把状态写成 draining，
		// 意思是「停止接新单、在跑的正常跑完」。要是这时候把它从集合里摘掉，
		// 节点会直接拆掉通道，跑到一半的请求当场断线 —— 排空的意义就没了。
		// 「要不要接新单」由心跳响应里的 Drain 列表单独表达，和这里是两件事。
		if row.Status != statusDisabled && row.Available {
			live = append(live, row)
		}
	}
	grants, err := s.loadGrants(ctx, cidsOf(live))
	if err != nil {
		return effectivePlan{}, err
	}
	plan := effectivePlan{
		Enabled:    make([]dto.EnabledContribution, 0, len(live)),
		Snapshots:  make([]ContributionSnapshot, 0, len(live)),
		Quota:      map[string][]dto.QuotaGrantInput{},
		Grants:     grants,
		Reputation: reputation,
	}
	for _, row := range live {
		snapshot := s.snapshotFromRow(row, grants[row.CID], now, reputation)
		snapshot.UpstreamOK = true
		// 资源跟着贡献走而不是另开一张节点表：放置的硬过滤在贡献这一层做，
		// 每次都去 join 一次节点会把「已绑定请求 ≤ 3 次 Redis 操作」这条打破。
		snapshot.Resources = resources
		plan.Snapshots = append(plan.Snapshots, snapshot)

		local := unscopedCID(nodeID, row.CID)
		quota := make([]dto.QuotaGrantInput, 0, len(grants[row.CID]))
		for _, grant := range grants[row.CID] {
			quota = append(quota, dto.QuotaGrantInput{
				Unit: grant.Unit, Limit: grant.Limit, Window: grant.Window, ResetAt: grant.ResetAt,
			})
		}
		plan.Quota[local] = quota
		plan.Enabled = append(plan.Enabled, dto.EnabledContribution{
			// 下发给节点的是**本机短名**：cid 在 Hub 侧带了 nodeId 前缀消歧，
			// 但节点只认自己起的那个名字（设计 2.7）。
			CID: local, Kind: row.Kind, KindVersion: row.KindVersion, Provider: row.Provider,
			ModelsAllow: orEmpty(decodeStrings(row.ModelsAllowJSON)),
			ModelsDeny:  orEmpty(decodeStrings(row.ModelsDenyJSON)),
			Seats:       row.Seats, SeatConcurrency: row.SeatConcurrency,
			Quota: quota, Schedule: orEmpty(decodeSchedule(row.ScheduleJSON)),
		})
	}
	return plan, nil
}

// pushToControlPlane 把算好的集合写进控制面：放置算法只看得到这里的东西。
func (s *service) pushToControlPlane(ctx context.Context, nodeID string, plan effectivePlan, now time.Time) error {
	if err := s.control.ReplaceContributions(ctx, nodeID, plan.Snapshots); err != nil {
		return err
	}
	for _, snapshot := range plan.Snapshots {
		quotaPlan := BuildQuotaPlan(plan.Grants[snapshot.CID], now)
		if _, _, err := s.control.SyncQuota(ctx, snapshot.CID, quotaPlan.Limits, quotaPlan.Windows); err != nil {
			return err
		}
	}
	return nil
}

func (s *service) validateContribution(input dto.ContributionInput) (contract.KindSpec, []QuotaGrant, error) {
	grants := make([]QuotaGrant, 0, len(input.Quota))
	units := make([]contract.MeterUnit, 0, len(input.Quota))
	for _, quota := range input.Quota {
		if quota.Limit <= 0 {
			continue
		}
		grants = append(grants, QuotaGrant{Unit: quota.Unit, Limit: quota.Limit, Window: quota.Window, ResetAt: quota.ResetAt})
		units = append(units, quota.Unit)
	}
	seats := defaultInt(input.Seats, 3)
	spec, err := s.kinds.ValidateContribution(input.Kind, input.KindVersion, input.Provider, units, seats, s.cfg().PlatformSeatLimit)
	if err != nil {
		return contract.KindSpec{}, nil, err
	}
	if len(grants) == 0 {
		return spec, nil, fmt.Errorf("贡献 %s 未配置任何额度上限", input.CID)
	}
	return spec, grants, nil
}

// Heartbeat 每 15s 一次。Hub 用它维护贡献快照，并搭车下发取消与额度更新。
func (s *service) Heartbeat(ctx context.Context, req dto.HeartbeatRequest) (dto.HeartbeatResult, error) {
	now := time.Now()
	runtimes := make([]LaneRuntime, 0, len(req.Lanes))
	for _, lane := range req.Lanes {
		runtime := LaneRuntime{
			CID:             scopedCID(req.NodeID, lane.CID),
			Inflight:        lane.Inflight,
			Queued:          lane.Queued,
			UpstreamOK:      lane.UpstreamOK == nil || *lane.UpstreamOK,
			Paused:          lane.Paused != nil && *lane.Paused,
			CachedArtifacts: capStrings(lane.CachedArtifacts, 64),
		}
		if lane.ThrottledUntil != nil {
			runtime.ThrottledUntil = *lane.ThrottledUntil
		}
		runtimes = append(runtimes, runtime)
	}
	if err := s.control.UpdateLaneRuntime(ctx, runtimes); err != nil {
		return dto.HeartbeatResult{}, err
	}
	registered, err := s.control.TouchNode(ctx, req.NodeID, now)
	if err != nil {
		return dto.HeartbeatResult{}, err
	}
	if !registered {
		// 登记项过期了（连着 24 小时只有心跳、没有一次 hello）。
		// 不能让心跳顺手 HSET 把它写回来 —— 那样重建出来的只有 lastBeat 和 status，
		// instance / ownerUserId / bridgeVersion / resources 全缺。数据库那一行是权威，
		// 照它整条重建，这台机器不用等到下一次 hello 才重新被 Hub 认出来。
		if err := s.registerNodeFromRow(ctx, req.NodeID, now); err != nil {
			return dto.HeartbeatResult{}, err
		}
	}
	_ = s.repository.TouchNode(ctx, bizLine, req.NodeID, now)

	cancels, err := s.control.TakeNodeCancels(ctx, req.NodeID)
	if err != nil {
		return dto.HeartbeatResult{}, err
	}

	// 额度到 100% 的贡献要排空；恢复由窗口翻转后的下一次心跳带回 ——
	// SyncQuota 用新窗口的空计数器重算余量，排空标记随之解除。
	rows, err := s.repository.ListContributionsByNode(ctx, bizLine, req.NodeID)
	if err != nil {
		return dto.HeartbeatResult{}, err
	}
	grants, err := s.loadGrants(ctx, cidsOf(rows))
	if err != nil {
		return dto.HeartbeatResult{}, err
	}
	for _, row := range rows {
		plan := BuildQuotaPlan(grants[row.CID], now)
		if _, _, err := s.control.SyncQuota(ctx, row.CID, plan.Limits, plan.Windows); err != nil {
			return dto.HeartbeatResult{}, err
		}
	}
	snapshots, err := s.control.ListNodeContributions(ctx, req.NodeID)
	if err != nil {
		return dto.HeartbeatResult{}, err
	}
	result := dto.HeartbeatResult{HubURL: s.cfg().ProviderHubURL, Cancel: cancels, QuotaUpdate: map[string]contract.Metering{}, ServerTime: now.UnixMilli()}
	for _, snapshot := range snapshots {
		s.observeLane(snapshot, now)
		local := unscopedCID(req.NodeID, snapshot.CID)
		result.QuotaUpdate[local] = snapshot.QuotaLeft()
		exhausted := ExhaustedUnits(snapshot)
		shouldDrain := len(exhausted) > 0
		if shouldDrain != snapshot.Draining {
			_ = s.control.SetDraining(ctx, snapshot.CID, shouldDrain)
			status := statusActive
			if shouldDrain {
				status = statusDraining
			}
			_ = s.repository.SetContributionStatus(ctx, bizLine, snapshot.CID, status)
		}
		if shouldDrain {
			result.Drain = append(result.Drain, local)
		}
		if s.notifier != nil {
			for _, unit := range WarnedUnits(snapshot) {
				s.notifier.NotifyQuotaWarning(ctx, snapshot.OwnerUserID, snapshot.CID, unit, snapshot.QuotaUsed[unit], snapshot.QuotaLimit[unit])
			}
		}
	}

	// 生效配置搭在心跳上下发。主人在控制台开关一条贡献、改额度或改时段，
	// 节点最迟一个心跳周期（15s）就换过来 —— 「随时随地能调」靠的就是这一条，
	// 不需要主人回到那台机器上做任何事。
	node, err := s.repository.FindNode(ctx, bizLine, req.NodeID)
	if err != nil {
		return dto.HeartbeatResult{}, err
	}
	plan, err := s.effectiveContributions(ctx, node, nil, now)
	if err != nil {
		return dto.HeartbeatResult{}, err
	}
	// 信誉每个心跳写一次控制面：它按天回升，扣分也随时会发生。只在 hello 时写的话，
	// 一台一直在线的机器，派单时用的永远是它上次重连那一刻的分数。
	live := make([]string, 0, len(snapshots))
	for _, snapshot := range snapshots {
		live = append(live, snapshot.CID)
	}
	if err := s.control.SetReputation(ctx, live, plan.Reputation); err != nil {
		return dto.HeartbeatResult{}, err
	}
	result.Enabled = plan.Enabled
	// 升级指令走的是同一条路：控制台点完，机器最多等一个心跳周期就收到。
	// 没有待执行的指令时它是 nil，序列化时整个字段省略。
	result.Upgrade = s.pendingUpgradeCommand(ctx, node, now)
	// 同 Hello：空切片发 []，不发 null，否则节点连这次心跳一起丢掉。
	result.Cancel = orEmpty(result.Cancel)
	result.Drain = orEmpty(result.Drain)
	return result, nil
}

// observeLane 把这条通道的当下状态记成指标。心跳是唯一一个「每条通道每 15 秒
// 必然经过一次」的地方，瞬时值类指标挂在这里最省事也最准。
func (s *service) observeLane(snapshot ContributionSnapshot, now time.Time) {
	labels := map[string]string{"cid": snapshot.CID}
	s.metrics.Gauge(MetricLaneInflight, labels, float64(snapshot.Inflight))
	left := snapshot.QuotaLeft()
	for unit, limit := range snapshot.QuotaLimit {
		if limit <= 0 {
			continue
		}
		s.metrics.Gauge(MetricLaneQuotaLeft,
			map[string]string{"cid": snapshot.CID, "unit": unit}, float64(left[unit])/float64(limit))
	}
	if !snapshot.ThrottledUntil.IsZero() && snapshot.ThrottledUntil.After(now) {
		s.metrics.Count(MetricThrottledTotal, labels, 1)
	}
}

// ---------- 视图 ----------

func (s *service) ListNodes(ctx context.Context, ownerUserID string) ([]dto.NodeView, error) {
	nodes, err := s.repository.ListNodesByOwner(ctx, bizLine, ownerUserID)
	if err != nil {
		return nil, err
	}
	views := make([]dto.NodeView, 0, len(nodes))
	now := time.Now()
	reputations, _, err := s.nodeReputations(ctx, nodes, now)
	if err != nil {
		return nil, err
	}
	// 每个平台最新的那一版：机器行上要显示「可升级到 x」。一次列表只查一次 ——
	// 名下几十台机器是常态，放进循环就是几十次重复查询。
	// 查不到不影响列表本身：机器该显示的还得显示，只是这一次没有升级提示。
	latest, err := s.latestBridgeReleases(ctx)
	if err != nil {
		latest = map[string]*repository.GalaxyBridgeRelease{}
	}
	for _, node := range nodes {
		rows, err := s.repository.ListContributionsByNode(ctx, bizLine, node.NodeID)
		if err != nil {
			return nil, err
		}
		// 切片必须初始化，不能靠 append 建出来：nil 切片会被序列化成 JSON 的 null，
		// 而前端拿到 null 会把类的默认值 [] 覆盖掉，下一步 .map() 就崩。
		// 刚配对完、还没 hello 的机器正好是这个状态 —— 也就是每个新用户的第一眼。
		view := dto.NodeView{
			NodeID: node.NodeID, DisplayName: node.DisplayName, BridgeVersion: node.BridgeVersion,
			Status: node.Status, Banned: node.Banned, LastBeatAt: node.LastBeatAt,
			// 接入方式要露出来：两种方式的排障路径完全不同，而主人自己
			// 往往说不清机房里那台是怎么配的。**密钥不出服务端**，只给地址。
			AccessMode:        dto.NormalizeAccessMode(node.AccessMode),
			EndpointURL:       node.EndpointURL,
			EndpointStatus:    node.EndpointStatus,
			EndpointError:     node.EndpointError,
			EndpointCheckedAt: node.EndpointCheckedAt,
			Contributions:     make([]dto.ContributionView, 0, len(rows)),

			Platform:       node.BridgePlatform,
			Distribution:   node.BridgeDistribution,
			UpgradeBlocker: node.UpgradeBlocker,
			Upgrade:        nodeUpgradeView(node, now),
		}
		if release, ok := latest[node.BridgePlatform]; ok {
			view.LatestVersion = release.Version
			// 只有独立部署的命令行能被远程升级；Nova 内置的那份随应用走，
			// 老节点连自己是什么都报不上来。界面按这个决定按钮亮不亮。
			view.UpgradeAvailable = node.BridgeDistribution == distributionCLI &&
				compareBridgeVersions(release.Version, node.BridgeVersion) > 0
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

// retiredNodeLimit 「已解绑」一栏最多列多少台。那是一份对账用的历史，不是要逐台管理的列表。
const retiredNodeLimit = 200

// ListRetiredNodes 主人解绑掉的机器，账户页「已解绑」一栏用；在用的机器仍然只走 ListNodes。
//
// 不带贡献：解绑时贡献行已经一并关掉、控制面也摘了（见 RevokeNode），再去算额度和信誉
// 只会得到一堆零。回连探测的结果也不给 —— 解绑之后没人再去探它，留着的是解绑前的旧话。
func (s *service) ListRetiredNodes(ctx context.Context, ownerUserID string) ([]dto.NodeView, error) {
	nodes, err := s.repository.ListRevokedNodesByOwner(ctx, bizLine, ownerUserID, retiredNodeLimit)
	if err != nil {
		return nil, err
	}
	views := make([]dto.NodeView, 0, len(nodes))
	for _, node := range nodes {
		views = append(views, dto.NodeView{
			NodeID: node.NodeID, DisplayName: node.DisplayName, BridgeVersion: node.BridgeVersion,
			Status: node.Status, Banned: node.Banned, LastBeatAt: node.LastBeatAt,
			AccessMode:  dto.NormalizeAccessMode(node.AccessMode),
			EndpointURL: node.EndpointURL,
			// 同 ListNodes：nil 切片会序列化成 null，前端的 .map() 会崩。
			Contributions: []dto.ContributionView{},
		})
	}
	return views, nil
}

// contributionView 的 reputation 是这条贡献所在机器的信誉：信誉挂在机器上，同一台机器的每条贡献都一样。
func (s *service) contributionView(ctx context.Context, row *repository.GalaxyContribution, grants []QuotaGrant, now time.Time, reputation float64) dto.ContributionView {
	snapshot, found, _ := s.control.GetContribution(ctx, row.CID)
	if !found {
		snapshot = s.snapshotFromRow(row, grants, time.Time{}, reputation)
	}
	plan := BuildQuotaPlan(grants, now)
	// 每一个列都过一遍 orEmpty：模型白名单、挂机时段、额度都可能是空的，
	// 而空的 Go 切片如果是 nil，序列化出去就是 null。
	view := dto.ContributionView{
		CID: unscopedCID(row.NodeID, row.CID), NodeID: row.NodeID,
		Kind: row.Kind, KindVersion: row.KindVersion, Provider: row.Provider,
		ModelsAllow:     orEmpty(decodeStrings(row.ModelsAllowJSON)),
		ModelsDeny:      orEmpty(decodeStrings(row.ModelsDenyJSON)),
		AvailableModels: orEmpty(decodeStrings(row.ModelsAvailableJSON)),
		Seats:           row.Seats, SeatConcurrency: row.SeatConcurrency, Status: row.Status, Reputation: reputation,
		Online:    Online(snapshot, now, s.cfg().HeartbeatTimeout),
		SeatsUsed: snapshot.SeatsUsed, Inflight: snapshot.Inflight,
		SeatsEffective: EffectiveSeats(snapshot, plan, now, nil),
		Schedule:       orEmpty(decodeSchedule(row.ScheduleJSON)),
		Quota:          make([]dto.QuotaStatusView, 0, len(grants)),
		Available:      row.Available,
		// 原因只在真不可用时给：可用时留着上一次的旧原因，界面会显示一句
		// 早就不成立的「请运行 claude auth login」。
		UnavailableReason: unavailableReason(row),
		SeatsBound:        snapshot.SeatsUsed,
	}
	if !snapshot.ThrottledUntil.IsZero() && snapshot.ThrottledUntil.After(now) {
		throttled := snapshot.ThrottledUntil
		view.ThrottledUntil = &throttled
	}
	left := snapshot.QuotaLeft()
	for _, grant := range grants {
		used := snapshot.QuotaUsed[grant.Unit]
		ratio := 0.0
		if grant.Limit > 0 {
			ratio = float64(used) / float64(grant.Limit)
		}
		view.Quota = append(view.Quota, dto.QuotaStatusView{
			Unit: grant.Unit, Limit: grant.Limit, Used: used, Reserved: snapshot.QuotaReserved[grant.Unit],
			Left: left[grant.Unit], Window: grant.Window, WindowKey: grant.WindowKey(now),
			Ratio: ratio, Warned: ratio >= QuotaWarnRatio,
		})
	}
	sort.Slice(view.Quota, func(i, j int) bool { return view.Quota[i].Unit < view.Quota[j].Unit })
	return view
}

// ListExecutionRecords 是「我的机器上跑过什么」（P-14）：匿名化，不含消费者内容与身份。
func (s *service) ListExecutionRecords(ctx context.Context, ownerUserID, cid string, limit int) ([]dto.ExecutionRecord, error) {
	rows, err := s.repository.ListContributionsByOwner(ctx, bizLine, ownerUserID)
	if err != nil {
		return nil, err
	}
	owned := map[string]bool{}
	for _, row := range rows {
		owned[row.CID] = true
	}
	target := ""
	if cid != "" {
		for _, row := range rows {
			if unscopedCID(row.NodeID, row.CID) == cid || row.CID == cid {
				target = row.CID
			}
		}
		if target == "" {
			return nil, fmt.Errorf("贡献不存在")
		}
	}
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	records := make([]dto.ExecutionRecord, 0, limit)
	units, _, err := s.repository.ListUnits(ctx, repository.UnitQuery{BizLine: bizLine, CID: target, Limit: limit})
	if err != nil {
		return nil, err
	}
	kept := make([]*repository.GalaxyUnit, 0, len(units))
	ids := make([]string, 0, len(units))
	for _, unit := range units {
		if target == "" && !owned[unit.CID] {
			continue
		}
		kept = append(kept, unit)
		ids = append(ids, unit.UnitID)
	}
	credits, err := s.repository.SumProviderCreditByUnit(ctx, bizLine, ids)
	if err != nil {
		return nil, err
	}
	nodeOf := nodeOfContribution(rows)
	for _, unit := range kept {
		records = append(records, dto.ExecutionRecord{
			UnitID: unit.UnitID, Kind: unit.Kind, Model: unit.Model, State: unit.State,
			ErrorCode: unit.ErrorCode, Usage: decodeMetering(unit.ActualJSON),
			Credits:   credits[unit.UnitID],
			NodeID:    nodeOf[unit.CID],
			StartedAt: unit.StartedAt, FinishedAt: unit.FinishedAt,
		})
	}
	if err := s.nameRecordNodes(ctx, ownerUserID, records); err != nil {
		return nil, err
	}
	return records, nil
}

// nodeOfContribution cid → 跑它的那台机器。
//
// unit 上只记了 cid，是哪台机器以贡献表为准：贡献行解绑之后也不删，老记录照样对得上。
func nodeOfContribution(rows []*repository.GalaxyContribution) map[string]string {
	nodes := make(map[string]string, len(rows))
	for _, row := range rows {
		nodes[row.CID] = row.NodeID
	}
	return nodes
}

// nameRecordNodes 给标好 NodeID 的执行记录补上机器名。
//
// 只有主人自己看得到：两条调用路径都只列主人名下贡献上的 unit，消费者的用量记录
// 不走这个 DTO。匿名是双向的 —— 消费者不该知道自己的请求落在了谁的哪台机器上。
func (s *service) nameRecordNodes(ctx context.Context, ownerUserID string, records []dto.ExecutionRecord) error {
	ids := make([]string, 0, 4)
	seen := map[string]bool{}
	for _, record := range records {
		if record.NodeID != "" && !seen[record.NodeID] {
			seen[record.NodeID] = true
			ids = append(ids, record.NodeID)
		}
	}
	names, err := s.repository.NodeNames(ctx, bizLine, ownerUserID, ids)
	if err != nil {
		return err
	}
	for index := range records {
		records[index].NodeName = names[records[index].NodeID]
	}
	return nil
}

// SetContributionStatus 主人暂停 / 恢复 / 停掉一条贡献（P-08、P-09）。
// 停掉的贡献排空在途后释放座位，不中断在跑的请求。
func (s *service) SetContributionStatus(ctx context.Context, ownerUserID, nodeID, cid, status string) error {
	switch status {
	case statusActive, statusPaused, statusDisabled:
	default:
		return fmt.Errorf("非法的贡献状态: %s", status)
	}
	row, err := s.findOwnedContribution(ctx, ownerUserID, nodeID, cid)
	if err != nil {
		return err
	}
	// 有消费者绑在这条贡献上就不许关。
	//
	// 座位不是「正在跑一条请求」，而是「某个消费者的会话钉在了这台机器上」——
	// 会话中途换机器会丢上下文，所以绑定要等空闲 TTL 到期才释放。主人想停机的
	// 心情是真的，但把别人跑到一半的会话踹掉更不可接受；额度和时段随时能改，
	// 那两项才是「我现在就想少给一点」的正确出口。
	if status != statusActive && row.Status == statusActive {
		snapshot, found, err := s.control.GetContribution(ctx, row.CID)
		if err != nil {
			return err
		}
		if found && snapshot.SeatsUsed > 0 {
			return fmt.Errorf("还有 %d 个消费者绑在这条贡献上，现在不能下线；"+
				"他们的会话结束（或空闲 %s 后自动释放）就能关。想立刻少给一点的话，额度和挂机时段随时可以改",
				snapshot.SeatsUsed, s.cfg().BindIdleTTL)
		}
	}
	if err := s.repository.SetContributionStatus(ctx, bizLine, row.CID, status); err != nil {
		return err
	}
	// 立刻写控制面，不等下一次 hello。
	//
	// 放置只看控制面，而 hello 只在节点启动/重连或本机能力指纹变化时才发 ——
	// 主人在控制台点开一条贡献并不会让那台机器重新 hello。只改数据库的话，
	// 心跳会把「你已启用」下发给节点、节点也把通道建起来、界面显示共享中，
	// 可放置端的车道里根本没有这台机器，消费者拿到的一律是 no_capacity。
	if err := s.syncNodeToControlPlane(ctx, row.NodeID); err != nil {
		return err
	}
	return s.control.SetDraining(ctx, row.CID, status != statusActive)
}

// registerNodeFromRow 按数据库里那一行把节点的控制面登记项整条重建。
//
// instance 用**本实例**的地址而不是行里存的：登记项记的是「这台机器现在归谁管」，
// 而现在接着它心跳的就是我。
func (s *service) registerNodeFromRow(ctx context.Context, nodeID string, now time.Time) error {
	row, err := s.repository.FindNode(ctx, bizLine, nodeID)
	if err != nil {
		return err
	}
	return s.control.RegisterNode(ctx, NodeRuntime{
		NodeID:        row.NodeID,
		OwnerUserID:   row.OwnerUserID,
		BridgeVersion: row.BridgeVersion,
		Contract:      row.ContractVersion,
		Resources:     decodeResources(row.ResourcesJSON),
		Instance:      s.cfg().Instance,
		LastBeatAt:    now,
	})
}

// syncNodeToControlPlane 按数据库里此刻的生效集合，重写这个节点在控制面里的贡献。
//
// 心跳时间取节点行里的真值而不是 now：机器关着的时候在控制台开关一下，
// 不该让它在池子里凭空「在线」一个心跳超时那么久。
func (s *service) syncNodeToControlPlane(ctx context.Context, nodeID string) error {
	node, err := s.repository.FindNode(ctx, bizLine, nodeID)
	if err != nil {
		return err
	}
	var beat time.Time
	if node.LastBeatAt != nil {
		beat = *node.LastBeatAt
	}
	plan, err := s.effectiveContributions(ctx, node, decodeResources(node.ResourcesJSON), beat)
	if err != nil {
		return err
	}
	// 额度窗口要按真正的此刻算，跟心跳时间是两回事。
	return s.pushToControlPlane(ctx, nodeID, plan, time.Now())
}

// findOwnedContribution 按 (nodeID, cid) 定位主人自己的一条贡献。
//
// nodeID 不是可选的装饰：视图里的 cid 是**去掉节点前缀**的短名（relay_codex），
// 主人有两台机器时必然重名。以前这里不带节点、命中即返回第一个，而返回顺序是
// node_id 升序、node_id 又是 ULID —— 于是永远改到**最老那台**的行上。
// 表现是开关点了报成功、界面纹丝不动，因为改的根本不是你看的那条。
//
// 带了 nodeID 就锁死；没带且撞上多条时**报错**，不替调用方猜 ——
// 猜错一次就是刚才那种「成功了但什么都没变」，比直接失败难查得多。
func (s *service) findOwnedContribution(ctx context.Context, ownerUserID, nodeID, cid string) (*repository.GalaxyContribution, error) {
	rows, err := s.repository.ListContributionsByOwner(ctx, bizLine, ownerUserID)
	if err != nil {
		return nil, err
	}
	matched := make([]*repository.GalaxyContribution, 0, 2)
	for _, row := range rows {
		if nodeID != "" && row.NodeID != nodeID {
			continue
		}
		if row.CID == cid || unscopedCID(row.NodeID, row.CID) == cid {
			matched = append(matched, row)
		}
	}
	switch len(matched) {
	case 0:
		return nil, fmt.Errorf("贡献不存在")
	case 1:
		return matched[0], nil
	default:
		return nil, fmt.Errorf("有 %d 台机器都叫 %s，请指定是哪一台", len(matched), cid)
	}
}

// RevokeNode 撤销即断连（P-01）：令牌失效，控制面里的贡献立即摘除。
//
// 库里的贡献行也要一起关掉，只摘控制面是不够的：巡检按贡献倒推节点状态，
// 撤销留下的 active 贡献行会让它在一分钟内把这台机器从 revoked 改回 offline，
// 撤销掉的机器于是自己回到总览里（见 repository.MarkNodeOffline 上的注释）。
func (s *service) RevokeNode(ctx context.Context, ownerUserID, nodeID string) error {
	if err := s.repository.RevokeNode(ctx, bizLine, ownerUserID, nodeID); err != nil {
		return err
	}
	if err := s.repository.DisableContributionsByNode(ctx, bizLine, nodeID); err != nil {
		return err
	}
	return s.control.DropNode(ctx, nodeID)
}

func (s *service) CreditBalance(ctx context.Context, ownerUserID string) (int64, error) {
	row, err := s.repository.FindCreditAccount(ctx, bizLine, ownerUserID)
	if notFound(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return row.Balance, nil
}

// ---------- 内部工具 ----------

// scopedCID 把主人起的短名扩成全局唯一的贡献 id。
// 两台机器都叫 claude-main 是常态，队列与额度按它做主键，必须先消歧。
func scopedCID(nodeID, local string) string {
	if strings.HasPrefix(local, nodeID+":") {
		return local
	}
	return nodeID + ":" + local
}

func unscopedCID(nodeID, cid string) string { return strings.TrimPrefix(cid, nodeID+":") }

func (s *service) snapshotFromRow(row *repository.GalaxyContribution, grants []QuotaGrant, beat time.Time, reputation float64) ContributionSnapshot {
	limits := contract.Metering{}
	for _, grant := range grants {
		limits[grant.Unit] = grant.Limit
	}
	return ContributionSnapshot{
		CID: row.CID, NodeID: row.NodeID, OwnerUserID: row.OwnerUserID,
		Kind: row.Kind, KindVersion: row.KindVersion, Provider: row.Provider,
		ModelsAllow: decodeStrings(row.ModelsAllowJSON), ModelsDeny: decodeStrings(row.ModelsDenyJSON),
		Seats: row.Seats, SeatConcurrency: row.SeatConcurrency,
		QuotaLimit: limits, QuotaUsed: contract.Metering{}, QuotaReserved: contract.Metering{},
		Schedule:   decodeScheduleWindows(row.ScheduleJSON),
		Reputation: reputation, LastBeatAt: beat,
		Draining: row.Status != statusActive,
	}
}

func (s *service) loadGrants(ctx context.Context, cids []string) (map[string][]QuotaGrant, error) {
	rows, err := s.repository.ListQuotaGrants(ctx, bizLine, cids)
	if err != nil {
		return nil, err
	}
	out := map[string][]QuotaGrant{}
	for _, row := range rows {
		out[row.CID] = append(out[row.CID], QuotaGrant{Unit: row.Unit, Limit: row.LimitValue, Window: row.Window, ResetAt: row.ResetAt})
	}
	return out, nil
}

func cidsOf(rows []*repository.GalaxyContribution) []string {
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.CID)
	}
	return out
}

func encodeJSON(value any) string {
	if value == nil {
		return ""
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	if string(raw) == "null" {
		return ""
	}
	return string(raw)
}

// orEmpty 把 nil 切片换成空切片。
//
// nil 切片序列化出去是 JSON 的 null，而控制台用 class-transformer 建实例：
// 拿到 null 会把类字段的默认 [] 覆盖掉，下一步 .map() 就是
// 「Cannot read properties of null」。踩过一次 —— 刚配对完还没 hello 的机器
// 贡献列表为空，正好是每个新用户看到的第一屏。
func orEmpty[T any](values []T) []T {
	if values == nil {
		return []T{}
	}
	return values
}

// encodeStrings 空切片存空串，不存 "null" —— 后者读回来还得再判一次。
func encodeStrings(values []string) string {
	if len(values) == 0 {
		return ""
	}
	raw, err := json.Marshal(values)
	if err != nil {
		return ""
	}
	return string(raw)
}

func decodeStrings(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var out []string
	_ = json.Unmarshal([]byte(raw), &out)
	return out
}

// decodeResources 把节点上报的本机资源读回来。资源只参与放置的资源需求过滤，
// 解不出来就当没报 —— ResourcesSatisfy 对缺项是放行的。
func decodeResources(raw string) map[string]any {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var out map[string]any
	_ = json.Unmarshal([]byte(raw), &out)
	return out
}

// decodeMetering 空串解出空表，不是 nil —— 理由和 orEmpty 一模一样，
// 只是那边是切片、这边是 map。
//
// nil map 序列化出去是 JSON 的 null，而控制台用 class-transformer 建实例：
// 拿到 null 会把类字段的默认 {} 覆盖掉，下一步 usage["llm.input_tokens"] 就是
// 「Cannot read properties of null」，整页白屏。
// 而 usage 为空恰恰是最常见的情形 —— 一次没派出去、没跑成的请求，
// 用量本来就该是空的，那也正是主人最想点开看看到底怎么了的那一条。
func decodeMetering(raw string) contract.Metering {
	var out contract.Metering
	if strings.TrimSpace(raw) != "" {
		// 存的要真是 "null" 这四个字母，Unmarshal 会把 map 重新置回 nil，
		// 所以判空放在解析之后，不能只在解析之前挡一道。
		_ = json.Unmarshal([]byte(raw), &out)
	}
	if out == nil {
		out = contract.Metering{}
	}
	return out
}

func decodeSchedule(raw string) []dto.ScheduleInput {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var out []dto.ScheduleInput
	_ = json.Unmarshal([]byte(raw), &out)
	return out
}

func decodeScheduleWindows(raw string) []ScheduleWindow {
	windows := decodeSchedule(raw)
	out := make([]ScheduleWindow, 0, len(windows))
	for _, window := range windows {
		out = append(out, ScheduleWindow{From: window.From, To: window.To, TZ: window.TZ})
	}
	return out
}

func defaultInt(value, fallback int) int {
	if value <= 0 {
		return fallback
	}
	return value
}

func truncate(value string, max int) string {
	value = strings.TrimSpace(value)
	if len(value) <= max {
		return value
	}
	return value[:max]
}

func capStrings(values []string, max int) []string {
	if len(values) <= max {
		return values
	}
	return values[:max]
}

// SaveContributionLimits 主人在控制台改一条贡献的授权：模型白名单、座位、三维额度、挂机时段。
//
// 改完立刻写回控制面，不等节点下一次 hello —— 主人按下「把额度调小」通常是因为
// 现在就想少跑一点，让它等 15 秒心跳都算慢。
func (s *service) SaveContributionLimits(ctx context.Context, req dto.SaveContributionLimitsRequest) error {
	row, err := s.findOwnedContribution(ctx, req.OwnerUserID, req.NodeID, req.CID)
	if err != nil {
		return err
	}
	spec, ok := s.kinds.Lookup(row.Kind, row.KindVersion)
	if !ok {
		return fmt.Errorf("%w: %s", contract.ErrKindNotRegistered, contract.KindRef(row.Kind, row.KindVersion))
	}

	grants := make([]QuotaGrant, 0, len(req.Quota))
	seen := make(map[contract.MeterUnit]bool, len(req.Quota))
	for _, quota := range req.Quota {
		if quota.Limit <= 0 {
			continue
		}
		if !spec.AllowsUnit(quota.Unit) {
			return fmt.Errorf("计量单位 %s 不属于 %s", quota.Unit, spec.Kind)
		}
		// 一个单位只能有一条上限：唯一键就是 (biz_line, cid, unit)。
		// 不在这里拦，撞的就是数据库的 1062，一条主人看不懂的 SQL 报错会原样甩到界面上。
		if seen[quota.Unit] {
			return fmt.Errorf("计量单位 %s 配了不止一条额度，每个单位只能留一条", quota.Unit)
		}
		seen[quota.Unit] = true
		grants = append(grants, QuotaGrant{Unit: quota.Unit, Limit: quota.Limit, Window: quota.Window, ResetAt: quota.ResetAt})
	}
	if len(grants) == 0 {
		return fmt.Errorf("贡献必须至少保留一个额度上限")
	}
	seats := defaultInt(req.Seats, row.Seats)
	if s.cfg().PlatformSeatLimit > 0 && seats > s.cfg().PlatformSeatLimit {
		return fmt.Errorf("座位数 %d 超过平台上限 %d", seats, s.cfg().PlatformSeatLimit)
	}

	if err := s.repository.SaveContributionLimits(ctx, bizLine, row.CID, map[string]any{
		"models_allow_json": encodeJSON(req.ModelsAllow),
		"models_deny_json":  encodeJSON(req.ModelsDeny),
		"seats":             seats,
		"seat_concurrency":  defaultInt(req.SeatConcurrency, row.SeatConcurrency),
		"schedule_json":     encodeJSON(req.Schedule),
	}, toQuotaRows(row.CID, grants)); err != nil {
		return err
	}

	// 写回控制面，不等节点下一次 hello —— 主人按下「把额度调小」通常是因为
	// 现在就想少跑一点，让它等 15 秒心跳都算慢。
	//
	// 整台机器一起推，不能只推被改的这一条：ReplaceContributions 是**全量替换**语义，
	// 只塞一条进去，同一台机器上别的贡献会被当成「不再申报」而从控制面摘掉。
	// 踩过一次 —— 改完 Claude 那条的额度，Codex 那条就从池子里消失了，
	// 而界面上两条都还显示共享中。
	//
	// 顺带也不再拿控制面里的旧快照当底稿：那份快照可能本身就是残缺的，
	// 按数据库的行重新算一遍才是权威。
	return s.syncNodeToControlPlane(ctx, row.NodeID)
}

func toQuotaRows(cid string, grants []QuotaGrant) []*repository.GalaxyQuotaGrant {
	rows := make([]*repository.GalaxyQuotaGrant, 0, len(grants))
	for _, grant := range grants {
		rows = append(rows, &repository.GalaxyQuotaGrant{
			BizLine: bizLine, CID: cid, Unit: grant.Unit,
			LimitValue: grant.Limit, Window: grant.Window, ResetAt: grant.ResetAt,
		})
	}
	return rows
}
