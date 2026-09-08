package galaxy

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// session 原语：有状态多回合，上下文分三层 ——
// 业务层在服务端账本、执行层在节点 CLI thread、工作区层在 Git 远端（架构第 9 节）。
//
// 这个文件只管业务层那一层。原则是「服务端账本是业务真相，节点 thread 是执行缓存」：
// 每个回合结束节点把 contextDelta 交上来，节点死了服务端仍拥有完整业务上下文。

const (
	sessionOpen      = "open"
	sessionPinned    = "pinned"
	sessionMigrating = "migrating"
	sessionClosed    = "closed"

	turnRunning = "running"
	turnDone    = "completed"
	turnFailed  = "failed"

	// resumeDigestTurns 续接提示里带多少个历史回合的摘要。
	// 全带上会把提示撑爆，只带最近这些 —— 更早的业务上下文由消费者自己在 input 里给。
	resumeDigestTurns = 20
)

func (s *service) OpenSession(ctx context.Context, req dto.OpenSessionRequest) (dto.SessionView, error) {
	spec, ok := s.kinds.Lookup(req.Kind, req.KindVersion)
	if !ok {
		return dto.SessionView{}, contract.NewUnitError(contract.ErrorClassInput, contract.CodeInvalidBody, false,
			fmt.Sprintf("能力 %s 未注册", contract.KindRef(req.Kind, req.KindVersion)))
	}
	if spec.Primitive != contract.PrimitiveSession {
		return dto.SessionView{}, contract.NewUnitError(contract.ErrorClassInput, contract.CodeInvalidBody, false,
			fmt.Sprintf("%s 不是有状态能力，用不上会话", spec.Kind))
	}
	if !spec.SupportsProvider(req.Provider) {
		return dto.SessionView{}, contract.NewUnitError(contract.ErrorClassInput, contract.CodeInvalidBody, false,
			fmt.Sprintf("provider %s 不属于 %s", req.Provider, spec.Kind))
	}

	now := time.Now()
	row := &repository.GalaxyLedgerSession{
		BizLine: bizLine, SID: "s_" + NewULID(now),
		Kind: spec.Kind, KindVersion: spec.Version, Provider: req.Provider,
		ConsumerKey: req.ConsumerKey, Space: truncate(req.Space, 64), ProgramRef: truncate(req.ProgramRef, 128),
		State: sessionOpen, WorkspaceRefJSON: encodeJSON(req.WorkspaceRef),
		ContextSchemaVersion: defaultString(req.ContextShema, spec.Context.Schema),
	}
	if err := s.repository.CreateSession(ctx, row); err != nil {
		return dto.SessionView{}, err
	}
	return sessionView(row), nil
}

// AuthorizeSession 会话归属校验。别人的会话既不能读上下文，也不能往里塞回合 ——
// 会话里有业务原文，串了就是数据泄露。
func (s *service) AuthorizeSession(ctx context.Context, sid, consumerKey string) error {
	row, err := s.repository.FindSession(ctx, bizLine, sid)
	if notFound(err) {
		return contract.ErrNotFound
	}
	if err != nil {
		return err
	}
	if consumerKey != "" && row.ConsumerKey != consumerKey {
		return contract.NewUnitError(contract.ErrorClassBilling, contract.CodeScopeDenied, false, "无权访问该会话")
	}
	return nil
}

func (s *service) GetSession(ctx context.Context, sid string) (dto.SessionView, error) {
	row, err := s.repository.FindSession(ctx, bizLine, sid)
	if notFound(err) {
		return dto.SessionView{}, contract.ErrNotFound
	}
	if err != nil {
		return dto.SessionView{}, err
	}
	return sessionView(row), nil
}

func (s *service) ListSessions(ctx context.Context, consumerKey string, limit int) ([]dto.SessionView, error) {
	rows, err := s.repository.ListSessions(ctx, repository.SessionQuery{
		BizLine: bizLine, ConsumerKey: consumerKey, Limit: clampLimit(limit),
	})
	if err != nil {
		return nil, err
	}
	views := make([]dto.SessionView, 0, len(rows))
	for _, row := range rows {
		views = append(views, sessionView(row))
	}
	return views, nil
}

