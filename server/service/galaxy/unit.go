package galaxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 通道层：放置 → 领活 → 上行 → 终态。这个文件里没有任何业务语义，
// 它只处理三种原语共用的状态机与失败语义（设计文档 1.3 与 6.2）。

// Submit 放置一个工作单元。返回时单元已入队，节点随时可能领走。
//
// 四条路径，命中越早越省 Redis 操作：
//  1. 硬钉（Responses 链式 / session 硬亲和）—— 不重选，贡献不在就直接失败；
//  2. 已有绑定且贡献健康 —— 90% 的请求走这条，2~3 次 Redis 操作（非功能需求·延迟）；
//  3. 硬过滤 + 打分选一个；
//  4. 都没有 → 有贡献只是忙（并发满、额度被在途请求预留）才等待至多 maxWaitMs，
//     超时 503 且不计费（C-05）；池里根本没有接得了的贡献就立刻 503。
func (s *service) Submit(ctx context.Context, unit contract.WorkUnit) (Placement, error) {
	spec, ok := s.kinds.Lookup(unit.Kind, unit.KindVersion)
	if !ok {
		return Placement{}, contract.NewUnitError(contract.ErrorClassInput, contract.CodeInvalidBody, false,
			fmt.Sprintf("能力 %s 未注册", contract.KindRef(unit.Kind, unit.KindVersion)))
	}
	now := time.Now()
	if unit.ID == "" {
		unit.ID = "u_" + NewULID(now)
	}
	if unit.Attempt <= 0 {
		unit.Attempt = 1
	}
	unit.KindVersion = spec.Version
	unit.Primitive = spec.Primitive
	unit.State = contract.UnitQueued
	if unit.CreatedAt == 0 {
		unit.CreatedAt = now.UnixMilli()
	}
	if unit.Deadline == 0 && spec.Lease.MaxRunSec > 0 {
		unit.Deadline = now.Add(time.Duration(spec.Lease.MaxRunSec) * time.Second).UnixMilli()
	}

	if err := s.persistUnit(ctx, unit, now); err != nil {
		return Placement{}, err
	}

	route := contract.RouteKey{
		Kind: unit.Kind, KindVersion: unit.KindVersion, Family: unit.Family,
		Provider: unit.Provider, Model: unit.Model, AffinityKey: unit.AffinityKey, HardPin: unit.HardPin,
	}
	deadline := now.Add(s.config.MaxWait)
	s.enterWaitQueue(unit.Kind)
	defer s.leaveWaitQueue(unit.Kind)
	if unit.Attempt > 1 {
		s.metrics.Count(MetricReassignTotal, map[string]string{"kind": unit.Kind}, 1)
	}

	startedAt := time.Now()
	waited := false
	for {
		trace := &placeTrace{}
		placement, retryable, err := s.tryPlace(ctx, unit, spec, route, time.Now(), trace)
		if err != nil {
			// 硬钉的贡献掉线这类错误不可能等出来：直接把单元落成终态，
			// 否则它会以 queued 永远留在表里，用量统计与排障都会被它污染。
			var cause *contract.UnitError
			if !errors.As(err, &cause) {
				cause = contract.NewUnitError(contract.ErrorClassHub, "internal_error", false, err.Error())
			}
			_ = s.markUnitFailed(ctx, unit.ID, cause)
			return Placement{}, err
		}
		if placement != nil {
			path := trace.path
			if waited {
				// 等过队列的请求单独归一类：它的延迟里有一段是「池子当时没位置」，
				// 和放置本身快不快是两回事。
				path = PlacePathWait
			}
			labels := map[string]string{"kind": unit.Kind, "path": path}
			s.metrics.Observe(MetricPlaceLatency, labels, float64(time.Since(startedAt).Milliseconds()))
			s.metrics.Observe(MetricPlaceRedisOps, labels, float64(trace.redisOps))
			return *placement, nil
		}
		if !retryable || !time.Now().Before(deadline) {
			break
		}
		// 无候选但有贡献忙：等在途的活结算，把并发或额度还回来。
		// P0 单实例，等待就发生在持有消费者连接的这个进程里，不需要把 rid 放进 Redis 再被别的实例唤醒。
		waited = true
		select {
		case <-ctx.Done():
			return Placement{}, ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
	_ = s.markUnitFailed(ctx, unit.ID, contract.NewUnitError(contract.ErrorClassHub, contract.CodeNoCapacity, true, "共享池暂无可用算力"))
	return Placement{}, contract.NewUnitError(contract.ErrorClassHub, contract.CodeNoCapacity, true, "共享池暂无可用算力，请稍后重试")
}

// placeTrace 记这次放置走了哪条路、用了几次 Redis。
// 「已绑定请求的放置路径 Redis 操作 ≤ 3 次」是写进非功能需求的承诺，
// 不埋点就只能靠读代码相信它。
type placeTrace struct {
	path     string
	redisOps int
}

// tryPlace 走一遍四条路径。第二个返回值表示「这次没成，但等一等可能有」。
func (s *service) tryPlace(ctx context.Context, unit contract.WorkUnit, spec contract.KindSpec, route contract.RouteKey, now time.Time, trace *placeTrace) (*Placement, bool, error) {
	lane := route.Lane()
	trace.path = PlacePathSelect

	// 1 硬钉：Responses 链式请求引用的是上游账号侧状态，回不去就只能失败，不能改派。
	if route.HardPin != "" {
		trace.path = PlacePathHardPin
		trace.redisOps++
		snapshot, found, err := s.control.GetContribution(ctx, route.HardPin)
		if err != nil {
			return nil, false, err
		}
		if !found || !Online(snapshot, now, s.config.HeartbeatTimeout) {
			return nil, false, contract.NewUnitError(contract.ErrorClassNode, contract.CodeNodeUnavailable, false,
				"原节点已离线，带 previous_response_id 的请求无法改派")
		}
		grants, err := s.loadGrants(ctx, []string{snapshot.CID})
		if err != nil {
			return nil, false, err
		}
		trace.redisOps++
		placement, err := s.commit(ctx, unit, snapshot, BuildQuotaPlan(grants[snapshot.CID], now), lane, false, now)
		if err != nil {
			return nil, false, err
		}
		if placement == nil {
			return nil, true, nil
		}
		return placement, false, nil
	}

	// 2 已有绑定：座位已经占着，只需并发与额度两项校验。
	affinity := unit.ConsumerKey
	if route.AffinityKey != "" {
		affinity = route.AffinityKey
	}
	// waitBound 绑定的贡献此刻忙，但手上的活结算完就能接：这一单值得排队等它。
	// 第 3 步看不出这一点 —— 那台机器的座位里有一个就是这个消费者自己的，按座位算它是满的。
	waitBound := false
	if spec.Placement.Affinity != contract.AffinityNone {
		trace.redisOps++
		if cid, found, err := s.control.LookupBinding(ctx, affinity, lane); err != nil {
			return nil, false, err
		} else if found {
			trace.redisOps++
			snapshot, exists, err := s.control.GetContribution(ctx, cid)
			if err != nil {
				return nil, false, err
			}
			if exists && Online(snapshot, now, s.config.HeartbeatTimeout) && !snapshot.Draining && !snapshot.Paused {
				grants, err := s.loadGrants(ctx, []string{cid})
				if err != nil {
					return nil, false, err
				}
				plan := BuildQuotaPlan(grants[cid], now)
				if boundAccepts(snapshot, plan, unit.Metering.Estimate) {
					trace.path = PlacePathBound
					trace.redisOps++
					placement, err := s.commit(ctx, unit, snapshot, plan, lane, true, now)
					if err != nil {
						return nil, false, err
					}
					if placement != nil {
						return placement, false, nil
					}
				}
				waitBound = boundAccepts(onceSettled(snapshot), plan, unit.Metering.Estimate)
				// 硬亲和忙时排队不溢出；软亲和这次溢出到别的贡献，但不改绑定。
				if spec.Placement.Affinity == contract.AffinityHard {
					return nil, waitBound, nil
				}
				s.metrics.Count(MetricSpillTotal, map[string]string{"kind": unit.Kind}, 1)
			} else {
				// 贡献没了：解绑，下次重新放置。
				_ = s.control.ReleaseBinding(ctx, affinity, lane, cid)
			}
		}
	}

	// 3 硬过滤 + 打分
	trace.redisOps++
	snapshots, err := s.control.ListLaneContributions(ctx, lane)
	if err != nil {
		return nil, false, err
	}
	if len(snapshots) == 0 {
		// 车道里一个贡献都没有：没人共享这个 provider，等多久也等不来。
		return nil, waitBound, nil
	}
	cids := make([]string, 0, len(snapshots))
	for _, snapshot := range snapshots {
		cids = append(cids, snapshot.CID)
	}
	grants, err := s.loadGrants(ctx, cids)
	if err != nil {
		return nil, false, err
	}
	plans := make(map[string]QuotaPlan, len(snapshots))
	for _, snapshot := range snapshots {
		plans[snapshot.CID] = BuildQuotaPlan(grants[snapshot.CID], now)
	}
	input := FilterInput{
		Route: route, Spec: spec, Estimate: unit.Metering.Estimate, Plans: plans, Now: now,
		HeartbeatTimeout: s.config.HeartbeatTimeout, Weights: s.config.Weights,
		LocalityKeys: localityKeys(unit), FallbackBurn: poolBurn(snapshots, plans, now),
	}
	candidates := Rank(Filter(snapshots, input), input)
	if len(candidates) == 0 {
		return nil, waitBound || Waitable(snapshots, input), nil
	}

	// 4 依次尝试：被别的请求抢走座位就换下一个，最多 maxPlaceAttempts 次。
	attempts := s.config.MaxPlaceAttempts
	for index, candidate := range candidates {
		if index >= attempts {
			break
		}
		trace.redisOps++
		placement, err := s.commit(ctx, unit, candidate.Snapshot, candidate.Plan, lane, false, now)
		if err != nil {
			return nil, false, err
		}
		if placement != nil {
			return placement, false, nil
		}
	}
	return nil, true, nil
}

// commit 是不可分割的那一步：占座位 → 预留额度 → 入队 → 写 req。全在一段 Lua 里。
// 返回 nil 表示被抢，调用方换一个候选重试。
func (s *service) commit(ctx context.Context, unit contract.WorkUnit, snapshot ContributionSnapshot, plan QuotaPlan, lane string, reuseBinding bool, now time.Time) (*Placement, error) {
	unit.CID = snapshot.CID
	unit.State = contract.UnitPlaced
	body, rest := splitInlineBody(unit)
	payload, err := json.Marshal(rest)
	if err != nil {
		return nil, err
	}
	affinity := unit.ConsumerKey
	if unit.AffinityKey != "" {
		affinity = unit.AffinityKey
	}
	outcome, err := s.control.Place(ctx, PlaceCommand{
		RID: unit.ID, CID: snapshot.CID, ConsumerKey: affinity, Lane: lane,
		Estimate: unit.Metering.Estimate, QuotaLimits: plan.Limits, WindowKeys: plan.Windows, WindowExpiry: plan.Expiry,
		Seats: snapshot.Seats, SeatConcurrency: snapshot.SeatConcurrency,
		ReuseBinding: reuseBinding, BindTTL: s.config.BindIdleTTL, SeatTTL: s.config.BindIdleTTL,
		Instance: s.config.Instance, Unit: payload, Body: body, BodyTTL: s.config.BodyTTL,
		Deadline: time.UnixMilli(unit.Deadline),
	})
	if err != nil {
		return nil, err
	}
	if !outcome.Placed {
		return nil, nil
	}

	_ = s.repository.UpdateUnit(ctx, bizLine, unit.ID, map[string]any{
		"cid": snapshot.CID, "state": string(contract.UnitPlaced), "attempt": unit.Attempt,
	})
	_ = s.repository.AppendUnitEvent(ctx, &repository.GalaxyUnitEvent{
		BizLine: bizLine, UnitID: unit.ID, Kind: "placed",
		Message: "已放置到贡献", DataJSON: encodeJSON(map[string]any{"cid": snapshot.CID, "attempt": unit.Attempt, "reuseBinding": reuseBinding}),
	})
	_ = s.repository.RecordSeatBinding(ctx, &repository.GalaxySeatBinding{
		BizLine: bizLine, CID: snapshot.CID, ConsumerKey: affinity, Lane: lane,
		BoundAt: now, LastUsedAt: now,
	})
	// 抽检取样：被抽中的请求要留一份原文，跑完之后用 Hub 自己的账号重放比对。
	// 放在放置成功之后 —— 没派出去的请求没什么可比的。
	if s.ShouldProbe(ctx, snapshot.CID) {
		_ = s.RecordProbe(ctx, unit, snapshot.CID)
	}
	// session 落定之后钉住：后续回合默认回同一台机器，换机器要走显式迁移。
	// 顺手把回合与单元关联起来 —— 事件回放要靠这条关联找到日志。
	s.pinSession(ctx, unit.SID, snapshot.CID)
	if unit.SID != "" && unit.Seq > 0 {
		_ = s.repository.UpdateTurn(ctx, bizLine, unit.SID, unit.Seq, map[string]any{
			"unit_id": unit.ID, "cid": snapshot.CID,
		})
	}
	return &Placement{UnitID: unit.ID, CID: snapshot.CID, Attempt: unit.Attempt, Estimate: unit.Metering.Estimate}, nil
}

// splitInlineBody 把 relay 的请求体从信封里摘出来单独存：
// 信封进 req:{rid}（24h），体积大的请求体进 req:body:{rid}（60s 就够节点领走）。
func splitInlineBody(unit contract.WorkUnit) ([]byte, contract.WorkUnit) {
	var body []byte
	inputs := make([]contract.Payload, 0, len(unit.Inputs))
	for _, payload := range unit.Inputs {
		if payload.Name == "body" && payload.Ref == nil {
			body = payload.Inline
			payload.Inline = nil
		}
		inputs = append(inputs, payload)
	}
	unit.Inputs = inputs
	return body, unit
}

func localityKeys(unit contract.WorkUnit) []string {
	var keys []string
	for _, payload := range unit.Inputs {
		if payload.Ref != nil && payload.Ref.Key != "" {
			keys = append(keys, payload.Ref.Key)
		}
	}
	return keys
}

// poolBurn 同 kind 全池的每座位小时消耗率，给样本不足的贡献兜底（设计文档 4.3）。
func poolBurn(snapshots []ContributionSnapshot, plans map[string]QuotaPlan, now time.Time) contract.Metering {
	totals := contract.Metering{}
	counts := map[contract.MeterUnit]int{}
	for _, snapshot := range snapshots {
		plan := plans[snapshot.CID]
		seats := snapshot.Seats
		if seats <= 0 {
			continue
		}
		for unit, used := range snapshot.QuotaUsed {
			if used <= 0 {
				continue
			}
			totals[unit] += int64(float64(used) / plan.ElapsedHours(unit, now) / float64(seats))
			counts[unit]++
		}
	}
	for unit, count := range counts {
		if count > 0 {
			totals[unit] /= int64(count)
		}
	}
	return totals
}

func (s *service) persistUnit(ctx context.Context, unit contract.WorkUnit, now time.Time) error {
	if unit.Attempt > 1 {
		// 改派：同一个 unit_id 换一次 attempt，计量流水的幂等键因此不会撞。
		return s.repository.UpdateUnit(ctx, bizLine, unit.ID, map[string]any{
			"state": string(contract.UnitQueued), "attempt": unit.Attempt, "cid": "",
		})
	}
	return s.repository.CreateUnit(ctx, &repository.GalaxyUnit{
		BizLine: bizLine, UnitID: unit.ID, Kind: unit.Kind, KindVersion: unit.KindVersion,
		Primitive: string(unit.Primitive), Family: unit.Family, Provider: unit.Provider, Model: unit.Model,
		ConsumerKey: unit.ConsumerKey, Space: unit.Space, SID: unit.SID, Op: unit.Op,
		Seq: unit.Seq, Attempt: unit.Attempt,
		State: string(contract.UnitQueued), EstimateJSON: encodeJSON(unit.Metering.Estimate),
		Instance: s.config.Instance, CreatedTime: now,
	}, &repository.GalaxyUnitEvent{
		BizLine: bizLine, UnitID: unit.ID, Kind: "submitted", Message: "已提交",
		DataJSON: encodeJSON(map[string]any{"kind": unit.Kind, "model": unit.Model}),
	})
}

func (s *service) enterWaitQueue(kind string) {
	s.waiting.Lock()
	s.waiting.byKind[kind]++
	s.waiting.Unlock()
}

func (s *service) leaveWaitQueue(kind string) {
	s.waiting.Lock()
	if s.waiting.byKind[kind] > 0 {
		s.waiting.byKind[kind]--
	}
	s.waiting.Unlock()
}

// ---------- 节点侧 ----------

// Next 领活。只在节点列出的、有空位的通道上阻塞（T-03）。
func (s *service) Next(ctx context.Context, req dto.NextRequest) (*dto.NextResult, error) {
	cids := make([]string, 0, len(req.Lanes))
	for _, lane := range req.Lanes {
		if lane.Free > 0 {
			cids = append(cids, scopedCID(req.NodeID, lane.CID))
		}
	}
	cancels, err := s.control.TakeNodeCancels(ctx, req.NodeID)
	if err != nil {
		return nil, err
	}
	if len(cids) == 0 {
		if len(cancels) == 0 {
			return nil, nil
		}
		return &dto.NextResult{Cancel: cancels}, nil
	}

	wait := time.Duration(req.WaitSeconds) * time.Second
	if wait <= 0 || wait > 30*time.Second {
		wait = 25 * time.Second
	}
	claimed, err := s.control.Claim(ctx, ClaimCommand{NodeID: req.NodeID, CIDs: cids, Wait: wait})
	if err != nil {
		return nil, err
	}
	if claimed == nil {
		if len(cancels) == 0 {
			return nil, nil
		}
		return &dto.NextResult{Cancel: cancels}, nil
	}

	var unit contract.WorkUnit
	if err := json.Unmarshal(claimed.Unit, &unit); err != nil {
		return nil, err
	}
	// 贡献可能在入队之后被改过：把单元的 kind / provider / model 再对一遍申报范围。
	snapshot, found, err := s.control.GetContribution(ctx, claimed.CID)
	if err != nil {
		return nil, err
	}
	if !found || snapshot.Kind != unit.Kind || snapshot.Provider != unit.Provider ||
		(unit.Model != "" && !contract.ModelMatch(unit.Model, snapshot.ModelsAllow, snapshot.ModelsDeny)) {
		_ = s.FailUnit(ctx, unit.ID, contract.NewUnitError(contract.ErrorClassNode, contract.CodeCapabilityMismatch, true,
			"贡献已变更，单元不再落在其申报范围内"))
		return nil, nil
	}

	spec, _ := s.kinds.Lookup(unit.Kind, unit.KindVersion)
	renewSec := spec.Lease.RenewSec
	if renewSec <= 0 {
		renewSec = 60
	}
	lease := "lt_" + randomToken(16)
	now := time.Now()
	if err := s.control.MarkRunning(ctx, unit.ID, lease, now); err != nil {
		return nil, err
	}
	_ = s.repository.UpdateUnit(ctx, bizLine, unit.ID, map[string]any{
		"state": string(contract.UnitRunning), "cid": claimed.CID, "started_at": now,
	})
	_ = s.repository.AppendUnitEvent(ctx, &repository.GalaxyUnitEvent{
		BizLine: bizLine, UnitID: unit.ID, Kind: "claimed", Message: "节点已领取",
		DataJSON: encodeJSON(map[string]any{"cid": claimed.CID}),
	})

	// 产物引用在这一刻才签地址：presigned 只有 15~60 分钟有效，
	// 入队时签好等节点领走可能早就过期了。对象键本身不含任何身份信息。
	if s.signer != nil {
		for index := range unit.Inputs {
			ref := unit.Inputs[index].Ref
			if ref == nil || ref.Key == "" {
				continue
			}
			if url, err := s.signer.SignGet(ctx, ref.Key, s.config.PresignGetTTL); err == nil {
				ref.URL = url
			}
		}
	}
	// 请求体在这一刻才装回信封：Redis 里它是单独一把短寿命的 key。
	if len(claimed.Body) > 0 {
		for index := range unit.Inputs {
			if unit.Inputs[index].Name == "body" && unit.Inputs[index].Ref == nil {
				unit.Inputs[index].Inline = claimed.Body
			}
		}
	}
	unit.State = contract.UnitRunning
	unit.CID = claimed.CID

	payload := map[string]any{}
	raw, err := json.Marshal(unit)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, err
	}
	instance := claimed.Instance
	if instance == "" {
		instance = s.config.Instance
	}
	return &dto.NextResult{
		Unit: payload,
		Lease: dto.LeaseView{
			Token: lease, RenewSec: renewSec,
			ExpiresAt: now.Add(time.Duration(renewSec) * time.Second).UnixMilli(),
		},
		StreamURL: fmt.Sprintf("%s/agent/v1/units/%s/stream", instance, unit.ID),
		Cancel:    cancels,
	}, nil
}

// AuthorizeUnit 校验单元当前确实落在这个节点上。节点令牌只证明「你是某个节点」，
// 不证明「这个单元是派给你的」—— 少了这一关，任何在线节点都能对别人的单元报终态。
func (s *service) AuthorizeUnit(ctx context.Context, unitID, nodeID string) error {
	runtime, found, err := s.control.LoadUnit(ctx, unitID)
	if err != nil {
		return err
	}
	if !found {
		return contract.NewUnitError(contract.ErrorClassProtocol, contract.CodeLeaseInvalid, false, "单元不存在或已结束")
	}
	return s.authorizeRuntime(ctx, runtime, nodeID)
}

func (s *service) authorizeRuntime(ctx context.Context, runtime UnitRuntime, nodeID string) error {
	if runtime.CID == "" {
		return contract.NewUnitError(contract.ErrorClassProtocol, contract.CodeLeaseInvalid, false, "单元尚未放置")
	}
	snapshot, found, err := s.control.GetContribution(ctx, runtime.CID)
	if err != nil {
		return err
	}
	if !found || snapshot.NodeID != nodeID {
		return contract.NewUnitError(contract.ErrorClassProtocol, contract.CodeLeaseInvalid, false, "该单元不在本节点上")
	}
	return nil
}

// checkLease 租约校验。空租约不算通过 —— 只认「Hub 发出去的那一串」，
// 否则节点漏传字段就等于绕过了整道校验。
func checkLease(runtime UnitRuntime, presented string) error {
	if runtime.Lease == "" {
		return nil // 还没派租约（例如刚放置就被 Hub 判失败）
	}
	if presented != runtime.Lease {
		return contract.NewUnitError(contract.ErrorClassProtocol, contract.CodeLeaseInvalid, false, "租约已失效")
	}
	return nil
}

func (s *service) Progress(ctx context.Context, req dto.ProgressRequest) (dto.ProgressResult, error) {
	runtime, found, err := s.control.LoadUnit(ctx, req.UnitID)
	if err != nil {
		return dto.ProgressResult{}, err
	}
	if !found {
		return dto.ProgressResult{}, contract.NewUnitError(contract.ErrorClassProtocol, contract.CodeLeaseInvalid, false, "单元不存在或已结束")
	}
	if err := s.authorizeRuntime(ctx, runtime, req.NodeID); err != nil {
		return dto.ProgressResult{}, err
	}
	if err := checkLease(runtime, req.Lease); err != nil {
		return dto.ProgressResult{}, err
	}
	cancelled, err := s.control.CancelRequested(ctx, req.UnitID)
	if err != nil {
		return dto.ProgressResult{}, err
	}
	spec, _ := s.kinds.Lookup(runtime.Kind, runtime.KindVersion)
	renewSec := spec.Lease.RenewSec
	if renewSec <= 0 {
		renewSec = 60
	}
	if req.Renew {
		if err := s.control.MarkRunning(ctx, req.UnitID, req.Lease, time.Now()); err != nil {
			return dto.ProgressResult{}, err
		}
	}
	if len(req.Progress) > 0 {
		_ = s.repository.AppendUnitEvent(ctx, &repository.GalaxyUnitEvent{
			BizLine: bizLine, UnitID: req.UnitID, Kind: "progress", DataJSON: encodeJSON(req.Progress),
		})
	}
	return dto.ProgressResult{
		CancelRequested: cancelled,
		Lease:           dto.LeaseView{Token: req.Lease, RenewSec: renewSec, ExpiresAt: time.Now().Add(time.Duration(renewSec) * time.Second).UnixMilli()},
	}, nil
}

// Complete 终态。Hub 以自己解析到的 usage 结算，节点自报只用于对账（S-04）。
func (s *service) Complete(ctx context.Context, req dto.CompleteRequest) (dto.CompleteResult, error) {
	runtime, found, err := s.control.LoadUnit(ctx, req.UnitID)
	if err != nil {
		return dto.CompleteResult{}, err
	}
	if !found {
		return dto.CompleteResult{}, contract.NewUnitError(contract.ErrorClassProtocol, contract.CodeLeaseInvalid, false, "单元不存在或已结束")
	}
	if err := s.authorizeRuntime(ctx, runtime, req.NodeID); err != nil {
		return dto.CompleteResult{}, err
	}
	if err := checkLease(runtime, req.Lease); err != nil {
		return dto.CompleteResult{}, err
	}

	state := contract.UnitState(req.State)
	if !state.Terminal() {
		state = contract.UnitCompleted
	}
	spec, _ := s.kinds.Lookup(runtime.Kind, runtime.KindVersion)
	actual := s.reconcileUsage(ctx, runtime, spec, req.Usage, state)
	billable := s.billable(state, req.Error, runtime)

	if err := s.settle(ctx, runtime, spec, actual, state, billable, req.Error); err != nil {
		return dto.CompleteResult{}, err
	}
	// 产物落库并进事件流：job 的结果就是这些引用，消费者查任务时按它签下载地址。
	for _, output := range req.Outputs {
		if output.Ref == nil || output.Ref.Key == "" {
			continue
		}
		_ = s.repository.SaveArtifact(ctx, &repository.GalaxyArtifact{
			BizLine: bizLine, ObjectKey: output.Ref.Key, UnitID: runtime.RID,
			OwnerKey: runtime.ConsumerKey, Kind: runtime.Kind,
			Size: output.Ref.Size, SHA256: output.Ref.SHA256, ContentType: output.Ref.ContentType,
		})
		// URL 不入库：签名地址短期有效，存下来只会变成一堆过期链接。
		clean := *output.Ref
		clean.URL = ""
		_ = s.repository.AppendUnitEvent(ctx, &repository.GalaxyUnitEvent{
			BizLine: bizLine, UnitID: runtime.RID, Kind: "output", DataJSON: encodeJSON(clean),
		})
	}
	// session：把节点交上来的 contextDelta 落进账本。放在结算之后 ——
	// 账本写失败不该让已经发生的用量结不了账。
	if spec.Primitive == contract.PrimitiveSession {
		s.recordTurn(ctx, runtime, req, state, actual)
	}
	if req.Error != nil && req.Error.Code == contract.CodeUpstream429 {
		// 上游限流：让这个贡献临时退出候选，不影响同机其他贡献（P-11）。
		_ = s.control.UpdateLaneRuntime(ctx, []LaneRuntime{{CID: runtime.CID, ThrottledUntil: time.Now().Add(2 * time.Minute), UpstreamOK: true}})
	}
	return dto.CompleteResult{Settled: actual}, nil
}

// reconcileUsage 合成最终用量：Hub 权威单位取自己解析的值，其余取节点自报。
// 偏差超阈值记 usage_mismatch，累计影响信誉（设计文档 2.7）。
func (s *service) reconcileUsage(ctx context.Context, runtime UnitRuntime, spec contract.KindSpec, nodeUsage contract.Metering, state contract.UnitState) contract.Metering {
	actual := contract.Metering{}
	hubUsage := runtime.HubUsage
	for _, unit := range spec.Metering.Units {
		switch {
		case spec.TrustsUnit(unit):
			if value, ok := hubUsage[unit]; ok {
				actual[unit] = value
				if nodeValue, reported := nodeUsage[unit]; reported && value > 0 {
					if ratio := math.Abs(float64(nodeValue-value)) / float64(value); ratio > s.config.UsageMismatchRatio {
						_ = s.repository.SaveUsageMismatch(ctx, &repository.GalaxyUsageMismatch{
							BizLine: bizLine, UnitID: runtime.RID, CID: runtime.CID, Unit: unit,
							HubValue: value, NodeValue: nodeValue, Ratio: ratio,
						})
						_ = s.repository.AdjustReputation(ctx, bizLine, runtime.CID, -0.02)
						s.metrics.Count(MetricUsageMismatch, map[string]string{"cid": runtime.CID, "unit": unit}, 1)
					}
				}
			} else if value, ok := nodeUsage[unit]; ok {
				// 上游格式变了、Hub 没解析出来：回退节点自报并留痕待审。
				actual[unit] = value
				_ = s.repository.AppendUnitEvent(ctx, &repository.GalaxyUnitEvent{
					BizLine: bizLine, UnitID: runtime.RID, Kind: "usage_parse_failed",
					Message: "Hub 未解析出用量，回退节点自报", DataJSON: encodeJSON(map[string]any{"unit": unit}),
				})
			}
		default:
			if value, ok := nodeUsage[unit]; ok {
				actual[unit] = value
			}
		}
	}
	// 次数与时长由 Hub 自己计，不看任何一方的申报。
	if spec.AllowsUnit(contract.UnitCalls) && state == contract.UnitCompleted {
		actual[contract.UnitCalls] = 1
	}
	if spec.AllowsUnit(contract.UnitTimeSeconds) && !runtime.PlacedAt.IsZero() {
		seconds := int64(math.Ceil(time.Since(runtime.PlacedAt).Seconds()))
		if seconds < 0 {
			seconds = 0
		}
		actual[contract.UnitTimeSeconds] = seconds
	}
	return actual
}

// billable 失败语义表（设计文档 6.2）：谁付钱、算不算提供者贡献。
func (s *service) billable(state contract.UnitState, cause *contract.UnitError, runtime UnitRuntime) bool {
	switch state {
	case contract.UnitCompleted:
		return true
	case contract.UnitCancelled:
		// 消费者主动断开按已产出计；Hub 侧取消（额度耗尽、贡献被停）不计。
		return !runtime.FirstByteAt.IsZero()
	case contract.UnitFailed:
		// 上游故障、节点故障、排队超时一律不计费。
		_ = cause
		return false
	}
	return false
}

// settle 结算：回补额度计数器、写计量流水与双账本、释放并发与座位。
func (s *service) settle(ctx context.Context, runtime UnitRuntime, spec contract.KindSpec, actual contract.Metering, state contract.UnitState, billable bool, cause *contract.UnitError) error {
	grants, err := s.loadGrants(ctx, []string{runtime.CID})
	if err != nil {
		return err
	}
	now := time.Now()
	// 窗口键按结算时刻算。请求跨过窗口翻转时，预留留在旧窗口的计数器里回滚不到，
	// 但旧计数器会在「窗口末 + 1 天」自动过期，而 contrib 上的 left 字段每次心跳
	// 都会用当前窗口的计数器重算，所以这点偏差不会累积。
	plan := BuildQuotaPlan(grants[runtime.CID], now)
	settled := actual
	if !billable {
		// 不计费也不烧提供者额度：预留原样回滚，实际用量只入流水做统计。
		settled = contract.Metering{}
	}
	if err := s.control.Settle(ctx, SettleCommand{
		RID: runtime.RID, CID: runtime.CID, ConsumerKey: runtime.ConsumerKey,
		Estimate: runtime.Estimate, Actual: settled, WindowKeys: plan.Windows,
		Lane: contract.Lane(runtime.Kind, runtime.Provider), State: state,
	}); err != nil {
		return err
	}

	values := map[string]any{
		"state": string(state), "finished_at": now, "actual_json": encodeJSON(actual),
	}
	if cause != nil {
		values["error_class"] = string(cause.Class)
		values["error_code"] = cause.Code
		values["error_message"] = truncate(cause.Message, 512)
	}
	_ = s.repository.UpdateUnit(ctx, bizLine, runtime.RID, values)
	errorClass := ""
	if cause != nil {
		errorClass = string(cause.Class)
	}
	s.metrics.Count(MetricUnitTotal, map[string]string{
		"kind": runtime.Kind, "state": string(state), "error_class": errorClass,
	}, 1)
	_ = s.repository.AppendUnitEvent(ctx, &repository.GalaxyUnitEvent{
		BizLine: bizLine, UnitID: runtime.RID, Kind: string(state),
		DataJSON: encodeJSON(map[string]any{"usage": actual, "billable": billable}),
	})
	return s.record(ctx, runtime, spec, actual, billable)
}

// FailUnit / Abandon 之外，会话回合的失败也要落账本，
// 否则 turn 会永远停在 running，下一次同 seq 的提交会被幂等挡掉。
func (s *service) failTurn(ctx context.Context, runtime UnitRuntime, cause *contract.UnitError) {
	spec, ok := s.kinds.Lookup(runtime.Kind, runtime.KindVersion)
	if !ok || spec.Primitive != contract.PrimitiveSession {
		return
	}
	s.recordTurn(ctx, runtime, dto.CompleteRequest{Error: cause}, contract.UnitFailed, contract.Metering{})
}

func (s *service) FirstByte(ctx context.Context, unitID string) error {
	now := time.Now()
	// 首字节延迟按放置时刻算：消费者感受到的等待就是从「提交」到「第一个字节」。
	if runtime, found, err := s.control.LoadUnit(ctx, unitID); err == nil && found && !runtime.PlacedAt.IsZero() {
		s.metrics.Observe(MetricTTFB, map[string]string{
			"kind": runtime.Kind, "provider": runtime.Provider, "cid": runtime.CID,
		}, float64(now.Sub(runtime.PlacedAt).Milliseconds()))
	}
	if err := s.control.MarkFirstByte(ctx, unitID, now); err != nil {
		return err
	}
	_ = s.repository.UpdateUnit(ctx, bizLine, unitID, map[string]any{"first_byte_at": now, "state": string(contract.UnitStreaming)})
	return nil
}

// Abandon 消费者主动断开：让节点尽快 abort 上游（验收标准要求 3 秒内）。
func (s *service) Abandon(ctx context.Context, unitID, reason string) error {
	_ = s.repository.AppendUnitEvent(ctx, &repository.GalaxyUnitEvent{
		BizLine: bizLine, UnitID: unitID, Kind: "cancel_requested", Message: reason,
	})
	return s.control.RequestCancel(ctx, unitID, reason)
}

// FailUnit 由 Hub 判定的失败：节点掉线、空闲超时、能力不匹配。
func (s *service) FailUnit(ctx context.Context, unitID string, cause *contract.UnitError) error {
	runtime, found, err := s.control.LoadUnit(ctx, unitID)
	if err != nil {
		return err
	}
	if !found {
		return s.markUnitFailed(ctx, unitID, cause)
	}
	spec, _ := s.kinds.Lookup(runtime.Kind, runtime.KindVersion)
	if cause != nil && cause.Class == contract.ErrorClassNode {
		_ = s.repository.AdjustReputation(ctx, bizLine, runtime.CID, -0.05)
	}
	s.failTurn(ctx, runtime, cause)
	return s.settle(ctx, runtime, spec, contract.Metering{}, contract.UnitFailed, false, cause)
}

func (s *service) markUnitFailed(ctx context.Context, unitID string, cause *contract.UnitError) error {
	values := map[string]any{"state": string(contract.UnitFailed), "finished_at": time.Now()}
	if cause != nil {
		values["error_class"] = string(cause.Class)
		values["error_code"] = cause.Code
		values["error_message"] = truncate(cause.Message, 512)
	}
	return s.repository.UpdateUnit(ctx, bizLine, unitID, values)
}

// Reassignable 首字节前可改派、kind 幂等、未超重试上限，三条同时成立才行。
func (s *service) Reassignable(ctx context.Context, unitID string) bool {
	runtime, found, err := s.control.LoadUnit(ctx, unitID)
	if err != nil || !found {
		return false
	}
	if !runtime.FirstByteAt.IsZero() {
		return false
	}
	spec, ok := s.kinds.Lookup(runtime.Kind, runtime.KindVersion)
	if !ok || !spec.Retry.Idempotent {
		return false
	}
	return runtime.Attempt < spec.Retry.MaxAttempts
}

// ContributionAlive 探一次贡献所在机器的心跳。
//
// 探测失败不算证据。Redis 抖一下就把正在正常服务的请求判死，比晚几十秒
// 发现节点掉线糟得多 —— 前者是把好请求杀了，后者只是多等一会儿。
// 所以只有「明确读到了快照，而快照说心跳已经过期」才判它不在。
func (s *service) ContributionAlive(ctx context.Context, cid string) bool {
	if cid == "" {
		return true
	}
	snapshot, found, err := s.control.GetContribution(ctx, cid)
	if err != nil {
		return true
	}
	if !found {
		return false
	}
	return Online(snapshot, time.Now(), s.config.HeartbeatTimeout)
}

func (s *service) RememberResponse(ctx context.Context, responseID, cid string) error {
	if responseID == "" || cid == "" {
		return nil
	}
	return s.control.RememberResponse(ctx, responseID, cid, 24*time.Hour)
}
