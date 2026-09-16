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

// 产物签名、池水位、巡检。

// SignUpload 申请上传输入的 presigned PUT（C-06）。
// 对象键不含任何用户、密钥、节点信息（约束：ArtifactRef.key）。
func (s *service) SignUpload(ctx context.Context, kind, name, contentType string, size int64, ownerKey string) (contract.ArtifactRef, error) {
	if s.signer == nil {
		return contract.ArtifactRef{}, fmt.Errorf("对象存储未配置，产物上传不可用")
	}
	if size <= 0 {
		return contract.ArtifactRef{}, fmt.Errorf("缺少产物大小")
	}
	objectKey := fmt.Sprintf("galaxy/%s/%s/%s", sanitizeSegment(kind), NewULID(time.Now()), sanitizeSegment(name))
	url, err := s.signer.SignPut(ctx, objectKey, contentType, size, s.cfg().PresignPutTTL)
	if err != nil {
		return contract.ArtifactRef{}, err
	}
	expires := time.Now().Add(s.cfg().PresignPutTTL)
	if err := s.repository.SaveArtifact(ctx, &repository.GalaxyArtifact{
		BizLine: bizLine, ObjectKey: objectKey, OwnerKey: ownerKey, Kind: kind,
		Size: size, ContentType: contentType, ExpiresAt: &expires,
	}); err != nil {
		return contract.ArtifactRef{}, err
	}
	return contract.ArtifactRef{
		Store: "oss", Key: objectKey, Size: size, ContentType: contentType,
		ExpiresAt: expires.UTC().Format(time.RFC3339), URL: url,
	}, nil
}

// SignNodeUpload 给节点签一个上传产物的地址。
//
// 节点不能用消费者那条 /v1/artifacts：它手里只有 node token，而且对象键必须由 Hub 生成 ——
// 让节点自己起名字，等于把「对象键不含身份信息」这条约束交给不可信的一方去守。
func (s *service) SignNodeUpload(ctx context.Context, unitID, name, contentType string, size int64) (contract.ArtifactRef, error) {
	if s.signer == nil {
		return contract.ArtifactRef{}, fmt.Errorf("对象存储未配置，产物上传不可用")
	}
	runtime, found, err := s.control.LoadUnit(ctx, unitID)
	if err != nil {
		return contract.ArtifactRef{}, err
	}
	if !found {
		return contract.ArtifactRef{}, contract.NewUnitError(contract.ErrorClassProtocol, contract.CodeLeaseInvalid, false, "单元不存在或已结束")
	}
	ref, err := s.SignUpload(ctx, runtime.Kind, name, contentType, size, runtime.ConsumerKey)
	if err != nil {
		return contract.ArtifactRef{}, err
	}
	_ = s.repository.SaveArtifact(ctx, &repository.GalaxyArtifact{
		BizLine: bizLine, ObjectKey: ref.Key, UnitID: unitID, OwnerKey: runtime.ConsumerKey,
		Kind: runtime.Kind, Size: size, ContentType: contentType,
	})
	return ref, nil
}

func (s *service) SignDownload(ctx context.Context, objectKey string) (contract.ArtifactRef, error) {
	if s.signer == nil {
		return contract.ArtifactRef{}, fmt.Errorf("对象存储未配置，产物下载不可用")
	}
	row, err := s.repository.FindArtifact(ctx, bizLine, objectKey)
	if notFound(err) {
		return contract.ArtifactRef{}, contract.NewUnitError(contract.ErrorClassInput, contract.CodeArtifactMissing, false, "产物不存在")
	}
	if err != nil {
		return contract.ArtifactRef{}, err
	}
	if row.Deleted {
		return contract.ArtifactRef{}, contract.NewUnitError(contract.ErrorClassInput, contract.CodeArtifactMissing, false, "产物已按保留期清理")
	}
	url, err := s.signer.SignGet(ctx, objectKey, s.cfg().PresignGetTTL)
	if err != nil {
		return contract.ArtifactRef{}, err
	}
	return contract.ArtifactRef{
		Store: "oss", Key: objectKey, Size: row.Size, SHA256: row.SHA256, ContentType: row.ContentType,
		ExpiresAt: time.Now().Add(s.cfg().PresignGetTTL).UTC().Format(time.RFC3339), URL: url,
	}, nil
}

