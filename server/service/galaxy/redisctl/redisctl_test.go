package redisctl

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"

	"contract"
	"service/galaxy"
)

// 放置与结算的 Lua 是整套设计里唯一必须原子的一段：座位、并发、三维额度、入队
// 四件事之间插进任何一个别的请求，都会出现「超卖座位」或「额度已经超了但单元已入队」。
// 这些用例把那几条边界钉死。

func newTestPlane(t *testing.T) (*ControlPlane, *miniredis.Miniredis) {
	t.Helper()
	server := miniredis.RunT(t)
	plane := New(Options{Addresses: server.Addr(), Namespace: "gx"})
	if plane == nil {
		t.Fatal("控制面未初始化")
	}
	t.Cleanup(func() { _ = plane.Close() })
	return plane, server
}

func TestHeartbeatDoesNotClearUpstreamThrottle(t *testing.T) {
	plane, server := newTestPlane(t)
	ctx := context.Background()
	until := time.Now().Add(5 * time.Minute)
	for _, deadline := range []time.Time{until, {}, until.Add(-time.Minute)} {
		if err := plane.UpdateLaneRuntime(ctx, []galaxy.LaneRuntime{{CID: "c1", UpstreamOK: true, ThrottledUntil: deadline}}); err != nil {
			t.Fatal(err)
		}
		if got := server.HGet(plane.contribKey("c1"), "throttledUntil"); got != fmt.Sprint(until.UnixMilli()) {
			t.Fatalf("heartbeat shortened cooldown: %s", got)
		}
	}
}

func seedContribution(t *testing.T, plane *ControlPlane, cid string, seats, seatConc int, limits contract.Metering) galaxy.ContributionSnapshot {
	t.Helper()
	snapshot := galaxy.ContributionSnapshot{
		CID: cid, NodeID: "n_1", OwnerUserID: "u_1",
		Kind: "llm.chat", KindVersion: 1, Provider: "claude_oauth",
		ModelsAllow: []string{"claude-sonnet-*"},
		Seats:       seats, SeatConcurrency: seatConc,
		QuotaLimit: limits, UpstreamOK: true, Reputation: 1, LastBeatAt: time.Now(),
	}
	ctx := context.Background()
	if err := plane.ReplaceContributions(ctx, "n_1", []galaxy.ContributionSnapshot{snapshot}); err != nil {
		t.Fatalf("写入贡献失败: %v", err)
	}
	if _, _, err := plane.SyncQuota(ctx, cid, limits, windowKeys(limits)); err != nil {
		t.Fatalf("同步额度失败: %v", err)
	}
	return snapshot
}

func windowKeys(limits contract.Metering) map[contract.MeterUnit]string {
	keys := map[contract.MeterUnit]string{}
	for unit := range limits {
		keys[unit] = "20260907"
	}
	return keys
}

func placeCommand(rid, cid, consumerKey string, limits, estimate contract.Metering, seats, seatConc int, reuse bool) galaxy.PlaceCommand {
	expiry := map[contract.MeterUnit]time.Duration{}
	for unit := range limits {
		expiry[unit] = 48 * time.Hour
	}
	return galaxy.PlaceCommand{
		RID: rid, CID: cid, ConsumerKey: consumerKey, Lane: "llm.chat|claude_oauth",
		Estimate: estimate, QuotaLimits: limits, WindowKeys: windowKeys(limits), WindowExpiry: expiry,
		Seats: seats, SeatConcurrency: seatConc, ReuseBinding: reuse,
		BindTTL: 30 * time.Minute, SeatTTL: 30 * time.Minute,
		Instance: "http://hub", Unit: []byte(`{"id":"` + rid + `","kind":"llm.chat","kindVersion":1,"provider":"claude_oauth","attempt":1}`),
		Body: []byte(`{"model":"claude-sonnet-4-5"}`), BodyTTL: time.Minute,
		Deadline: time.Now().Add(10 * time.Minute),
	}
}