// CloseSession 结束会话并释放它钉着的座位。
// 座位是稀缺资源，一个没人管的会话钉着不放会让整台机器只服务一个人。
func (s *service) CloseSession(ctx context.Context, req dto.CloseSessionRequest) error {
	row, err := s.repository.FindSession(ctx, bizLine, req.SID)
	if notFound(err) {
		return contract.ErrNotFound
	}
	if err != nil {
		return err
	}
	if req.ConsumerKey != "" && row.ConsumerKey != req.ConsumerKey {
		return contract.NewUnitError(contract.ErrorClassBilling, contract.CodeScopeDenied, false, "无权操作该会话")
	}
	if row.State == sessionClosed {
		return nil
	}
	if err := s.repository.UpdateSession(ctx, bizLine, req.SID, map[string]any{
		"state": sessionClosed, "close_reason": truncate(defaultString(req.Reason, "closed"), 128),
	}); err != nil {
		return err
	}
	return s.releaseSessionSeat(ctx, row)
}

func (s *service) releaseSessionSeat(ctx context.Context, row *repository.GalaxyLedgerSession) error {
	if row.CID == "" {
		return nil
	}
	lane := contract.Lane(row.Kind, row.Provider)
	affinity := sessionAffinity(row.ConsumerKey, row.SID)
	if err := s.control.ReleaseBinding(ctx, affinity, lane, row.CID); err != nil {
		return err
	}
	return s.repository.ReleaseSeatBinding(ctx, bizLine, row.CID, affinity, lane, time.Now())
}

// sessionAffinity 会话的亲和键。用 sid 而不是 consumerKey：
// 同一个人同时开三个会话，应该各自钉各自的座位，而不是互相抢。
func sessionAffinity(consumerKey, sid string) string { return consumerKey + ":" + sid }

// BeginTurn 占位一个回合，并算出这次该用什么 op、要不要钉在原贡献上。
//
// 三条路径：
//
//	第一回合           → op=open，正常放置，落到哪算哪
//	原贡献还在         → op=turn，硬钉，节点用本地 thread 接着跑
//	原贡献不在了       → op=resume，重新放置，把账本与工作区交给新节点重建上下文
func (s *service) BeginTurn(ctx context.Context, req dto.BeginTurnRequest) (dto.TurnPlan, error) {
	row, err := s.repository.FindSession(ctx, bizLine, req.SID)
	if notFound(err) {
		return dto.TurnPlan{}, contract.ErrNotFound
	}
	if err != nil {
		return dto.TurnPlan{}, err
	}
	if req.ConsumerKey != "" && row.ConsumerKey != req.ConsumerKey {
		return dto.TurnPlan{}, contract.NewUnitError(contract.ErrorClassBilling, contract.CodeScopeDenied, false, "无权操作该会话")
	}
	if row.State == sessionClosed {
		return dto.TurnPlan{}, contract.NewUnitError(contract.ErrorClassInput, contract.CodeInvalidBody, false, "会话已结束")
	}

	seq := req.Seq
	if seq <= 0 {
		seq = row.LastSeq + 1
	}
	plan := dto.TurnPlan{SID: row.SID, Seq: seq}

	// 幂等：同一个 seq 提交两次不重跑，直接把已有结果还回去（设计文档 2.9）。
	now := time.Now()
	claim := &repository.GalaxyLedgerTurn{
		BizLine: bizLine, SID: row.SID, Seq: seq,
		InputJSON: encodeJSON(req.Input), State: turnRunning, StartedAt: now,
	}
	if err := s.repository.ClaimTurnSeq(ctx, claim); err != nil {
		existing, findErr := s.repository.FindTurn(ctx, bizLine, row.SID, seq)
		if findErr != nil {
			return dto.TurnPlan{}, err
		}
		view := turnView(existing)
		plan.Existing = &view
		return plan, nil
	}

	switch {
	case row.CID == "":
		plan.Op = contract.OpOpen
	default:
		snapshot, found, err := s.control.GetContribution(ctx, row.CID)
		if err != nil {
			return dto.TurnPlan{}, err
		}
		healthy := found && Online(snapshot, now, s.config.HeartbeatTimeout) && !snapshot.Draining && !snapshot.Paused
		if healthy {
			plan.Op = contract.OpTurn
			plan.HardPin = row.CID
			break
		}
		// 原贡献不在了：显式迁移。session 的硬亲和不是「必须回去」，
		// 而是「不回去就得把上下文交接清楚」（T-07）。
		plan.Op = contract.OpResume
		resume, err := s.buildResume(ctx, row)
		if err != nil {
			return dto.TurnPlan{}, err
		}
		plan.Resume = resume
		if err := s.repository.UpdateSession(ctx, bizLine, row.SID, map[string]any{"state": sessionMigrating}); err != nil {
			return dto.TurnPlan{}, err
		}
		_ = s.releaseSessionSeat(ctx, row)
	}
	return plan, nil
}

