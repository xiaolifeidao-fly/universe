package galaxy

import (
	"testing"
	"time"

	"contract"
)

func relaySpec() contract.KindSpec {
	spec := contract.KindSpec{Kind: "llm.chat", Version: 1, Primitive: contract.PrimitiveRelay, Providers: []string{"claude_oauth"}}
	spec.Metering.Units = []contract.MeterUnit{contract.UnitOutputTokens, contract.UnitCalls, contract.UnitTimeSeconds}
	spec.Placement.Affinity = contract.AffinitySoft
	return spec
}

func healthy(cid string, now time.Time) ContributionSnapshot {
	return ContributionSnapshot{
		CID: cid, NodeID: "n_1", Kind: "llm.chat", KindVersion: 1, Provider: "claude_oauth",
		ModelsAllow: []string{"claude-sonnet-*"}, ModelsDeny: []string{"claude-opus-*"},
		Seats: 3, SeatConcurrency: 2, UpstreamOK: true, Reputation: 1, LastBeatAt: now,
		QuotaLimit:    contract.Metering{contract.UnitOutputTokens: 100_000},
		QuotaUsed:     contract.Metering{},
		QuotaReserved: contract.Metering{},
	}
}

func filterInput(now time.Time, snapshots []ContributionSnapshot) FilterInput {
	plans := map[string]QuotaPlan{}
	for _, snapshot := range snapshots {
		plans[snapshot.CID] = BuildQuotaPlan([]QuotaGrant{
			{Unit: contract.UnitOutputTokens, Limit: 100_000, Window: WindowDay},
		}, now)
	}
	return FilterInput{
		Route:    contract.RouteKey{Kind: "llm.chat", KindVersion: 1, Provider: "claude_oauth", Model: "claude-sonnet-4-5"},
		Spec:     relaySpec(),
		Estimate: contract.Metering{contract.UnitOutputTokens: 4096},
		Plans:    plans, Now: now, HeartbeatTimeout: 45 * time.Second, Weights: DefaultScoreWeights(),
	}
}

func TestFilterRejectsDeniedModel(t *testing.T) {
	now := mustTime(t, "2026-09-07T12:00:00Z")
	snapshot := healthy("c1", now)
	in := filterInput(now, []ContributionSnapshot{snapshot})
	in.Route.Model = "claude-opus-4-1"
	if candidates := Filter([]ContributionSnapshot{snapshot}, in); len(candidates) != 0 {
		t.Fatal("deny 列表命中的模型不该进入候选")
	}
}

func TestFilterRejectsOfflineAndThrottled(t *testing.T) {
	now := mustTime(t, "2026-09-07T12:00:00Z")

	stale := healthy("c1", now.Add(-90*time.Second))
	if candidates := Filter([]ContributionSnapshot{stale}, filterInput(now, []ContributionSnapshot{stale})); len(candidates) != 0 {
		t.Fatal("超过心跳阈值的贡献应被摘除")
	}

	throttled := healthy("c2", now)
	throttled.ThrottledUntil = now.Add(time.Minute)
	if candidates := Filter([]ContributionSnapshot{throttled}, filterInput(now, []ContributionSnapshot{throttled})); len(candidates) != 0 {
		t.Fatal("被上游限流的贡献应临时退出候选")
	}

	draining := healthy("c3", now)
	draining.Draining = true
	if candidates := Filter([]ContributionSnapshot{draining}, filterInput(now, []ContributionSnapshot{draining})); len(candidates) != 0 {
		t.Fatal("排空中的贡献不该接新单")
	}
}

func TestFilterRejectsFullConcurrency(t *testing.T) {
	now := mustTime(t, "2026-09-07T12:00:00Z")
	busy := healthy("c1", now)
	busy.Inflight = busy.Concurrency()
	if candidates := Filter([]ContributionSnapshot{busy}, filterInput(now, []ContributionSnapshot{busy})); len(candidates) != 0 {
		t.Fatal("并发已满的贡献不该被选中")
	}
}

