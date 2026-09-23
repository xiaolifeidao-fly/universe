package galaxy

import (
	"testing"
	"time"

	"contract"
)

func mustTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatalf("解析时间失败: %v", err)
	}
	return parsed
}

func TestWindowKeyFollowsProviderTimezone(t *testing.T) {
	grant := QuotaGrant{Unit: contract.UnitOutputTokens, Limit: 100, Window: WindowDay, ResetAt: "00:00+08:00"}
	// 东八区 2026-09-07 07:00 还是 UTC 的 2026-09-06 23:00，但窗口该按提供者本地日算。
	if key := grant.WindowKey(mustTime(t, "2026-09-06T23:00:00Z")); key != "20260907" {
		t.Fatalf("按提供者时区归属的窗口键错误: %s", key)
	}
	if key := grant.WindowKey(mustTime(t, "2026-09-06T15:59:00Z")); key != "20260906" {
		t.Fatalf("翻窗口之前不该提前进入新窗口: %s", key)
	}
}

func TestWindowKeyHonoursResetHour(t *testing.T) {
	// 每天本地 04:00 归零：03:59 仍属前一天。
	grant := QuotaGrant{Unit: contract.UnitCalls, Limit: 10, Window: WindowDay, ResetAt: "04:00+00:00"}
	if key := grant.WindowKey(mustTime(t, "2026-09-07T03:59:00Z")); key != "20260906" {
		t.Fatalf("归零时刻之前应属前一个窗口: %s", key)
	}
	if key := grant.WindowKey(mustTime(t, "2026-09-07T04:00:00Z")); key != "20260907" {
		t.Fatalf("归零时刻应开启新窗口: %s", key)
	}
}

func TestWindowBoundsAndCounterTTL(t *testing.T) {
	grant := QuotaGrant{Unit: contract.UnitOutputTokens, Limit: 100, Window: WindowDay, ResetAt: "00:00+08:00"}
	now := mustTime(t, "2026-09-07T02:00:00Z") // 东八区 10:00
	start := grant.WindowStart(now)
	end := grant.WindowEnd(now)
	if !start.Equal(mustTime(t, "2026-09-06T16:00:00Z")) {
		t.Fatalf("窗口起点错误: %s", start)
	}
	if !end.Equal(mustTime(t, "2026-09-07T16:00:00Z")) {
		t.Fatalf("窗口终点错误: %s", end)
	}
	// 计数器活到窗口末 + 1 天，留出对账余量。
	if ttl := grant.CounterTTL(now); ttl != end.Add(24*time.Hour).Sub(now) {
		t.Fatalf("计数器 TTL 应为窗口末 + 1 天: %s", ttl)
	}
}

func TestTotalWindowNeverRolls(t *testing.T) {
	grant := QuotaGrant{Unit: contract.UnitCalls, Limit: 1000, Window: WindowTotal}
	first := grant.WindowKey(mustTime(t, "2026-01-01T00:00:00Z"))
	second := grant.WindowKey(mustTime(t, "2027-06-01T00:00:00Z"))
	if first != "all" || second != "all" {
		t.Fatalf("total 窗口应该恒为 all: %s / %s", first, second)
	}
}