// buildResume 攒出跨节点续接要交给新节点的东西：工作区 sha、最近一次 checkpoint、
// 账本摘要。checkpoint 是高保真但绑 CLI 版本，摘要是有损兜底。
func (s *service) buildResume(ctx context.Context, row *repository.GalaxyLedgerSession) (*dto.ResumeContext, error) {
	resume := &dto.ResumeContext{FromSeq: row.LastSeq}
	if row.WorkspaceRefJSON != "" {
		var workspace map[string]any
		if err := json.Unmarshal([]byte(row.WorkspaceRefJSON), &workspace); err == nil {
			resume.WorkspaceRef = workspace
		}
	}
	if checkpoint, err := s.repository.LatestCheckpoint(ctx, bizLine, row.SID); err == nil && checkpoint != nil {
		ref := contract.ArtifactRef{Store: "oss", Key: checkpoint.ObjectKey, Size: checkpoint.Size}
		if s.signer != nil {
			if url, err := s.signer.SignGet(ctx, checkpoint.ObjectKey, s.config.PresignGetTTL); err == nil {
				ref.URL = url
			}
		}
		resume.Checkpoint = &dto.CheckpointRef{
			Provider: checkpoint.Provider, CLIVersion: checkpoint.CLIVersion, Ref: ref, Seq: checkpoint.Seq,
		}
	} else if err != nil && !notFound(err) {
		return nil, err
	}

	from := row.LastSeq - resumeDigestTurns
	if from < 0 {
		from = 0
	}
	turns, err := s.repository.ListTurns(ctx, bizLine, row.SID, from, resumeDigestTurns)
	if err != nil {
		return nil, err
	}
	for _, turn := range turns {
		resume.Digest = append(resume.Digest, dto.TurnDigest{
			Seq: turn.Seq, OutputSummary: turn.OutputSummary, ChangedFiles: decodeStrings(turn.ChangedFilesJSON),
		})
	}
	// 工作区层的权威在 Git 远端。上一个节点没推的改动，新节点 fetch 不到 ——
	// 这件事必须让用户看见，续接提示里也要明说（T-09）。
	resume.WorkspaceLost = resume.WorkspaceRef == nil
	return resume, nil
}

// pinSession 放置成功后把会话钉到这个贡献上。
func (s *service) pinSession(ctx context.Context, sid, cid string) {
	if sid == "" || cid == "" {
		return
	}
	_ = s.repository.UpdateSession(ctx, bizLine, sid, map[string]any{"cid": cid, "state": sessionPinned})
}

// recordTurn 回合终态：把节点交上来的 contextDelta 落进账本。
// 这是「节点死了服务端仍拥有完整业务上下文」的落点（T-08）。
func (s *service) recordTurn(ctx context.Context, runtime UnitRuntime, req dto.CompleteRequest, state contract.UnitState, usage contract.Metering) {
	turn, err := s.repository.FindTurnByUnit(ctx, bizLine, runtime.RID)
	if err != nil {
		// 单元不是回合（relay / job），或者回合行还没落库。前者是常态，不记日志。
		return
	}
	now := time.Now()
	delta := parseContextDelta(req.ContextDelta)
	turnState := turnDone
	if state != contract.UnitCompleted {
		turnState = turnFailed
	}
	values := map[string]any{
		"state": turnState, "ended_at": now, "usage_json": encodeJSON(usage), "cid": runtime.CID,
	}
	if delta != nil {
		values["output_summary"] = delta.OutputSummary
		values["tool_calls_json"] = encodeJSON(delta.ToolCalls)
		values["changed_files_json"] = encodeJSON(delta.ChangedFiles)
		values["artifacts_json"] = encodeJSON(delta.Artifacts)
		values["external_thread_id"] = truncate(delta.ExternalThreadID, 128)
		values["workspace_lost"] = delta.WorkspaceLost
	}

	session := map[string]any{"last_turn_at": now}
	if state == contract.UnitCompleted {
		// 只有跑完的回合才推进游标：失败的回合允许用同一个 seq 重来。
		session["last_seq"] = turn.Seq
		session["state"] = sessionPinned
		session["cid"] = runtime.CID
	}
	if len(req.WorkspaceRef) > 0 {
		session["workspace_ref_json"] = encodeJSON(req.WorkspaceRef)
	}
	if err := s.repository.CompleteTurn(ctx, bizLine, turn.SID, turn.Seq, values, session); err != nil {
		return
	}
	if req.CheckpointRef != nil && req.CheckpointRef.Key != "" {
		_ = s.repository.SaveCheckpoint(ctx, &repository.GalaxyLedgerCheckpoint{
			BizLine: bizLine, SID: turn.SID, Seq: turn.Seq,
			Provider: runtime.Provider, CLIVersion: checkpointVersion(req.ContextDelta),
			ObjectKey: req.CheckpointRef.Key, Size: req.CheckpointRef.Size,
		})
	}
}

