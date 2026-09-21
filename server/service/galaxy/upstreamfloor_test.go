package galaxy

import (
	"testing"
	"time"

	"service/galaxy/dto"
)

// 这条线是主人给自己的订阅留的余地：上游快用完的时候先停止接单，
// 把剩下的那部分留给自己用。它是**唯一**一个拿节点自报的数去挡派单的地方，
// 所以这一组用例盯的都是同一件事：它只会让机器少接活，绝不会因为
// 「没采到 / 认不出来」而把一台正常机器踢出池子。

func percentOf(value float64) *float64 { return &value }
func int64Of(value int64) *int64       { return &value }

func usageOfBuckets(buckets ...dto.UsageBucket) *dto.UpstreamUsage {
	return &dto.UpstreamUsage{Buckets: buckets, ObservedAt: "2026-09-21T02:00:00Z", Source: "probe"}
}

func TestNormalizeUpstreamFloorsDefaultsToZero(t *testing.T) {
	floors, err := NormalizeUpstreamFloors(nil)
	if err != nil {
		t.Fatalf("没填不是错：%v", err)
	}
	if len(floors) != 1 || floors[0].Window != "" || floors[0].Percent != 0 {
		t.Fatalf("默认该是「任一窗口剩 0%% 停」，实际 %+v", floors)
	}
}

// 同一个窗口两条线，宽的那条永远不会生效 —— 而主人看着界面上明明写着的数字，
// 不会想到它是死的。宁可当场报错。
func TestNormalizeUpstreamFloorsRejectsDuplicateWindow(t *testing.T) {
	_, err := NormalizeUpstreamFloors([]dto.UpstreamFloorInput{{Window: "5h", Percent: 10}, {Window: "5h", Percent: 20}})
	if err == nil {
		t.Fatal("同一个窗口配两条应当报错")
	}
}

func TestNormalizeUpstreamFloorsRejectsOutOfRange(t *testing.T) {
	for _, percent := range []int{-1, 101} {
		if _, err := NormalizeUpstreamFloors([]dto.UpstreamFloorInput{{Percent: percent}}); err == nil {
			t.Fatalf("%d%% 不是合法的余量下限", percent)
		}
	}
}

// 存的是**已用**百分比（两家在节点那儿已经统一过一次），这里只做一次减法。
func TestUpstreamLeftByWindowUsesRemainingNotUsed(t *testing.T) {
	left := UpstreamLeftByWindow(usageOfBuckets(dto.UsageBucket{
		Bucket: "Current session", Window: "5h", UsedPercent: percentOf(17),
	}))
	if got := left["5h"].Percent; got != 83 {
		t.Fatalf("已用 17%% 就是还剩 83%%，实际 %v", got)
	}
}

// 没有百分比时用 remaining / limit 折算；两样都没有的桶跳过，不猜。
func TestUpstreamLeftByWindowFallsBackToCounts(t *testing.T) {
	left := UpstreamLeftByWindow(usageOfBuckets(
		dto.UsageBucket{Bucket: "primary", Window: "5h", Limit: int64Of(1000), Remaining: int64Of(250)},
		dto.UsageBucket{Bucket: "secondary", Window: "7d"},
	))
	if got := left["5h"].Percent; got != 25 {
		t.Fatalf("1000 里剩 250 就是 25%%，实际 %v", got)
	}
	if _, ok := left["7d"]; ok {
		t.Fatal("什么都没报的桶不该出现在余量表里 —— 那会被判定当成 0%% 用")
	}
}

// 一个窗口底下有好几个桶时取最低的那个：周额度还分总量和 Opus，
// 任何一个见底，这个窗口就真的跑不动了。
func TestUpstreamLeftByWindowTakesTheLowestBucket(t *testing.T) {
	left := UpstreamLeftByWindow(usageOfBuckets(
		dto.UsageBucket{Bucket: "Current week (all models)", Window: "7d", UsedPercent: percentOf(58)},
		dto.UsageBucket{Bucket: "Current week (Opus)", Window: "7d", UsedPercent: percentOf(96)},
	))
	if got := left["7d"]; got.Percent != 4 || got.Bucket != "Current week (Opus)" {
		t.Fatalf("该取最低的那个桶并记住它是谁，实际 %+v", got)
	}
}

func TestUpstreamBlockedByAnyWindow(t *testing.T) {
	floors := []UpstreamFloor{{Window: "", Percent: 20}}
	left := UpstreamLeftByWindow(usageOfBuckets(
		dto.UsageBucket{Bucket: "Current session", Window: "5h", UsedPercent: percentOf(10)},
		dto.UsageBucket{Bucket: "Current week (all models)", Window: "7d", UsedPercent: percentOf(85)},
	))
	block, blocked := UpstreamBlockedBy(floors, left)
	if !blocked {
		t.Fatal("周额度只剩 15%%，低于 20%% 的线，应当停止接单")
	}
	if block.Window != "7d" || block.Bucket != "Current week (all models)" {
		t.Fatalf("要说清是哪个窗口、哪个桶触的线，实际 %+v", block)
	}
	if block.Left != 15 || block.Percent != 20 {
		t.Fatalf("两个数都要给出来，实际 %+v", block)
	}
}

