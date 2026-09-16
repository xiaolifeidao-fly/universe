package galaxy

import (
	"context"
	"encoding/json"
	"time"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// job 原语：异步长任务。分钟到小时级，输入输出全部 OSS 引用，无亲和。
//
// 它和 session 的区别在幂等：回合不能重跑（agent 已经写过文件了），
// 任务可以 —— 输入自包含、在 OSS 上，任意节点按 attempt 重跑一遍结果一样。
// 所以租约过期就是「换台机器重来」，不是失败。

// JobRequeueGrace 租约过期多久之后判定这台机器跑丢了。
// 取三个续租周期：偶尔一次网络抖动不该把一个跑了半小时的任务作废重来。
const JobRequeueGrace = 3 * time.Minute

func (s *service) GetJob(ctx context.Context, unitID, consumerKey string) (dto.JobView, error) {
	row, err := s.repository.FindUnit(ctx, bizLine, unitID)
	if notFound(err) {
		return dto.JobView{}, contract.ErrNotFound
	}
	if err != nil {
		return dto.JobView{}, err
	}
	if consumerKey != "" && row.ConsumerKey != consumerKey {
		return dto.JobView{}, contract.NewUnitError(contract.ErrorClassBilling, contract.CodeScopeDenied, false, "无权访问该任务")
	}
	return s.jobView(ctx, row)
}

func (s *service) ListJobs(ctx context.Context, consumerKey, kind string, limit int) ([]dto.JobView, error) {
	rows, _, err := s.repository.ListUnits(ctx, repository.UnitQuery{
		BizLine: bizLine, ConsumerKey: consumerKey, Kind: kind,
		Primitive: string(contract.PrimitiveJob), Limit: clampLimit(limit),
	})
	if err != nil {
		return nil, err
	}
	views := make([]dto.JobView, 0, len(rows))
	for _, row := range rows {
		view, err := s.jobView(ctx, row)
		if err != nil {
			return nil, err
		}
		views = append(views, view)
	}
	return views, nil
}

func (s *service) jobView(ctx context.Context, row *repository.GalaxyUnit) (dto.JobView, error) {
	view := dto.JobView{
		JobID: row.UnitID, KeyID: row.ConsumerKey, Kind: row.Kind, State: row.State, Attempt: row.Attempt,
		ErrorCode: row.ErrorCode, ErrorMessage: row.ErrorMsg,
		Usage: decodeMetering(row.ActualJSON), CreatedTime: row.CreatedTime,
		StartedAt: row.StartedAt, FinishedAt: row.FinishedAt,
	}
	// 进度与产物都在事件流里：任务跑几小时，把每次进度写回单元行等于高频写主表。
	events, err := s.repository.ListUnitEvents(ctx, bizLine, row.UnitID, 0)
	if err != nil {
		return view, err
	}
	for _, event := range events {
		switch event.Kind {
		case "progress":
			var progress dto.JobProgress
			if json.Unmarshal([]byte(event.DataJSON), &progress) == nil {
				view.Progress = &progress
			}
		case "artifact", "output":
			var ref contract.ArtifactRef
			if json.Unmarshal([]byte(event.DataJSON), &ref) == nil && ref.Key != "" {
				view.Outputs = append(view.Outputs, ref)
			}
		}
	}
	// 产物引用现签：对象键不含身份信息，签名地址短期有效，不入库。
	if s.signer != nil {
		for index := range view.Outputs {
			if url, err := s.signer.SignGet(ctx, view.Outputs[index].Key, s.cfg().PresignGetTTL); err == nil {
				view.Outputs[index].URL = url
			}
		}
	}
	return view, nil
}

// CancelJob 消费者主动取消。取消是尽力而为：信号搭在节点已有的长轮询与进度上报上，
// 延迟不超过一个上报周期（T-05）。
func (s *service) CancelJob(ctx context.Context, unitID, consumerKey string) error {
	row, err := s.repository.FindUnit(ctx, bizLine, unitID)
	if notFound(err) {
		return contract.ErrNotFound
	}
	if err != nil {
		return err
	}
	if consumerKey != "" && row.ConsumerKey != consumerKey {
		return contract.NewUnitError(contract.ErrorClassBilling, contract.CodeScopeDenied, false, "无权取消该任务")
	}
	if contract.UnitState(row.State).Terminal() {
		return nil
	}
	return s.Abandon(ctx, unitID, "consumer_cancelled")
}

// RequeueStaleJobs 把租约过期的任务换一台机器重跑。
//
// 这是 job 与另外两种原语最大的不同：relay 首字节之后掉线只能报 502，
// session 的回合不能重跑，而 job 的输入在 OSS 上、执行幂等，
// 换台机器重来一次结果一样 —— 所以节点跑丢了不该让用户重新提交。
func (s *service) RequeueStaleJobs(ctx context.Context, now time.Time) (int, error) {
	rows, err := s.repository.ListStaleUnits(ctx, bizLine, string(contract.PrimitiveJob),
		now.Add(-JobRequeueGrace), 100)
	if err != nil {
		return 0, err
	}
	requeued := 0
	for _, row := range rows {
		expired, err := s.control.LeaseExpired(ctx, row.UnitID, JobRequeueGrace)
		if err != nil || !expired {
			continue
		}
		if s.requeue(ctx, row) {
			requeued++
		}
	}
	return requeued, nil
}

func (s *service) requeue(ctx context.Context, row *repository.GalaxyUnit) bool {
	runtime, found, err := s.control.LoadUnit(ctx, row.UnitID)
	if err != nil || !found || len(runtime.Envelope) == 0 {
		// 信封已经过期（24h）：这个任务没法自动重放了，落成失败让用户看见。
		_ = s.markUnitFailed(ctx, row.UnitID, contract.NewUnitError(
			contract.ErrorClassNode, contract.CodeLeaseExpired, false, "执行中断且原始请求已过期，请重新提交"))
		return false
	}
	spec, ok := s.kinds.Lookup(runtime.Kind, runtime.KindVersion)
	if !ok {
		return false
	}
	if row.Attempt >= spec.Retry.MaxAttempts {
		_ = s.adjustReputation(ctx, runtime.CID, -0.05)
		cause := contract.NewUnitError(contract.ErrorClassNode, contract.CodeLeaseExpired, false, "重试次数已用尽")
		_ = s.settle(ctx, runtime, spec, contract.Metering{}, contract.UnitFailed, false, cause)
		return false
	}

	// 先把上一次的预留与并发还回去，再重派。顺序反了会让这个贡献的 inflight
	// 一直挂着一个永远不会结束的请求。
	_ = s.adjustReputation(ctx, runtime.CID, -0.05)
	done, err := s.control.Settle(ctx, SettleCommand{
		RID: runtime.RID, CID: runtime.CID, ConsumerKey: runtime.ConsumerKey,
		Estimate: runtime.Estimate, Actual: contract.Metering{},
		WindowKeys: map[contract.MeterUnit]string{}, Lane: contract.Lane(runtime.Kind, runtime.Provider),
		State: contract.UnitFailed,
	})
	if err != nil {
		return false
	}
	if !done {
		// 这个单元已经结过账了（终态早就到了，只是这条重试路径还在跑）。
		// 再派一次会让一个已经收过钱的单元重新进入执行，绝不能继续。
		return false
	}

	var unit contract.WorkUnit
	if err := json.Unmarshal(runtime.Envelope, &unit); err != nil {
		return false
	}
	unit.Attempt = row.Attempt + 1
	unit.CID = ""
	unit.State = contract.UnitQueued
	_ = s.repository.AppendUnitEvent(ctx, &repository.GalaxyUnitEvent{
		BizLine: bizLine, UnitID: unit.ID, Kind: "requeued",
		Message:  "执行中断，已重新排队",
		DataJSON: encodeJSON(map[string]any{"previousCid": runtime.CID, "attempt": unit.Attempt}),
	})
	if _, err := s.Submit(ctx, unit); err != nil {
		return false
	}
	return true
}