func parseContextDelta(raw map[string]any) *dto.ContextDelta {
	if len(raw) == 0 {
		return nil
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return nil
	}
	var delta dto.ContextDelta
	if err := json.Unmarshal(encoded, &delta); err != nil {
		return nil
	}
	return &delta
}

// checkpointVersion 从 contextDelta 里取 CLI 版本。快照绑版本：
// 版本对不上就只能靠账本摘要重建 thread，那是有损的。
func checkpointVersion(raw map[string]any) string {
	if value, ok := raw["cliVersion"].(string); ok {
		return truncate(value, 32)
	}
	return ""
}

// SessionContext 业务层上下文的全部。节点不在了它仍然完整。
func (s *service) SessionContext(ctx context.Context, sid string, fromSeq int) (dto.SessionContextView, error) {
	row, err := s.repository.FindSession(ctx, bizLine, sid)
	if notFound(err) {
		return dto.SessionContextView{}, contract.ErrNotFound
	}
	if err != nil {
		return dto.SessionContextView{}, err
	}
	turns, err := s.repository.ListTurns(ctx, bizLine, sid, fromSeq, 0)
	if err != nil {
		return dto.SessionContextView{}, err
	}
	view := dto.SessionContextView{Session: sessionView(row)}
	for _, turn := range turns {
		view.Turns = append(view.Turns, turnView(turn))
	}
	return view, nil
}

func (s *service) GetTurn(ctx context.Context, sid string, seq int) (dto.TurnView, error) {
	row, err := s.repository.FindTurn(ctx, bizLine, sid, seq)
	if notFound(err) {
		return dto.TurnView{}, contract.ErrNotFound
	}
	if err != nil {
		return dto.TurnView{}, err
	}
	return turnView(row), nil
}

func sessionView(row *repository.GalaxyLedgerSession) dto.SessionView {
	view := dto.SessionView{
		SID: row.SID, KeyID: row.ConsumerKey, Kind: row.Kind, KindVersion: row.KindVersion, Provider: row.Provider,
		Space: row.Space, ProgramRef: row.ProgramRef, State: row.State, LastSeq: row.LastSeq,
		CreatedTime: row.CreatedTime, LastTurnAt: row.LastTurnAt, CloseReason: row.CloseReason,
	}
	if row.WorkspaceRefJSON != "" {
		var workspace map[string]any
		if err := json.Unmarshal([]byte(row.WorkspaceRefJSON), &workspace); err == nil {
			view.WorkspaceRef = workspace
		}
	}
	return view
}

func turnView(row *repository.GalaxyLedgerTurn) dto.TurnView {
	return dto.TurnView{
		SID: row.SID, Seq: row.Seq, UnitID: row.UnitID, State: row.State,
		OutputSummary: row.OutputSummary, ToolCalls: decodeMaps(row.ToolCallsJSON),
		ChangedFiles: decodeStrings(row.ChangedFilesJSON), Artifacts: decodeMaps(row.ArtifactsJSON),
		Usage: decodeMetering(row.UsageJSON), ExternalThreadID: row.ExternalThreadID,
		WorkspaceLost: row.WorkspaceLost, StartedAt: row.StartedAt, EndedAt: row.EndedAt,
	}
}

func decodeMaps(raw string) []map[string]any {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var out []map[string]any
	_ = json.Unmarshal([]byte(raw), &out)
	return out
}