func TestQuotaAcceptsStopsAtProtectionFloor(t *testing.T) {
	now := time.Now()
	grants := []QuotaGrant{{Unit: contract.UnitOutputTokens, Limit: 1000, Window: WindowDay}}
	plan := BuildQuotaPlan(grants, now)
	// 保护线是 5%：limit=1000 → reserve=50。
	if plan.Reserve[contract.UnitOutputTokens] != 50 {
		t.Fatalf("保护线计算错误: %d", plan.Reserve[contract.UnitOutputTokens])
	}
	snapshot := ContributionSnapshot{
		Seats: 3, SeatConcurrency: 2,
		QuotaLimit:    contract.Metering{contract.UnitOutputTokens: 1000},
		QuotaUsed:     contract.Metering{contract.UnitOutputTokens: 900},
		QuotaReserved: contract.Metering{},
	}
	// 剩 100，预估 40 之后还剩 60 > 50，放行。
	if ok, _ := QuotaAccepts(snapshot, plan, contract.Metering{contract.UnitOutputTokens: 40}); !ok {
		t.Fatal("余量高于保护线时应放行")
	}
	// 预估 60 之后只剩 40 < 50，挡住。
	ok, unit := QuotaAccepts(snapshot, plan, contract.Metering{contract.UnitOutputTokens: 60})
	if ok || unit != contract.UnitOutputTokens {
		t.Fatalf("跌破保护线应被挡住并指出维度: ok=%v unit=%s", ok, unit)
	}
}

func TestExhaustedUnitsDrivesDraining(t *testing.T) {
	snapshot := ContributionSnapshot{
		QuotaLimit: contract.Metering{contract.UnitOutputTokens: 100, contract.UnitCalls: 10},
		QuotaUsed:  contract.Metering{contract.UnitOutputTokens: 100, contract.UnitCalls: 3},
	}
	units := ExhaustedUnits(snapshot)
	if len(units) != 1 || units[0] != contract.UnitOutputTokens {
		t.Fatalf("只有触顶的维度应被列出: %v", units)
	}
	// 三维同时生效：一维触顶就停止接新单，另外两维还有余量也不算数。
	if warned := WarnedUnits(snapshot); len(warned) != 1 || warned[0] != contract.UnitOutputTokens {
		t.Fatalf("软阈值应只命中触顶那一维: %v", warned)
	}
}

func TestEffectiveSeatsShrinksWithBurnRate(t *testing.T) {
	grant := QuotaGrant{Unit: contract.UnitOutputTokens, Limit: 24_000, Window: WindowDay, ResetAt: "00:00+00:00"}
	now := mustTime(t, "2026-09-07T12:00:00Z") // 窗口已过 12 小时，还剩 12 小时
	plan := BuildQuotaPlan([]QuotaGrant{grant}, now)

	// 3 个座位在 12 小时里烧掉 18000，即每座位每小时 500。
	// 剩 6000，还剩 12 小时 → 6000/(500×12) = 1 个座位。
	snapshot := ContributionSnapshot{
		Seats: 3, SeatConcurrency: 2,
		QuotaLimit:    contract.Metering{contract.UnitOutputTokens: 24_000},
		QuotaUsed:     contract.Metering{contract.UnitOutputTokens: 18_000},
		QuotaReserved: contract.Metering{},
	}
	if seats := EffectiveSeats(snapshot, plan, now, nil); seats != 1 {
		t.Fatalf("有效座位数应按消耗率收缩到 1，实际 %d", seats)
	}

	// 窗口刚翻转、没有样本时不该限制：让第一笔请求进来产生样本。
	fresh := snapshot
	fresh.QuotaUsed = contract.Metering{}
	if seats := EffectiveSeats(fresh, plan, now, nil); seats != 3 {
		t.Fatalf("无样本时应给满座位，实际 %d", seats)
	}
}

func TestEffectiveSeatsZeroWhenTimeLeftBelowMinSession(t *testing.T) {
	grant := QuotaGrant{Unit: contract.UnitTimeSeconds, Limit: 3600, Window: WindowDay}
	now := time.Now()
	plan := BuildQuotaPlan([]QuotaGrant{grant}, now)
	snapshot := ContributionSnapshot{
		Seats: 3, SeatConcurrency: 2,
		QuotaLimit:    contract.Metering{contract.UnitTimeSeconds: 3600},
		QuotaUsed:     contract.Metering{contract.UnitTimeSeconds: 3000}, // 剩 600 < 900
		QuotaReserved: contract.Metering{},
	}
	if seats := EffectiveSeats(snapshot, plan, now, nil); seats != 0 {
		t.Fatalf("小时维度剩余低于 minSessionSec 时不该再接新绑定，实际 %d", seats)
	}
}