func TestRankPrefersIdleAndThickQuota(t *testing.T) {
	// 固定时刻：有效座位数按「窗口已过多久 / 还剩多久」算，用 time.Now() 会让
	// 这个用例在午夜前后得出不同结论。
	now := mustTime(t, "2026-09-07T12:00:00Z")
	busy := healthy("busy", now)
	busy.Inflight = 4
	busy.SeatsUsed = 2
	busy.QuotaUsed = contract.Metering{contract.UnitOutputTokens: 30_000}

	idle := healthy("idle", now)

	snapshots := []ContributionSnapshot{busy, idle}
	in := filterInput(now, snapshots)
	ranked := Rank(Filter(snapshots, in), in)
	if len(ranked) != 2 {
		t.Fatalf("两个贡献都该通过硬过滤，实际 %d", len(ranked))
	}
	if ranked[0].Snapshot.CID != "idle" {
		t.Fatalf("空闲且余量厚的贡献应排在前面，实际 %s", ranked[0].Snapshot.CID)
	}
}

func TestRankBreaksTiesByOldestBinding(t *testing.T) {
	now := mustTime(t, "2026-09-07T12:00:00Z")
	recent := healthy("recent", now)
	recent.LastBoundAt = now
	old := healthy("old", now)
	old.LastBoundAt = now.Add(-time.Hour)

	snapshots := []ContributionSnapshot{recent, old}
	in := filterInput(now, snapshots)
	ranked := Rank(Filter(snapshots, in), in)
	if ranked[0].Snapshot.CID != "old" {
		t.Fatalf("完全平手时应把活分给最久没被绑过的机器，实际 %s", ranked[0].Snapshot.CID)
	}
}

// 烧得太快的贡献会被有效座位数挡在候选之外：主人配了 3 个座位，
// 但按当前速率余量撑不到窗口结束，再绑人只会让所有人半途断掉。
func TestFilterRejectsContributionBurningTooFast(t *testing.T) {
	now := mustTime(t, "2026-09-07T12:00:00Z")
	hot := healthy("hot", now)
	hot.QuotaUsed = contract.Metering{contract.UnitOutputTokens: 80_000}
	if candidates := Filter([]ContributionSnapshot{hot}, filterInput(now, []ContributionSnapshot{hot})); len(candidates) != 0 {
		t.Fatal("按当前消耗率撑不到窗口结束的贡献不该再接新绑定")
	}
}

func TestScoreWeightsPerPrimitive(t *testing.T) {
	weights := DefaultScoreWeights()
	if weights.ForPrimitive(contract.PrimitiveRelay).Locality != 0 {
		t.Fatal("relay 没有数据引力，w6 应为 0")
	}
	if weights.ForPrimitive(contract.PrimitiveJob).FreeSeats != 0 {
		t.Fatal("job 不认座位，w1 应为 0")
	}
}

func TestInScheduleHandlesOvernightWindow(t *testing.T) {
	windows := []ScheduleWindow{{From: "22:00", To: "08:00", TZ: "UTC"}}
	if !InSchedule(windows, mustTime(t, "2026-09-07T23:30:00Z")) {
		t.Fatal("跨零点时段的前半段应被接受")
	}
	if !InSchedule(windows, mustTime(t, "2026-09-07T02:00:00Z")) {
		t.Fatal("跨零点时段的后半段应被接受")
	}
	if InSchedule(windows, mustTime(t, "2026-09-07T12:00:00Z")) {
		t.Fatal("时段外不该接单")
	}
	if !InSchedule(nil, time.Now()) {
		t.Fatal("没配时段等于全天可接单")
	}
}

func TestFilterRespectsSchedule(t *testing.T) {
	now := mustTime(t, "2026-09-07T12:00:00Z")
	snapshot := healthy("c1", now)
	snapshot.Schedule = []ScheduleWindow{{From: "22:00", To: "08:00", TZ: "UTC"}}
	if candidates := Filter([]ContributionSnapshot{snapshot}, filterInput(now, []ContributionSnapshot{snapshot})); len(candidates) != 0 {
		t.Fatal("挂机时段之外的贡献不该进入候选")
	}
}

func TestModelMatchPatterns(t *testing.T) {
	if !contract.ModelMatch("claude-sonnet-4-5", []string{"claude-sonnet-*"}, nil) {
		t.Fatal("前缀通配应命中")
	}
	if contract.ModelMatch("claude-opus-4-1", []string{"claude-*"}, []string{"claude-opus-*"}) {
		t.Fatal("deny 优先于 allow")
	}
	if !contract.ModelMatch("anything", nil, nil) {
		t.Fatal("空 allow 表示不限")
	}
}
