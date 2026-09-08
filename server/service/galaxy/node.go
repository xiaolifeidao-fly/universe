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
		terms = s.config.ProviderTermsVersion
	}
	if terms != s.config.ProviderTermsVersion {
		return dto.PairingCodeView{}, fmt.Errorf("条款版本已更新，请重新阅读并同意")
	}
	agreed, err := s.HasConsent(ctx, subjectProvider, req.OwnerUserID, terms)
	if err != nil {
		return dto.PairingCodeView{}, err
	}
	if !agreed {
		return dto.PairingCodeView{}, contract.ErrConsentRequired
	}
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
	agreed, err := s.HasConsent(ctx, subjectProvider, code.OwnerUserID, s.config.ProviderTermsVersion)
	if err != nil {
		return dto.PairResult{}, err
	}
	if !agreed {
		return dto.PairResult{}, contract.ErrConsentRequired
	}

	secret := "gnt_" + randomToken(32)
	node := &repository.GalaxyNode{
		BizLine:         bizLine,
		NodeID:          nodeID,
		OwnerUserID:     code.OwnerUserID,
		DisplayName:     truncate(req.DisplayName, 128),
		TokenHash:       HashSecret(secret),
		BridgeVersion:   truncate(req.BridgeVersion, 32),
		ContractVersion: s.config.ContractVersion,
		Status:          statusActive,
		LastBeatAt:      &now,
	}
	if err := s.repository.SaveNode(ctx, node); err != nil {
		return dto.PairResult{}, err
	}
	return dto.PairResult{NodeID: nodeID, Token: secret}, nil
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
	if row.Banned || row.Status == "revoked" {
		return NodeIdentity{}, fmt.Errorf("节点已被停用")
	}
	return NodeIdentity{NodeID: row.NodeID, OwnerUserID: row.OwnerUserID, DisplayName: row.DisplayName, Banned: row.Banned}, nil
}