func TestPlaceBindsSeatAndEnqueues(t *testing.T) {
	plane, _ := newTestPlane(t)
	ctx := context.Background()
	limits := contract.Metering{contract.UnitOutputTokens: 10_000}
	seedContribution(t, plane, "c1", 3, 2, limits)

	outcome, err := plane.Place(ctx, placeCommand("u_1", "c1", "ck_a", limits, contract.Metering{contract.UnitOutputTokens: 100}, 3, 2, false))
	if err != nil || !outcome.Placed {
		t.Fatalf("放置失败: %v %+v", err, outcome)
	}

	// 单元应该已经进了这条贡献的队列，节点下一次 next 就能领走。
	claimed, err := plane.Claim(ctx, galaxy.ClaimCommand{NodeID: "n_1", CIDs: []string{"c1"}, Wait: time.Second})
	if err != nil || claimed == nil {
		t.Fatalf("领活失败: %v %+v", err, claimed)
	}
	if claimed.RID != "u_1" || claimed.CID != "c1" {
		t.Fatalf("领到的单元不对: %+v", claimed)
	}
	if string(claimed.Body) != `{"model":"claude-sonnet-4-5"}` {
		t.Fatalf("请求体没跟着下发: %s", claimed.Body)
	}

	// 绑定建立了：同一个消费者下次直接回这条贡献（90% 路径）。
	cid, found, err := plane.LookupBinding(ctx, "ck_a", "llm.chat|claude_oauth")
	if err != nil || !found || cid != "c1" {
		t.Fatalf("绑定没建立: %v %v %s", err, found, cid)
	}

	snapshot, _, err := plane.GetContribution(ctx, "c1")
	if err != nil {
		t.Fatalf("读快照失败: %v", err)
	}
	if snapshot.Inflight != 1 || snapshot.SeatsUsed != 1 {
		t.Fatalf("并发与座位没记上: inflight=%d seats=%d", snapshot.Inflight, snapshot.SeatsUsed)
	}
	// 预留已经从余量里扣掉，别的请求看到的就是扣过的数。
	if left := snapshot.QuotaLeft()[contract.UnitOutputTokens]; left != 9_900 {
		t.Fatalf("预留没有反映到余量: %d", left)
	}
}

func TestPlaceRejectsWhenSeatsFull(t *testing.T) {
	plane, _ := newTestPlane(t)
	ctx := context.Background()
	limits := contract.Metering{contract.UnitOutputTokens: 100_000}
	seedContribution(t, plane, "c1", 2, 4, limits)

	estimate := contract.Metering{contract.UnitOutputTokens: 10}
	for index, key := range []string{"ck_a", "ck_b"} {
		outcome, err := plane.Place(ctx, placeCommand("u_"+key, "c1", key, limits, estimate, 2, 4, false))
		if err != nil || !outcome.Placed {
			t.Fatalf("第 %d 个消费者应能占到座位: %v %+v", index+1, err, outcome)
		}
	}
	// 第三个消费者没座位了 —— 座位是「同时服务几个人」，不是并发数。
	outcome, err := plane.Place(ctx, placeCommand("u_c", "c1", "ck_c", limits, estimate, 2, 4, false))
	if err != nil {
		t.Fatalf("放置出错: %v", err)
	}
	if outcome.Placed || outcome.Reason != galaxy.PlaceSeatsFull {
		t.Fatalf("座位满时应被拒: %+v", outcome)
	}
	// 已经占着座位的消费者还能继续发请求。
	again, err := plane.Place(ctx, placeCommand("u_a2", "c1", "ck_a", limits, estimate, 2, 4, true))
	if err != nil || !again.Placed {
		t.Fatalf("已绑定的消费者应能继续: %v %+v", err, again)
	}
}

func TestPlaceRejectsWhenConcurrencyFull(t *testing.T) {
	plane, _ := newTestPlane(t)
	ctx := context.Background()
	limits := contract.Metering{contract.UnitOutputTokens: 100_000}
	seedContribution(t, plane, "c1", 1, 2, limits)

	estimate := contract.Metering{contract.UnitOutputTokens: 10}
	for i := 0; i < 2; i++ {
		outcome, err := plane.Place(ctx, placeCommand("u_"+string(rune('a'+i)), "c1", "ck_a", limits, estimate, 1, 2, i > 0))
		if err != nil || !outcome.Placed {
			t.Fatalf("前两条应放行: %v %+v", err, outcome)
		}
	}
	outcome, err := plane.Place(ctx, placeCommand("u_c", "c1", "ck_a", limits, estimate, 1, 2, true))
	if err != nil {
		t.Fatalf("放置出错: %v", err)
	}
	if outcome.Placed || outcome.Reason != galaxy.PlaceConcurrencyFull {
		t.Fatalf("并发满时应被拒: %+v", outcome)
	}
}