// 指定了窗口的那条线，在那个窗口没观测到时**放行**。
//
// 反过来（当成 0% 拦下）的话，一台只报得出 5h 的机器会因为一条 7d 的线
// 被永久踢出池子，而主人在界面上看到的是「共享中」。
func TestUpstreamBlockedByIgnoresUnobservedWindow(t *testing.T) {
	floors := []UpstreamFloor{{Window: "7d", Percent: 50}}
	left := UpstreamLeftByWindow(usageOfBuckets(
		dto.UsageBucket{Bucket: "Current session", Window: "5h", UsedPercent: percentOf(99)},
	))
	if _, blocked := UpstreamBlockedBy(floors, left); blocked {
		t.Fatal("没观测到 7d 就不该按 7d 拦 —— 不知道要放行")
	}
}

// 一份都没有的时候同样放行：探针没跑过、CLI 没装、上游换了输出格式都是这一类。
func TestUpstreamBlockedByAllowsWhenNothingObserved(t *testing.T) {
	if _, blocked := UpstreamBlockedBy(DefaultUpstreamFloors(), nil); blocked {
		t.Fatal("没有任何观测时不该拦")
	}
}

// 默认那条（0%）只在真的见底时才拦，等价于加这条线之前的行为。
func TestUpstreamBlockedByDefaultOnlyStopsAtZero(t *testing.T) {
	floors := DefaultUpstreamFloors()
	almost := UpstreamLeftByWindow(usageOfBuckets(dto.UsageBucket{Window: "5h", UsedPercent: percentOf(99)}))
	if _, blocked := UpstreamBlockedBy(floors, almost); blocked {
		t.Fatal("还剩 1%% 时默认不该停 —— 默认就是不额外保护")
	}
	empty := UpstreamLeftByWindow(usageOfBuckets(dto.UsageBucket{Window: "5h", UsedPercent: percentOf(100)}))
	if _, blocked := UpstreamBlockedBy(floors, empty); !blocked {
		t.Fatal("用光了就该停")
	}
}

// 「还剩下百分之 X 就停」是含 X 的：正好压线要停，不能等跌破。
func TestUpstreamBlockedByIsInclusive(t *testing.T) {
	floors := []UpstreamFloor{{Window: "5h", Percent: 20}}
	left := UpstreamLeftByWindow(usageOfBuckets(dto.UsageBucket{Window: "5h", UsedPercent: percentOf(80)}))
	if _, blocked := UpstreamBlockedBy(floors, left); !blocked {
		t.Fatal("正好剩 20%% 就该停")
	}
}

// 派单那一侧真的会把它摘掉 —— 前面几条验的是算式，这条验的是它接进了硬过滤。
func TestFilterRejectsBelowUpstreamFloor(t *testing.T) {
	now := mustTime(t, "2026-09-07T12:00:00Z")
	snapshot := healthy("c1", now)
	snapshot.UpstreamFloors = []UpstreamFloor{{Window: "", Percent: 15}}
	snapshot.UpstreamLeft = map[string]UpstreamLeft{"5h": {Percent: 9, Bucket: "Current session"}}
	if candidates := Filter([]ContributionSnapshot{snapshot}, filterInput(now, []ContributionSnapshot{snapshot})); len(candidates) != 0 {
		t.Fatal("上游只剩 9%%、低于主人划的 15%%，不该再被派单")
	}

	// 线以上照常接单，别把整条路堵死。
	snapshot.UpstreamLeft = map[string]UpstreamLeft{"5h": {Percent: 60}}
	if candidates := Filter([]ContributionSnapshot{snapshot}, filterInput(now, []ContributionSnapshot{snapshot})); len(candidates) != 1 {
		t.Fatal("余量高于线时应当照常进候选")
	}
}

// 探针这一拍没带余量（nil）时，控制面里上一次的观测要留着 ——
// 空的盖上去等于让闸门在探针抽风的几分钟里凭空打开。
func TestLaneRuntimeKeepsPreviousObservationWhenUnreported(t *testing.T) {
	if got := UpstreamLeftByWindow(nil); got != nil {
		t.Fatalf("没带就是 nil，不是空表：%+v", got)
	}
	if got := UpstreamLeftByWindow(&dto.UpstreamUsage{ObservedAt: time.Now().Format(time.RFC3339)}); got != nil {
		t.Fatalf("一个桶都没有时同样是 nil：%+v", got)
	}
}