// TestFiveHourWindowSplitsTheDayIntoFiveBlocks 5h 窗口按提供者本地日切五段。
//
// 盯住两件事：段与段之间真的换了计数器（否则「每 5 小时」就退化成「每天」），
// 以及最后那段在日界上翻窗口而不是滑到次日 01:00。
func TestFiveHourWindowSplitsTheDayIntoFiveBlocks(t *testing.T) {
	grant := QuotaGrant{Unit: contract.UnitTotalTokens, Limit: 2_000_000, Window: Window5H, ResetAt: "00:00+08:00"}
	cases := []struct {
		at   string // UTC
		want string
	}{
		{"2026-09-06T16:00:00Z", "20260907H0"}, // 东八区 09-07 00:00，第 0 段开头
		{"2026-09-06T20:59:00Z", "20260907H0"}, // 东八区 04:59，还在第 0 段
		{"2026-09-06T21:00:00Z", "20260907H1"}, // 东八区 05:00，翻到第 1 段
		{"2026-09-07T11:59:00Z", "20260907H3"}, // 东八区 19:59
		{"2026-09-07T12:00:00Z", "20260907H4"}, // 东八区 20:00，最后一段
		{"2026-09-07T15:59:00Z", "20260907H4"},
		{"2026-09-07T16:00:00Z", "20260908H0"}, // 东八区次日 00:00，回到第 0 段
	}
	for _, item := range cases {
		if key := grant.WindowKey(mustTime(t, item.at)); key != item.want {
			t.Fatalf("%s 的 5h 窗口键错误: 期望 %s，得到 %s", item.at, item.want, key)
		}
	}
}

// TestFiveHourWindowBoundsStopAtDayEnd 最后一段只有四小时，终点必须落在日界上。
// 越过日界的话，这一段会和次日第 0 段重叠，而那段时间的用量记在次日那把计数器上。
func TestFiveHourWindowBoundsStopAtDayEnd(t *testing.T) {
	grant := QuotaGrant{Unit: contract.UnitTotalTokens, Limit: 100, Window: Window5H, ResetAt: "00:00+08:00"}

	middle := mustTime(t, "2026-09-07T04:00:00Z") // 东八区 12:00，第 2 段 [10:00,15:00)
	if start := grant.WindowStart(middle); !start.Equal(mustTime(t, "2026-09-07T02:00:00Z")) {
		t.Fatalf("第 2 段起点错误: %s", start)
	}
	if end := grant.WindowEnd(middle); !end.Equal(mustTime(t, "2026-09-07T07:00:00Z")) {
		t.Fatalf("第 2 段终点错误: %s", end)
	}

	last := mustTime(t, "2026-09-07T14:00:00Z") // 东八区 22:00，最后一段 [20:00,24:00)
	if start := grant.WindowStart(last); !start.Equal(mustTime(t, "2026-09-07T12:00:00Z")) {
		t.Fatalf("末段起点错误: %s", start)
	}
	if end := grant.WindowEnd(last); !end.Equal(mustTime(t, "2026-09-07T16:00:00Z")) {
		t.Fatalf("末段终点应该停在日界上: %s", end)
	}
}

// TestUnknownWindowStillFallsBackToDay 认不出来的窗口退回 day，而不是报错或当成 5h。
// 老节点不认识 5h，新写法也可能拼错 —— 退回日额度是能解释的行为。
func TestUnknownWindowStillFallsBackToDay(t *testing.T) {
	grant := QuotaGrant{Unit: contract.UnitCalls, Limit: 10, Window: "6h"}
	if key := grant.WindowKey(mustTime(t, "2026-09-07T04:00:00Z")); key != "20260907" {
		t.Fatalf("未知窗口应退回 day: %s", key)
	}
}