// sanitizeSegment 把对象键的每一段限制成安全字符，避免用户可控的名字穿出目录。
func sanitizeSegment(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "unnamed"
	}
	var builder strings.Builder
	for _, char := range value {
		switch {
		case char >= 'a' && char <= 'z', char >= 'A' && char <= 'Z', char >= '0' && char <= '9',
			char == '.', char == '-', char == '_':
			builder.WriteRune(char)
		default:
			builder.WriteByte('_')
		}
	}
	out := builder.String()
	if len(out) > 96 {
		out = out[:96]
	}
	return out
}

func (s *service) RecordHubResult(ctx context.Context, unitID string, usage contract.Metering, signature string) error {
	// 抽检样本在这一刻凑齐：节点那次的响应签名有了，就等 Hub 自己重放一遍去比。
	s.markProbeReady(ctx, unitID, signature)
	if len(usage) == 0 {
		return nil
	}
	return s.control.RecordHubUsage(ctx, unitID, usage)
}

func (s *service) LookupResponseContribution(ctx context.Context, responseID string) (string, bool) {
	cid, found, err := s.control.LookupResponse(ctx, responseID)
	if err != nil {
		return "", false
	}
	return cid, found
}

// PoolStatus 池水位：供需缺口一眼可见（S-09）。
func (s *service) PoolStatus(ctx context.Context) (dto.PoolStatus, error) {
	rows, err := s.repository.ListActiveContributions(ctx, bizLine)
	if err != nil {
		return dto.PoolStatus{}, err
	}
	grants, err := s.loadGrants(ctx, cidsOf(rows))
	if err != nil {
		return dto.PoolStatus{}, err
	}
	now := time.Now()
	lanes := map[string]*dto.LaneStatus{}
	for _, row := range rows {
		lane := contract.Lane(row.Kind, row.Provider)
		status, ok := lanes[lane]
		if !ok {
			status = &dto.LaneStatus{Kind: row.Kind, Provider: row.Provider}
			lanes[lane] = status
		}
		status.Contributions++
		status.SeatsTotal += row.Seats
		snapshot, found, _ := s.control.GetContribution(ctx, row.CID)
		if !found {
			continue
		}
		if Online(snapshot, now, s.cfg().HeartbeatTimeout) {
			status.Online++
		}
		status.SeatsUsed += snapshot.SeatsUsed
		status.Inflight += snapshot.Inflight
		status.SeatsEffective += EffectiveSeats(snapshot, BuildQuotaPlan(grants[row.CID], now), now, nil)
		if snapshot.Draining {
			status.Draining++
		}
		if !snapshot.ThrottledUntil.IsZero() && snapshot.ThrottledUntil.After(now) {
			status.Throttled++
		}
	}
	s.waiting.Lock()
	waiting := map[string]int{}
	for kind, count := range s.waiting.byKind {
		waiting[kind] = count
		s.metrics.Gauge(MetricWaitQueueDepth, map[string]string{"kind": kind}, float64(count))
	}
	s.waiting.Unlock()

	out := dto.PoolStatus{Lanes: make([]dto.LaneStatus, 0, len(lanes))}
	for _, status := range lanes {
		status.WaitQueueDepth = waiting[status.Kind]
		out.Lanes = append(out.Lanes, *status)
	}
	sort.Slice(out.Lanes, func(i, j int) bool {
		if out.Lanes[i].Kind == out.Lanes[j].Kind {
			return out.Lanes[i].Provider < out.Lanes[j].Provider
		}
		return out.Lanes[i].Kind < out.Lanes[j].Kind
	})
	return out, nil
}