func TestPlaceRollsBackAllReservationsWhenOneUnitExceeds(t *testing.T) {
	plane, _ := newTestPlane(t)
	ctx := context.Background()
	// 三维同时生效：output 还很宽裕，但 calls 只剩 1 次。
	limits := contract.Metering{contract.UnitOutputTokens: 100_000, contract.UnitCalls: 1}
	seedContribution(t, plane, "c1", 3, 2, limits)

	estimate := contract.Metering{contract.UnitOutputTokens: 100, contract.UnitCalls: 1}
	if outcome, err := plane.Place(ctx, placeCommand("u_1", "c1", "ck_a", limits, estimate, 3, 2, false)); err != nil || !outcome.Placed {
		t.Fatalf("第一条应放行: %v %+v", err, outcome)
	}
	outcome, err := plane.Place(ctx, placeCommand("u_2", "c1", "ck_b", limits, estimate, 3, 2, false))
	if err != nil {
		t.Fatalf("放置出错: %v", err)
	}
	if outcome.Placed || outcome.Reason != galaxy.PlaceQuotaExceeded || outcome.Unit != contract.UnitCalls {
		t.Fatalf("次数维度触顶应被拒并指出是哪一维: %+v", outcome)
	}

	// 关键：被拒的那次不能留下任何痕迹 —— output 的预留必须整体回滚，
	// 并发计数也要还回去，否则连续几次被拒就能把一条好通道拖死。
	snapshot, _, err := plane.GetContribution(ctx, "c1")
	if err != nil {
		t.Fatalf("读快照失败: %v", err)
	}
	if snapshot.Inflight != 1 {
		t.Fatalf("被拒的请求不该留下并发计数: %d", snapshot.Inflight)
	}
	if left := snapshot.QuotaLeft()[contract.UnitOutputTokens]; left != 99_900 {
		t.Fatalf("被拒的请求不该留下预留: %d", left)
	}
}

func TestSettleReturnsReservationAndRecordsActual(t *testing.T) {
	plane, _ := newTestPlane(t)
	ctx := context.Background()
	limits := contract.Metering{contract.UnitOutputTokens: 10_000}
	seedContribution(t, plane, "c1", 3, 2, limits)

	estimate := contract.Metering{contract.UnitOutputTokens: 1_000}
	if outcome, err := plane.Place(ctx, placeCommand("u_1", "c1", "ck_a", limits, estimate, 3, 2, false)); err != nil || !outcome.Placed {
		t.Fatalf("放置失败: %v %+v", err, outcome)
	}

	// 实际只用了 120：预留的 1000 全额回滚，再按实际扣 120。
	actual := contract.Metering{contract.UnitOutputTokens: 120}
	if err := plane.Settle(ctx, galaxy.SettleCommand{
		RID: "u_1", CID: "c1", ConsumerKey: "ck_a", Estimate: estimate, Actual: actual,
		WindowKeys: windowKeys(limits), Lane: "llm.chat|claude_oauth", State: contract.UnitCompleted,
	}); err != nil {
		t.Fatalf("结算失败: %v", err)
	}

	snapshot, _, err := plane.GetContribution(ctx, "c1")
	if err != nil {
		t.Fatalf("读快照失败: %v", err)
	}
	if snapshot.Inflight != 0 {
		t.Fatalf("结算后应释放并发: %d", snapshot.Inflight)
	}
	if used := snapshot.QuotaUsed[contract.UnitOutputTokens]; used != 120 {
		t.Fatalf("实际用量没入账: %d", used)
	}
	if left := snapshot.QuotaLeft()[contract.UnitOutputTokens]; left != 9_880 {
		t.Fatalf("余量应为上限减实际用量: %d", left)
	}
	// 座位是粘性绑定，结算不释放：同一个人下次还回这台机器，prompt cache 才有意义。
	if snapshot.SeatsUsed != 1 {
		t.Fatalf("结算不该释放座位: %d", snapshot.SeatsUsed)
	}
}

