package redisctl

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

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
	seedContribution(t, plane, "c1", 3, 2, contract.Metering{contract.UnitOutputTokens: 1000})
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

// 心跳报上来一条控制面里没有的通道时，什么都不该写。
//
// 从前这里是裸 HSET，于是每 15 秒就凭空造一个「只有 upstreamOK / paused / queued」的
// 贡献壳：没有 kind 也没有 provider，选不上却一直占着车道，而且下一次心跳又造一个。
// 贡献要回到控制面里只有一条路 —— hello 的全量替换。
func TestHeartbeatDoesNotResurrectUnknownContribution(t *testing.T) {
	plane, server := newTestPlane(t)
	ctx := context.Background()
	until := time.Now().Add(5 * time.Minute)
	if err := plane.UpdateLaneRuntime(ctx, []galaxy.LaneRuntime{
		{CID: "c_ghost", UpstreamOK: true, ThrottledUntil: until},
	}); err != nil {
		t.Fatal(err)
	}
	if server.Exists(plane.contribKey("c_ghost")) {
		t.Fatal("心跳给一个不在控制面里的通道建出了壳")
	}
}

// 同理，续期不等于复活：哈希已经过期的贡献，心跳不该把它写回来。
func TestTouchNodeDoesNotResurrectExpiredContribution(t *testing.T) {
	plane, server := newTestPlane(t)
	ctx := context.Background()
	registerTestNode(t, plane, "n_1")
	seedContribution(t, plane, "c1", 3, 2, contract.Metering{contract.UnitOutputTokens: 1000})
	// 心跳超时：贡献哈希没了，但 node:<id>:contribs 还在（它是 24h TTL）。
	server.Del(plane.contribKey("c1"))

	registered, err := plane.TouchNode(ctx, "n_1", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !registered {
		t.Fatal("节点登记项还在，TouchNode 却说它不在")
	}
	if server.Exists(plane.contribKey("c1")) {
		t.Fatal("续期把一条已经过期的贡献复活成了空壳")
	}
	if !server.Exists(plane.nodeKey("n_1")) {
		t.Fatal("节点自己的登记项不该被牵连")
	}
}

// 节点登记项自己过期时（连着 24 小时只有心跳没有 hello），心跳同样不能把它写回来。
//
// 心跳手上只有 lastBeat 和 status，裸 HSET 重建出来的登记项缺 instance、
// ownerUserId、bridgeVersion、resources —— 一条哪儿都对不上的记录比没有更难查。
// 这里只负责如实报告「它不在了」，重建交给上层拿数据库的行来做。
func TestTouchNodeReportsMissingRegistration(t *testing.T) {
	plane, server := newTestPlane(t)
	ctx := context.Background()

	registered, err := plane.TouchNode(ctx, "n_ghost", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if registered {
		t.Fatal("节点根本没登记过，TouchNode 却说它还在")
	}
	if server.Exists(plane.nodeKey("n_ghost")) {
		t.Fatal("心跳凭空建出了一条残缺的节点登记项")
	}
}

// 心跳把机器信誉写进快照：派单打分读的就是这里。已经过期的贡献不能被这一步写回来。
func TestSetReputationPatchesOnlyLiveContributions(t *testing.T) {
	plane, server := newTestPlane(t)
	ctx := context.Background()
	seedContribution(t, plane, "c1", 3, 2, contract.Metering{contract.UnitOutputTokens: 1000})
	if err := plane.SetReputation(ctx, []string{"c1", "c_expired"}, 0.35); err != nil {
		t.Fatal(err)
	}
	snapshot, found, err := plane.GetContribution(ctx, "c1")
	if err != nil || !found {
		t.Fatalf("读快照: found=%v err=%v", found, err)
	}
	if snapshot.Reputation != 0.35 {
		t.Fatalf("派单读到的信誉应是 0.35，实际 %v", snapshot.Reputation)
	}
	if server.Exists(plane.contribKey("c_expired")) {
		t.Fatal("写信誉给一条不在控制面里的贡献建出了空壳")
	}
}

func registerTestNode(t *testing.T, plane *ControlPlane, nodeID string) {
	t.Helper()
	if err := plane.RegisterNode(context.Background(), galaxy.NodeRuntime{
		NodeID: nodeID, OwnerUserID: "u_1", BridgeVersion: "0.1.0", Contract: 1,
		Instance: "http://127.0.0.1:10004", LastBeatAt: time.Now(),
	}); err != nil {
		t.Fatalf("登记节点失败: %v", err)
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

func placeCommand(rid, cid, consumerKey string, limits, estimate contract.Metering, seats, seatConc int) galaxy.PlaceCommand {
	expiry := map[contract.MeterUnit]time.Duration{}
	for unit := range limits {
		expiry[unit] = 48 * time.Hour
	}
	return galaxy.PlaceCommand{
		RID: rid, CID: cid, ConsumerKey: consumerKey, Lane: "llm.chat|claude_oauth",
		Estimate: estimate, QuotaLimits: limits, WindowKeys: windowKeys(limits), WindowExpiry: expiry,
		Seats: seats, SeatConcurrency: seatConc,
		BindTTL: 30 * time.Minute, SeatTTL: time.Minute,
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

	outcome, err := plane.Place(ctx, placeCommand("u_1", "c1", "ck_a", limits, contract.Metering{contract.UnitOutputTokens: 100}, 3, 2))
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

	// req 哈希里那几项都要对得上号。放置脚本的参数是位置参数，错一位不会报错，
	// 只会让上行回不到正确的 Hub 实例、或者租约按一个荒唐的截止时刻判超时。
	runtime, found, err := plane.LoadUnit(ctx, "u_1")
	if err != nil || !found {
		t.Fatalf("读单元失败: %v %v", err, found)
	}
	if runtime.Instance != "http://hub" || runtime.CID != "c1" || runtime.ConsumerKey != "ck_a" {
		t.Fatalf("单元的归属信息串位了: %+v", runtime)
	}
	if runtime.Kind != "llm.chat" || runtime.Estimate[contract.UnitOutputTokens] != 100 {
		t.Fatalf("信封或预估串位了: kind=%s estimate=%v", runtime.Kind, runtime.Estimate)
	}
	if runtime.Deadline.Before(time.Now().Add(9*time.Minute)) || runtime.Deadline.After(time.Now().Add(11*time.Minute)) {
		t.Fatalf("截止时刻串位了: %s", runtime.Deadline)
	}
}

func TestPlaceRejectsWhenSeatsFull(t *testing.T) {
	plane, _ := newTestPlane(t)
	ctx := context.Background()
	limits := contract.Metering{contract.UnitOutputTokens: 100_000}
	seedContribution(t, plane, "c1", 2, 4, limits)

	estimate := contract.Metering{contract.UnitOutputTokens: 10}
	for index, key := range []string{"ck_a", "ck_b"} {
		outcome, err := plane.Place(ctx, placeCommand("u_"+key, "c1", key, limits, estimate, 2, 4))
		if err != nil || !outcome.Placed {
			t.Fatalf("第 %d 个消费者应能占到座位: %v %+v", index+1, err, outcome)
		}
	}
	// 第三个消费者没座位了 —— 座位是「同时服务几个人」，不是并发数。
	outcome, err := plane.Place(ctx, placeCommand("u_c", "c1", "ck_c", limits, estimate, 2, 4))
	if err != nil {
		t.Fatalf("放置出错: %v", err)
	}
	if outcome.Placed || outcome.Reason != galaxy.PlaceSeatsFull {
		t.Fatalf("座位满时应被拒: %+v", outcome)
	}
	// 已经占着座位的消费者还能继续发请求。
	again, err := plane.Place(ctx, placeCommand("u_a2", "c1", "ck_a", limits, estimate, 2, 4))
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
		outcome, err := plane.Place(ctx, placeCommand("u_"+string(rune('a'+i)), "c1", "ck_a", limits, estimate, 1, 2))
		if err != nil || !outcome.Placed {
			t.Fatalf("前两条应放行: %v %+v", err, outcome)
		}
	}
	outcome, err := plane.Place(ctx, placeCommand("u_c", "c1", "ck_a", limits, estimate, 1, 2))
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
	if outcome, err := plane.Place(ctx, placeCommand("u_1", "c1", "ck_a", limits, estimate, 3, 2)); err != nil || !outcome.Placed {
		t.Fatalf("第一条应放行: %v %+v", err, outcome)
	}
	outcome, err := plane.Place(ctx, placeCommand("u_2", "c1", "ck_b", limits, estimate, 3, 2))
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
	if outcome, err := plane.Place(ctx, placeCommand("u_1", "c1", "ck_a", limits, estimate, 3, 2)); err != nil || !outcome.Placed {
		t.Fatalf("放置失败: %v %+v", err, outcome)
	}

	// 实际只用了 120：预留的 1000 全额回滚，再按实际扣 120。
	actual := contract.Metering{contract.UnitOutputTokens: 120}
	if _, err := plane.Settle(ctx, galaxy.SettleCommand{
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
	if _, err := plane.Place(ctx, placeCommand("u_1", "c1", "ck_a", limits, estimate, 3, 2)); err != nil {
		t.Fatalf("放置失败: %v", err)
	}
	command := galaxy.SettleCommand{
		RID: "u_1", CID: "c1", ConsumerKey: "ck_a", Estimate: estimate, Actual: actual,
		WindowKeys: windowKeys(limits), Lane: "llm.chat|claude_oauth", State: contract.UnitCompleted,
	}
	// 返回值是「这次真的结了没有」：第一次为真，之后必须为假。
	// 调用方靠它决定要不要走计费 —— 丢了这个布尔值，一次重发的 complete
	// 就会让提供者被重复入账（账本按 txn 幂等，余额是加减）。
	for i := 0; i < 3; i++ {
		settled, err := plane.Settle(ctx, command)
		if err != nil {
			t.Fatalf("第 %d 次结算失败: %v", i+1, err)
		}
		if want := i == 0; settled != want {
			t.Fatalf("第 %d 次结算应当返回 %v，实际 %v", i+1, want, settled)
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
	if _, err := plane.Place(ctx, placeCommand("u_1", "c1", "ck_a", limits, estimate, 3, 2)); err != nil {
		t.Fatalf("放置失败: %v", err)
	}
	if _, err := plane.Settle(ctx, galaxy.SettleCommand{
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
	if _, err := plane.Place(ctx, placeCommand("u_1", "c1", "ck_a", limits, estimate, 3, 2)); err != nil {
		t.Fatalf("放置失败: %v", err)
	}
	_, _ = plane.Settle(ctx, galaxy.SettleCommand{
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
	if _, err := plane.Place(ctx, placeCommand("u_1", "c1", "ck_a", limits, contract.Metering{contract.UnitOutputTokens: 10}, 3, 2)); err != nil {
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

// SetDraining 撞上一个不在控制面里的 cid 时必须什么都不做。
//
// 从前它是一句裸 HSET，会凭空建出「只有 draining 一个字段」的贡献壳：没有 kind、
// 没有 provider、没有 TTL。控制台改额度时读到这个壳会认为贡献存在，把它写进
// lane "|"，于是那条贡献在正经车道里永远排不上，消费者一路 no_capacity。
func TestSetDrainingSkipsUnknownContribution(t *testing.T) {
	plane, server := newTestPlane(t)
	ctx := context.Background()

	if err := plane.SetDraining(ctx, "c_ghost", true); err != nil {
		t.Fatalf("对未知贡献置排空报错: %v", err)
	}
	if server.Exists(plane.contribKey("c_ghost")) {
		t.Fatal("SetDraining 给一个不存在的贡献建出了壳")
	}

	seedContribution(t, plane, "c1", 3, 2, contract.Metering{contract.UnitOutputTokens: 1000})
	for _, draining := range []bool{true, false} {
		if err := plane.SetDraining(ctx, "c1", draining); err != nil {
			t.Fatalf("置排空失败: %v", err)
		}
		if got, want := server.HGet(plane.contribKey("c1"), "draining"), fmt.Sprint(boolToInt(draining)); got != want {
			t.Fatalf("draining = %s, 期望 %s", got, want)
		}
	}
}

// 放置读一条 lane 的时候，顺手把哈希已经不在的死成员从集合里摘掉。
//
// lane 集合没有 TTL，正规的两条 SREM 路径又都要先从 contrib 哈希读 lane 字段
// 才知道该动哪条，而那个哈希 45 秒就过期 —— 节点掉线久一点再撤销，成员就会
// 永远留在集合里。线上攒了三个这样的死 cid，每次放置都要为它们多发一次 HGETALL。
func TestListLaneContributionsEvictsDeadMembers(t *testing.T) {
	plane, server := newTestPlane(t)
	ctx := context.Background()
	live := seedContribution(t, plane, "c_live", 3, 2, contract.Metering{contract.UnitOutputTokens: 1000})
	lane := live.Lane()

	// 死成员：只在 lane 集合里留了名字，哈希早就没了。
	server.SAdd(plane.laneKey(lane), "c_dead")

	snapshots, err := plane.ListLaneContributions(ctx, lane)
	if err != nil {
		t.Fatalf("读车道失败: %v", err)
	}
	if len(snapshots) != 1 || snapshots[0].CID != "c_live" {
		t.Fatalf("快照 = %+v，期望只剩 c_live", snapshots)
	}
	members, err := server.Members(plane.laneKey(lane))
	if err != nil {
		t.Fatal(err)
	}
	if len(members) != 1 || members[0] != "c_live" {
		t.Fatalf("死成员没被摘掉，集合里还是 %v", members)
	}
}

// 座位的空闲窗口算的是「最后一次活动**结束**之后闲了多久」。窗口一旦短过单次请求的
// 耗时（默认 1 分钟，而 llm.chat 一条能跑 10 分钟），按放置时刻起算就会让座位在流还
// 没推完时过期：主人看到的是「没人在用」，别的消费者还能挤进来超出他设定的座位数。
// 下面四个用例把这条时间线钉死。

func seatScore(t *testing.T, plane *ControlPlane, cid, consumerKey string) int64 {
	t.Helper()
	score, err := plane.client.ZScore(context.Background(), plane.seatsKey(cid), consumerKey).Result()
	if err != nil {
		t.Fatalf("读座位到期时刻失败: %v", err)
	}
	return int64(score)
}

func placeWithSeatTTL(rid, cid, consumerKey string, limits, estimate contract.Metering, seatTTL time.Duration, deadline time.Time) galaxy.PlaceCommand {
	command := placeCommand(rid, cid, consumerKey, limits, estimate, 3, 2)
	command.BindTTL, command.SeatTTL, command.Deadline = 30*time.Minute, seatTTL, deadline
	return command
}

func TestPlaceHoldsSeatUntilDeadline(t *testing.T) {
	plane, _ := newTestPlane(t)
	ctx := context.Background()
	limits := contract.Metering{contract.UnitOutputTokens: 10_000}
	seedContribution(t, plane, "c1", 3, 2, limits)

	estimate := contract.Metering{contract.UnitOutputTokens: 100}
	deadline := time.Now().Add(10 * time.Minute)
	if _, err := plane.Place(ctx, placeWithSeatTTL("u_1", "c1", "ck_a", limits, estimate, time.Minute, deadline)); err != nil {
		t.Fatalf("放置失败: %v", err)
	}

	if score := seatScore(t, plane, "c1", "ck_a"); score < deadline.UnixMilli() {
		t.Fatalf("座位在请求跑完之前就过期了: 到期 %d，请求截止 %d", score, deadline.UnixMilli())
	}
	// 绑定跟着一起撑长。两者错开会出现「座位还在、绑定没了」，下一回合改派别的机器。
	ttl, err := plane.client.PTTL(ctx, plane.bindKey("ck_a", "llm.chat|claude_oauth")).Result()
	if err != nil {
		t.Fatalf("读绑定 TTL 失败: %v", err)
	}
	if ttl <= time.Minute {
		t.Fatalf("绑定没跟着请求截止时刻一起撑长: %v", ttl)
	}
}

func TestSettleShortensSeatToIdleWindow(t *testing.T) {
	plane, _ := newTestPlane(t)
	ctx := context.Background()
	limits := contract.Metering{contract.UnitOutputTokens: 10_000}
	seedContribution(t, plane, "c1", 3, 2, limits)

	estimate := contract.Metering{contract.UnitOutputTokens: 100}
	deadline := time.Now().Add(10 * time.Minute)
	if _, err := plane.Place(ctx, placeWithSeatTTL("u_1", "c1", "ck_a", limits, estimate, time.Minute, deadline)); err != nil {
		t.Fatalf("放置失败: %v", err)
	}
	if _, err := plane.Settle(ctx, galaxy.SettleCommand{
		RID: "u_1", CID: "c1", ConsumerKey: "ck_a", Estimate: estimate, Actual: estimate,
		WindowKeys: windowKeys(limits), Lane: "llm.chat|claude_oauth",
		SeatTTL: time.Minute, BindTTL: 30 * time.Minute, State: contract.UnitCompleted,
	}); err != nil {
		t.Fatalf("结算失败: %v", err)
	}

	// 收回来了：到期时刻落在「现在 + 1 分钟」附近，而不是请求的截止时刻。
	score := seatScore(t, plane, "c1", "ck_a")
	want := time.Now().Add(time.Minute).UnixMilli()
	if score > want+5_000 || score < want-5_000 {
		t.Fatalf("结算后座位没收回到空闲窗口: 到期 %d，期望 %d 附近", score, want)
	}
	// 但此刻还没到点，牌子仍然显示绑着 —— 粘性绑定本来就要留这一分钟。
	if snapshot, _, _ := plane.GetContribution(ctx, "c1"); snapshot.SeatsUsed != 1 {
		t.Fatalf("空闲窗口内座位不该消失: %d", snapshot.SeatsUsed)
	}
	// 绑定不跟着收 —— 它是「上次落在哪台」的偏好，走自己那条更长的时间线，
	// 由 TestBindOutlivesSeat 守。
}

func TestSettleKeepsSeatWhileSiblingStillRunning(t *testing.T) {
	plane, _ := newTestPlane(t)
	ctx := context.Background()
	limits := contract.Metering{contract.UnitOutputTokens: 10_000}
	seedContribution(t, plane, "c1", 3, 2, limits)

	estimate := contract.Metering{contract.UnitOutputTokens: 100}
	deadline := time.Now().Add(10 * time.Minute)
	for _, rid := range []string{"u_1", "u_2"} {
		if _, err := plane.Place(ctx, placeWithSeatTTL(rid, "c1", "ck_a", limits, estimate, time.Minute, deadline)); err != nil {
			t.Fatalf("放置 %s 失败: %v", rid, err)
		}
	}
	// 一个座位允许同时跑两条（seatConc=2）。先结完的那条把座位收短，
	// 另一条就会在自己还在流的时候从界面上消失。
	if _, err := plane.Settle(ctx, galaxy.SettleCommand{
		RID: "u_1", CID: "c1", ConsumerKey: "ck_a", Estimate: estimate, Actual: estimate,
		WindowKeys: windowKeys(limits), Lane: "llm.chat|claude_oauth",
		SeatTTL: time.Minute, BindTTL: 30 * time.Minute, State: contract.UnitCompleted,
	}); err != nil {
		t.Fatalf("结算 u_1 失败: %v", err)
	}
	if score := seatScore(t, plane, "c1", "ck_a"); score < deadline.UnixMilli() {
		t.Fatalf("还有在途请求时座位被收短了: %d", score)
	}

	if _, err := plane.Settle(ctx, galaxy.SettleCommand{
		RID: "u_2", CID: "c1", ConsumerKey: "ck_a", Estimate: estimate, Actual: estimate,
		WindowKeys: windowKeys(limits), Lane: "llm.chat|claude_oauth",
		SeatTTL: time.Minute, BindTTL: 30 * time.Minute, State: contract.UnitCompleted,
	}); err != nil {
		t.Fatalf("结算 u_2 失败: %v", err)
	}
	if score := seatScore(t, plane, "c1", "ck_a"); score > time.Now().Add(2*time.Minute).UnixMilli() {
		t.Fatalf("最后一条结完之后座位应收回到空闲窗口: %d", score)
	}
	// 在途计数要归零并把字段删掉，否则这个消费者往后每次结算都以为还有别的请求在跑。
	if plane.client.HExists(ctx, plane.contribKey("c1"), "run:ck_a").Val() {
		t.Fatal("在途计数没清干净")
	}
}

func TestSettleDoesNotResurrectExpiredSeat(t *testing.T) {
	plane, _ := newTestPlane(t)
	ctx := context.Background()
	limits := contract.Metering{contract.UnitOutputTokens: 10_000}
	seedContribution(t, plane, "c1", 3, 2, limits)

	estimate := contract.Metering{contract.UnitOutputTokens: 100}
	if _, err := plane.Place(ctx, placeWithSeatTTL("u_1", "c1", "ck_a", limits, estimate, time.Minute, time.Now().Add(10*time.Minute))); err != nil {
		t.Fatalf("放置失败: %v", err)
	}
	// 心跳断了 45 秒，座位随贡献一起过期 —— 这时候来一条迟到的结算。
	if err := plane.client.Del(ctx, plane.seatsKey("c1")).Err(); err != nil {
		t.Fatalf("清座位失败: %v", err)
	}
	if _, err := plane.Settle(ctx, galaxy.SettleCommand{
		RID: "u_1", CID: "c1", ConsumerKey: "ck_a", Estimate: estimate, Actual: estimate,
		WindowKeys: windowKeys(limits), Lane: "llm.chat|claude_oauth",
		SeatTTL: time.Minute, BindTTL: 30 * time.Minute, State: contract.UnitCompleted,
	}); err != nil {
		t.Fatalf("结算失败: %v", err)
	}
	// 结算若用裸 ZADD 把成员写回来，这个 ZSET 就没有 TTL 了 —— 一个永远不掉的座位。
	if plane.client.Exists(ctx, plane.seatsKey("c1")).Val() != 0 {
		t.Fatal("结算把已经过期的座位加回来了")
	}
}

// 座位和「上次落在哪台」是两条时间线：前者一分钟就让出去（主人界面上的牌子跟着它走），
// 后者记得久得多，只用来决定下一条请求先敲谁的门。拆开之后最容易出的事是
// 「拿着旧偏好回来的人绕过座位闸门」—— 下面两个用例守的就是这条。

func TestBindOutlivesSeat(t *testing.T) {
	plane, _ := newTestPlane(t)
	ctx := context.Background()
	limits := contract.Metering{contract.UnitOutputTokens: 10_000}
	seedContribution(t, plane, "c1", 3, 2, limits)

	estimate := contract.Metering{contract.UnitOutputTokens: 100}
	if _, err := plane.Place(ctx, placeWithSeatTTL("u_1", "c1", "ck_a", limits, estimate, time.Minute, time.Now().Add(10*time.Minute))); err != nil {
		t.Fatalf("放置失败: %v", err)
	}
	if _, err := plane.Settle(ctx, galaxy.SettleCommand{
		RID: "u_1", CID: "c1", ConsumerKey: "ck_a", Estimate: estimate, Actual: estimate,
		WindowKeys: windowKeys(limits), Lane: "llm.chat|claude_oauth",
		SeatTTL: time.Minute, BindTTL: 30 * time.Minute, State: contract.UnitCompleted,
	}); err != nil {
		t.Fatalf("结算失败: %v", err)
	}

	// 座位一分钟后就该让出去，偏好还要记半小时。两者用同一个窗口的话，
	// 主人界面上的牌子和「回头还落在这台」就只能二选一。
	if score := seatScore(t, plane, "c1", "ck_a"); score > time.Now().Add(2*time.Minute).UnixMilli() {
		t.Fatalf("座位没按一分钟收: %d", score)
	}
	ttl, err := plane.client.PTTL(ctx, plane.bindKey("ck_a", "llm.chat|claude_oauth")).Result()
	if err != nil {
		t.Fatalf("读绑定 TTL 失败: %v", err)
	}
	if ttl < 20*time.Minute {
		t.Fatalf("绑定跟着座位一起收短了: %v", ttl)
	}
}

func TestReturningConsumerStillPassesSeatGate(t *testing.T) {
	plane, _ := newTestPlane(t)
	ctx := context.Background()
	limits := contract.Metering{contract.UnitOutputTokens: 100_000}
	seedContribution(t, plane, "c1", 2, 4, limits)

	estimate := contract.Metering{contract.UnitOutputTokens: 10}
	if _, err := plane.Place(ctx, placeCommand("u_1", "c1", "ck_a", limits, estimate, 2, 4)); err != nil {
		t.Fatalf("放置失败: %v", err)
	}
	// ck_a 停手超过空闲窗口，座位过期了 —— 但「上次落在 c1」这条偏好还记着。
	if err := plane.client.ZAdd(ctx, plane.seatsKey("c1"), redis.Z{
		Score: float64(time.Now().Add(-time.Second).UnixMilli()), Member: "ck_a",
	}).Err(); err != nil {
		t.Fatalf("把座位改成已过期失败: %v", err)
	}
	// 这段时间里两个新人把两个座位占满了。
	for _, key := range []string{"ck_b", "ck_c"} {
		outcome, err := plane.Place(ctx, placeCommand("u_"+key, "c1", key, limits, estimate, 2, 4))
		if err != nil || !outcome.Placed {
			t.Fatalf("%s 应能占到座位: %v %+v", key, err, outcome)
		}
	}

	// ck_a 拿着旧偏好回来。座位没了、位子也满了，就得老老实实被挡在外面，
	// 由调用方溢出到别的机器 —— 从前 reuse=1 会整段跳过闸门，让这台 2 座的机器坐进第 3 个人。
	outcome, err := plane.Place(ctx, placeCommand("u_a2", "c1", "ck_a", limits, estimate, 2, 4))
	if err != nil {
		t.Fatalf("放置出错: %v", err)
	}
	if outcome.Placed || outcome.Reason != galaxy.PlaceSeatsFull {
		t.Fatalf("回头客绕过了座位闸门: %+v", outcome)
	}
	if snapshot, _, _ := plane.GetContribution(ctx, "c1"); snapshot.SeatsUsed != 2 {
		t.Fatalf("座位被坐超了: %d", snapshot.SeatsUsed)
	}
}