// Hello 全量替换该节点的贡献集合。未勾选的能力 Hub 不可见（P-03）。
func (s *service) Hello(ctx context.Context, req dto.HelloRequest) (dto.HelloResult, error) {
	if req.Contract != s.config.ContractVersion {
		return dto.HelloResult{}, contract.NewUnitError(contract.ErrorClassProtocol, contract.CodeContractMismatch, false,
			fmt.Sprintf("节点契约版本 %d 与 Hub 的 %d 不一致，请升级 ai-bridge", req.Contract, s.config.ContractVersion))
	}
	agreed, err := s.HasConsent(ctx, subjectProvider, req.OwnerUserID, s.config.ProviderTermsVersion)
	if err != nil {
		return dto.HelloResult{}, err
	}
	if !agreed {
		return dto.HelloResult{}, contract.ErrConsentRequired
	}

	now := time.Now()
	result := dto.HelloResult{QuotaEffective: map[string][]dto.QuotaGrantInput{}}
	rows := make([]*repository.GalaxyContribution, 0, len(req.Contributions))
	grants := map[string][]*repository.GalaxyQuotaGrant{}
	snapshots := make([]ContributionSnapshot, 0, len(req.Contributions))

	for _, input := range req.Contributions {
		spec, grantList, err := s.validateContribution(input)
		if err != nil {
			result.Rejected = append(result.Rejected, struct {
				CID    string `json:"cid"`
				Reason string `json:"reason"`
			}{CID: input.CID, Reason: err.Error()})
			continue
		}
		cid := scopedCID(req.NodeID, input.CID)
		rows = append(rows, &repository.GalaxyContribution{
			BizLine:         bizLine,
			CID:             cid,
			NodeID:          req.NodeID,
			OwnerUserID:     req.OwnerUserID,
			Kind:            spec.Kind,
			KindVersion:     spec.Version,
			Provider:        input.Provider,
			ModelsAllowJSON: encodeJSON(input.Models.Allow),
			ModelsDenyJSON:  encodeJSON(input.Models.Deny),
			Seats:           defaultInt(input.Seats, 3),
			SeatConcurrency: defaultInt(input.SeatConcurrency, 2),
			ScheduleJSON:    encodeJSON(input.Schedule),
			Status:          statusActive,
			Reputation:      1,
		})
		for _, grant := range grantList {
			grants[cid] = append(grants[cid], &repository.GalaxyQuotaGrant{
				BizLine: bizLine, CID: cid, Unit: grant.Unit,
				LimitValue: grant.Limit, Window: grant.Window, ResetAt: grant.ResetAt,
			})
		}
		result.Accepted = append(result.Accepted, input.CID)
	}

	if err := s.repository.ReplaceContributions(ctx, bizLine, req.NodeID, rows, grants); err != nil {
		return dto.HelloResult{}, err
	}

	// Hub 侧额度为权威：主人在控制台改过的值会覆盖节点申报，节点以返回值更新展示副本。
	effective, err := s.loadGrants(ctx, cidsOf(rows))
	if err != nil {
		return dto.HelloResult{}, err
	}
	for _, row := range rows {
		snapshot := s.snapshotFromRow(row, effective[row.CID], now)
		snapshot.UpstreamOK = true
		// 资源跟着贡献走而不是另开一张节点表：放置的硬过滤在贡献这一层做，
		// 每次都去 join 一次节点会把「已绑定请求 ≤ 3 次 Redis 操作」这条打破。
		snapshot.Resources = req.Resources
		snapshots = append(snapshots, snapshot)
		local := unscopedCID(req.NodeID, row.CID)
		for _, grant := range effective[row.CID] {
			result.QuotaEffective[local] = append(result.QuotaEffective[local], dto.QuotaGrantInput{
				Unit: grant.Unit, Limit: grant.Limit, Window: grant.Window, ResetAt: grant.ResetAt,
			})
		}
	}

	if err := s.control.RegisterNode(ctx, NodeRuntime{
		NodeID:        req.NodeID,
		OwnerUserID:   req.OwnerUserID,
		BridgeVersion: req.BridgeVersion,
		Contract:      req.Contract,
		Resources:     req.Resources,
		Instance:      s.config.Instance,
		LastBeatAt:    now,
	}); err != nil {
		return dto.HelloResult{}, err
	}
	if err := s.control.ReplaceContributions(ctx, req.NodeID, snapshots); err != nil {
		return dto.HelloResult{}, err
	}
	for _, snapshot := range snapshots {
		plan := BuildQuotaPlan(effective[snapshot.CID], now)
		if _, _, err := s.control.SyncQuota(ctx, snapshot.CID, plan.Limits, plan.Windows); err != nil {
			return dto.HelloResult{}, err
		}
	}
	if err := s.repository.SaveNode(ctx, &repository.GalaxyNode{
		BizLine: bizLine, NodeID: req.NodeID, OwnerUserID: req.OwnerUserID,
		BridgeVersion: truncate(req.BridgeVersion, 32), ContractVersion: req.Contract,
		ResourcesJSON: encodeJSON(req.Resources), Status: statusActive, LastBeatAt: &now,
	}); err != nil {
		return dto.HelloResult{}, err
	}
	return result, nil
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
	spec, err := s.kinds.ValidateContribution(input.Kind, input.KindVersion, input.Provider, units, seats, s.config.PlatformSeatLimit)
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
	if err := s.control.TouchNode(ctx, req.NodeID, now); err != nil {
		return dto.HeartbeatResult{}, err
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
	result := dto.HeartbeatResult{Cancel: cancels, QuotaUpdate: map[string]contract.Metering{}, ServerTime: now.UnixMilli()}
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
	for _, node := range nodes {
		view := dto.NodeView{
			NodeID: node.NodeID, DisplayName: node.DisplayName, BridgeVersion: node.BridgeVersion,
			Status: node.Status, Banned: node.Banned, LastBeatAt: node.LastBeatAt,
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

func (s *service) contributionView(ctx context.Context, row *repository.GalaxyContribution, grants []QuotaGrant, now time.Time) dto.ContributionView {
	snapshot, found, _ := s.control.GetContribution(ctx, row.CID)
	if !found {
		snapshot = s.snapshotFromRow(row, grants, time.Time{})
	}
	plan := BuildQuotaPlan(grants, now)
	view := dto.ContributionView{
		CID: unscopedCID(row.NodeID, row.CID), NodeID: row.NodeID,
		Kind: row.Kind, KindVersion: row.KindVersion, Provider: row.Provider,
		ModelsAllow: decodeStrings(row.ModelsAllowJSON), ModelsDeny: decodeStrings(row.ModelsDenyJSON),
		Seats: row.Seats, SeatConcurrency: row.SeatConcurrency, Status: row.Status, Reputation: row.Reputation,
		Online:    Online(snapshot, now, s.config.HeartbeatTimeout),
		SeatsUsed: snapshot.SeatsUsed, Inflight: snapshot.Inflight,
		SeatsEffective: EffectiveSeats(snapshot, plan, now, nil),
		Schedule:       decodeSchedule(row.ScheduleJSON),
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
	for _, unit := range units {
		if target == "" && !owned[unit.CID] {
			continue
		}
		records = append(records, dto.ExecutionRecord{
			UnitID: unit.UnitID, Kind: unit.Kind, Model: unit.Model, State: unit.State,
			ErrorCode: unit.ErrorCode, Usage: decodeMetering(unit.ActualJSON),
			StartedAt: unit.StartedAt, FinishedAt: unit.FinishedAt,
		})
	}
	return records, nil
}

// SetContributionStatus 主人暂停 / 恢复 / 停掉一条贡献（P-08、P-09）。
// 停掉的贡献排空在途后释放座位，不中断在跑的请求。
func (s *service) SetContributionStatus(ctx context.Context, ownerUserID, cid, status string) error {
	switch status {
	case statusActive, statusPaused, statusDisabled:
	default:
		return fmt.Errorf("非法的贡献状态: %s", status)
	}
	row, err := s.findOwnedContribution(ctx, ownerUserID, cid)
	if err != nil {
		return err
	}
	if err := s.repository.SetContributionStatus(ctx, bizLine, row.CID, status); err != nil {
		return err
	}
	return s.control.SetDraining(ctx, row.CID, status != statusActive)
}

func (s *service) findOwnedContribution(ctx context.Context, ownerUserID, cid string) (*repository.GalaxyContribution, error) {
	rows, err := s.repository.ListContributionsByOwner(ctx, bizLine, ownerUserID)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		if row.CID == cid || unscopedCID(row.NodeID, row.CID) == cid {
			return row, nil
		}
	}
	return nil, fmt.Errorf("贡献不存在")
}

// RevokeNode 撤销即断连（P-01）：令牌失效，控制面里的贡献立即摘除。
func (s *service) RevokeNode(ctx context.Context, ownerUserID, nodeID string) error {
	if err := s.repository.RevokeNode(ctx, bizLine, ownerUserID, nodeID); err != nil {
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

func (s *service) snapshotFromRow(row *repository.GalaxyContribution, grants []QuotaGrant, beat time.Time) ContributionSnapshot {
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
		Reputation: row.Reputation, LastBeatAt: beat,
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

func decodeStrings(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var out []string
	_ = json.Unmarshal([]byte(raw), &out)
	return out
}

func decodeMetering(raw string) contract.Metering {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var out contract.Metering
	_ = json.Unmarshal([]byte(raw), &out)
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
	row, err := s.findOwnedContribution(ctx, req.OwnerUserID, req.CID)
	if err != nil {
		return err
	}
	spec, ok := s.kinds.Lookup(row.Kind, row.KindVersion)
	if !ok {
		return fmt.Errorf("%w: %s", contract.ErrKindNotRegistered, contract.KindRef(row.Kind, row.KindVersion))
	}

	grants := make([]QuotaGrant, 0, len(req.Quota))
	for _, quota := range req.Quota {
		if quota.Limit <= 0 {
			continue
		}
		if !spec.AllowsUnit(quota.Unit) {
			return fmt.Errorf("计量单位 %s 不属于 %s", quota.Unit, spec.Kind)
		}
		grants = append(grants, QuotaGrant{Unit: quota.Unit, Limit: quota.Limit, Window: quota.Window, ResetAt: quota.ResetAt})
	}
	if len(grants) == 0 {
		return fmt.Errorf("贡献必须至少保留一个额度上限")
	}
	seats := defaultInt(req.Seats, row.Seats)
	if s.config.PlatformSeatLimit > 0 && seats > s.config.PlatformSeatLimit {
		return fmt.Errorf("座位数 %d 超过平台上限 %d", seats, s.config.PlatformSeatLimit)
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

	// 写回控制面。贡献可能此刻不在线（节点关着），那时快照不存在，
	// SyncQuota 会建出一个没有心跳的壳 —— 放置的在线判定照样会把它挡掉，
	// 等节点回来 hello 时再被完整覆盖。
	now := time.Now()
	plan := BuildQuotaPlan(grants, now)
	if snapshot, found, err := s.control.GetContribution(ctx, row.CID); err == nil && found {
		snapshot.Seats = seats
		snapshot.SeatConcurrency = defaultInt(req.SeatConcurrency, row.SeatConcurrency)
		snapshot.ModelsAllow = req.ModelsAllow
		snapshot.ModelsDeny = req.ModelsDeny
		snapshot.Schedule = toScheduleWindows(req.Schedule)
		snapshot.QuotaLimit = plan.Limits
		if err := s.control.ReplaceContributions(ctx, row.NodeID, []ContributionSnapshot{snapshot}); err != nil {
			return err
		}
	}
	_, _, err = s.control.SyncQuota(ctx, row.CID, plan.Limits, plan.Windows)
	return err
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

func toScheduleWindows(windows []dto.ScheduleInput) []ScheduleWindow {
	out := make([]ScheduleWindow, 0, len(windows))
	for _, window := range windows {
		out = append(out, ScheduleWindow{From: window.From, To: window.To, TZ: window.TZ})
	}
	return out
}