// Sweep 巡检：密钥到期转冻结、掉线节点摘除、额度计数器快照。
// 定时跑，不依赖请求触发 —— 一把长期不用的密钥也必须按时失效。
func (s *service) Sweep(ctx context.Context) error {
	if _, err := s.repository.ExpireConsumerKeys(ctx, bizLine, time.Now(), s.cfg().KeyFreeze); err != nil {
		return err
	}
	now := time.Now()
	// 心跳过期的机器降为离线。
	//
	// 这一步不能省，也不能靠下面那个「遍历贡献」的循环代劳：那条路只看得见
	// 有贡献的机器。刚配对、还没 hello 的机器一条贡献都没有，于是 status 永远
	// 停在 pair 时写下的 active —— 界面上就是一台「在线」了半小时、
	// 却一次心跳都没有过的机器。
	if _, err := s.repository.MarkStaleNodesOffline(ctx, bizLine, now.Add(-s.cfg().HeartbeatTimeout)); err != nil {
		return err
	}
	rows, err := s.repository.ListActiveContributions(ctx, bizLine)
	if err != nil {
		return err
	}
	windows := make([]*repository.GalaxyQuotaWindow, 0, len(rows))
	grants, err := s.loadGrants(ctx, cidsOf(rows))
	if err != nil {
		return err
	}
	offline := map[string]bool{}
	for _, row := range rows {
		snapshot, found, _ := s.control.GetContribution(ctx, row.CID)
		if !found || !Online(snapshot, now, s.cfg().HeartbeatTimeout) {
			offline[row.NodeID] = true
			continue
		}
		plan := BuildQuotaPlan(grants[row.CID], now)
		for unit, windowKey := range plan.Windows {
			windows = append(windows, &repository.GalaxyQuotaWindow{
				BizLine: bizLine, CID: row.CID, Unit: unit, WindowKey: windowKey,
				Used: snapshot.QuotaUsed[unit], Reserved: snapshot.QuotaReserved[unit], SnapshotAt: now,
			})
		}
	}
	for nodeID := range offline {
		_ = s.repository.MarkNodeOffline(ctx, bizLine, nodeID)
	}
	if err := s.sweepSessions(ctx, now); err != nil {
		return err
	}
	if _, err := s.RequeueStaleJobs(ctx, now); err != nil {
		return err
	}
	return s.repository.SnapshotQuotaWindow(ctx, windows)
}

// sweepSessions 关掉长期没有回合的会话。座位是稀缺资源：
// 一个被遗忘的会话钉着不放，等于让整台机器只服务一个不再回来的人。
func (s *service) sweepSessions(ctx context.Context, now time.Time) error {
	rows, err := s.repository.SweepIdleSessions(ctx, bizLine, now.Add(-s.cfg().SessionIdleTTL))
	if err != nil {
		return err
	}
	for _, row := range rows {
		if err := s.CloseSession(ctx, dto.CloseSessionRequest{SID: row.SID, Reason: "idle_timeout"}); err != nil {
			return err
		}
	}
	return nil
}

// UnitState 只读一个单元的状态。SSE 的兜底轮询每 15 秒问一次，
// 走 GetJob 会把全部事件也捞一遍 —— 那是每个订阅者每 15 秒一次的无谓扫描。
func (s *service) UnitState(ctx context.Context, unitID string) (contract.UnitState, error) {
	row, err := s.repository.FindUnit(ctx, bizLine, unitID)
	if notFound(err) {
		return "", contract.ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return contract.UnitState(row.State), nil
}

// UnitEventView 一条已经落库的单元事件。消费者断线重连时先回放它们，再接上实时流。
type UnitEventView struct {
	Seq  int             `json:"seq"`
	Kind string          `json:"kind"`
	Data json.RawMessage `json:"data,omitempty"`
	At   time.Time       `json:"at"`
}

// ListUnitEvents 回放一个单元的事件。fromSeq 之后的才返回。
func (s *service) ListUnitEvents(ctx context.Context, unitID string, fromSeq int) ([]UnitEventView, error) {
	rows, err := s.repository.ListUnitEvents(ctx, bizLine, unitID, fromSeq)
	if err != nil {
		return nil, err
	}
	views := make([]UnitEventView, 0, len(rows))
	for _, row := range rows {
		view := UnitEventView{Seq: row.Seq, Kind: row.Kind, At: row.CreatedAt}
		if row.DataJSON != "" {
			view.Data = json.RawMessage(row.DataJSON)
		}
		views = append(views, view)
	}
	return views, nil
}

// AppendUnitEvent 由事件日志在落库时回调。业务事件与通道事件共用一张表：
// 排障时「消费者看到什么」和「通道发生了什么」在同一条时间线上。
func (s *service) AppendUnitEvent(ctx context.Context, unitID string, seq int, kind string, data []byte) error {
	return s.repository.AppendUnitEvent(ctx, &repository.GalaxyUnitEvent{
		BizLine: bizLine, UnitID: unitID, Seq: seq, Kind: truncate(kind, 32), DataJSON: string(data),
	})
}