func TestSettleIsIdempotent(t *testing.T) {
	plane, _ := newTestPlane(t)
	ctx := context.Background()
	limits := contract.Metering{contract.UnitOutputTokens: 10_000}
	seedContribution(t, plane, "c1", 3, 2, limits)

	estimate := contract.Metering{contract.UnitOutputTokens: 500}
	actual := contract.Metering{contract.UnitOutputTokens: 200}
	if _, err := plane.Place(ctx, placeCommand("u_1", "c1", "ck_a", limits, estimate, 3, 2, false)); err != nil {
		t.Fatalf("放置失败: %v", err)
	}
	command := galaxy.SettleCommand{
		RID: "u_1", CID: "c1", ConsumerKey: "ck_a", Estimate: estimate, Actual: actual,
		WindowKeys: windowKeys(limits), Lane: "llm.chat|claude_oauth", State: contract.UnitCompleted,
	}
	for i := 0; i < 3; i++ {
		if err := plane.Settle(ctx, command); err != nil {
			t.Fatalf("第 %d 次结算失败: %v", i+1, err)
		}
	}
	snapshot, _, _ := plane.GetContribution(ctx, "c1")
	// 重放不能把用量记三遍，也不能把并发扣成负数。
	if used := snapshot.QuotaUsed[contract.UnitOutputTokens]; used != 200 {
		t.Fatalf("结算不幂等，用量被重复记入: %d", used)
	}
	if snapshot.Inflight != 0 {
		t.Fatalf("并发计数被重复扣减: %d", snapshot.Inflight)
	}
}

func TestSettleReleasesSeatWhenAsked(t *testing.T) {
	plane, _ := newTestPlane(t)
	ctx := context.Background()
	limits := contract.Metering{contract.UnitOutputTokens: 10_000}
	seedContribution(t, plane, "c1", 3, 2, limits)
	estimate := contract.Metering{contract.UnitOutputTokens: 100}
	if _, err := plane.Place(ctx, placeCommand("u_1", "c1", "ck_a", limits, estimate, 3, 2, false)); err != nil {
		t.Fatalf("放置失败: %v", err)
	}
	if err := plane.Settle(ctx, galaxy.SettleCommand{
		RID: "u_1", CID: "c1", ConsumerKey: "ck_a", Estimate: estimate, Actual: contract.Metering{},
		WindowKeys: windowKeys(limits), Lane: "llm.chat|claude_oauth", State: contract.UnitFailed, ReleaseSeat: true,
	}); err != nil {
		t.Fatalf("结算失败: %v", err)
	}
	snapshot, _, _ := plane.GetContribution(ctx, "c1")
	if snapshot.SeatsUsed != 0 {
		t.Fatalf("要求释放座位时应摘掉绑定: %d", snapshot.SeatsUsed)
	}
	if _, found, _ := plane.LookupBinding(ctx, "ck_a", "llm.chat|claude_oauth"); found {
		t.Fatal("绑定应一并删除")
	}
}

func TestWindowRolloverRestoresQuota(t *testing.T) {
	plane, _ := newTestPlane(t)
	ctx := context.Background()
	limits := contract.Metering{contract.UnitOutputTokens: 1_000}
	seedContribution(t, plane, "c1", 3, 2, limits)

	estimate := contract.Metering{contract.UnitOutputTokens: 900}
	if _, err := plane.Place(ctx, placeCommand("u_1", "c1", "ck_a", limits, estimate, 3, 2, false)); err != nil {
		t.Fatalf("放置失败: %v", err)
	}
	_ = plane.Settle(ctx, galaxy.SettleCommand{
		RID: "u_1", CID: "c1", ConsumerKey: "ck_a", Estimate: estimate,
		Actual:     contract.Metering{contract.UnitOutputTokens: 900},
		WindowKeys: windowKeys(limits), Lane: "llm.chat|claude_oauth", State: contract.UnitCompleted,
	})
	before, _, _ := plane.GetContribution(ctx, "c1")
	if before.QuotaLeft()[contract.UnitOutputTokens] != 100 {
		t.Fatalf("窗口内余量应被扣掉: %d", before.QuotaLeft()[contract.UnitOutputTokens])
	}

	// 翻到新窗口：计数器换了一把新的，余量自然回到上限，不需要任何清理动作。
	if _, _, err := plane.SyncQuota(ctx, "c1", limits, map[contract.MeterUnit]string{contract.UnitOutputTokens: "20260908"}); err != nil {
		t.Fatalf("同步新窗口失败: %v", err)
	}
	after, _, _ := plane.GetContribution(ctx, "c1")
	if after.QuotaLeft()[contract.UnitOutputTokens] != 1_000 {
		t.Fatalf("窗口翻转后余量应回到上限: %d", after.QuotaLeft()[contract.UnitOutputTokens])
	}
}

func TestCancelFansOutToOwningNode(t *testing.T) {
	plane, _ := newTestPlane(t)
	ctx := context.Background()
	limits := contract.Metering{contract.UnitOutputTokens: 10_000}
	seedContribution(t, plane, "c1", 3, 2, limits)
	if _, err := plane.Place(ctx, placeCommand("u_1", "c1", "ck_a", limits, contract.Metering{contract.UnitOutputTokens: 10}, 3, 2, false)); err != nil {
		t.Fatalf("放置失败: %v", err)
	}
	if err := plane.RequestCancel(ctx, "u_1", "consumer_disconnected"); err != nil {
		t.Fatalf("取消失败: %v", err)
	}
	if requested, _ := plane.CancelRequested(ctx, "u_1"); !requested {
		t.Fatal("取消标志没写上")
	}
	// 取消搭在节点已有的心跳与长轮询上，不另开一路轮询（T-05）。
	cancels, err := plane.TakeNodeCancels(ctx, "n_1")
	if err != nil || len(cancels) != 1 || cancels[0] != "u_1" {
		t.Fatalf("取消没有派发到持有该单元的节点: %v %v", err, cancels)
	}
	// 取走即清空，不会重复下发。
	if again, _ := plane.TakeNodeCancels(ctx, "n_1"); len(again) != 0 {
		t.Fatalf("取消列表应被取走清空: %v", again)
	}
}

func TestReplaceContributionsRemovesUndeclaredLanes(t *testing.T) {
	plane, _ := newTestPlane(t)
	ctx := context.Background()
	limits := contract.Metering{contract.UnitOutputTokens: 1_000}
	first := galaxy.ContributionSnapshot{
		CID: "c1", NodeID: "n_1", Kind: "llm.chat", KindVersion: 1, Provider: "claude_oauth",
		Seats: 3, SeatConcurrency: 2, QuotaLimit: limits, UpstreamOK: true, LastBeatAt: time.Now(),
	}
	second := first
	second.CID = "c2"
	if err := plane.ReplaceContributions(ctx, "n_1", []galaxy.ContributionSnapshot{first, second}); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	if snapshots, _ := plane.ListLaneContributions(ctx, "llm.chat|claude_oauth"); len(snapshots) != 2 {
		t.Fatalf("应有两条贡献: %d", len(snapshots))
	}
	// 主人把 c2 关了：下一次 hello 是全量替换，Hub 立刻看不到它。
	if err := plane.ReplaceContributions(ctx, "n_1", []galaxy.ContributionSnapshot{first}); err != nil {
		t.Fatalf("替换失败: %v", err)
	}
	snapshots, _ := plane.ListLaneContributions(ctx, "llm.chat|claude_oauth")
	if len(snapshots) != 1 || snapshots[0].CID != "c1" {
		t.Fatalf("未申报的贡献应从候选里消失: %+v", snapshots)
	}
}

func TestResponseAffinityIsRemembered(t *testing.T) {
	plane, _ := newTestPlane(t)
	ctx := context.Background()
	if err := plane.RememberResponse(ctx, "resp_abc", "c1", time.Hour); err != nil {
		t.Fatalf("记录失败: %v", err)
	}
	cid, found, err := plane.LookupResponse(ctx, "resp_abc")
	if err != nil || !found || cid != "c1" {
		t.Fatalf("previous_response_id 应能查回原贡献: %v %v %s", err, found, cid)
	}
	if _, found, _ := plane.LookupResponse(ctx, "resp_missing"); found {
		t.Fatal("没记过的 id 不该查到")
	}
}
