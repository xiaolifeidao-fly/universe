package galaxy

import (
	"testing"
	"time"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// TestUsageCategorySplitsClaudeFromCodex 类别是这一页的分栏依据：认错了，
// 一整类的量和钱会被记到另一类头上，而两栏都还是「有数」的，看不出错。
func TestUsageCategorySplitsClaudeFromCodex(t *testing.T) {
	cases := []struct {
		name                  string
		model, provider, kind string
		want                  string
	}{
		{"按模型认 Claude", "claude-sonnet-4-6", "claude_oauth", "llm.chat", dto.UsageCategoryClaude},
		{"按模型认 Codex", "gpt-5.6-terra", "codex_chatgpt", "llm.chat", dto.UsageCategoryCodex},
		{"模型名带 codex", "codex-mini", "", "llm.chat", dto.UsageCategoryCodex},
		{"没有模型时退回路由键", "", "claude_oauth", "llm.chat", dto.UsageCategoryClaude},
		{"没有模型时退回路由键（codex）", "", "codex_chatgpt", "llm.chat", dto.UsageCategoryCodex},
		{"视频能力单独一类", "", "ffmpeg-local", "video.edit.render", dto.UsageCategoryVideo},
		{"认不出来就归其它，不猜", "gemini-3-pro", "vertex", "llm.chat", dto.UsageCategoryOther},
		{"什么都没有也归其它", "", "", "", dto.UsageCategoryOther},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			if got := usageCategory(item.model, item.provider, item.kind); got != item.want {
				t.Fatalf("期望 %s，得到 %s", item.want, got)
			}
		})
	}
}

// TestUsageSegmentsOnlyCloseWholeHours 只有「铺满一个整点、而且已经封口」的段能落库。
// 还在长的那个小时要是被存下来，之后读到的就是一个定格在半途的数。
func TestUsageSegmentsOnlyCloseWholeHours(t *testing.T) {
	from := mustTime(t, "2026-09-20T00:00:00Z")
	now := mustTime(t, "2026-09-20T03:30:00Z")
	segments := usageSegments(from, now, now)
	if len(segments) != 4 {
		t.Fatalf("00:00–03:30 应该切成 4 段，得到 %d", len(segments))
	}
	for index, segment := range segments[:3] {
		if !segment.whole {
			t.Fatalf("第 %d 段是已经封口的整点小时，应该可落库", index)
		}
	}
	if segments[3].whole {
		t.Fatal("当前这个还没走完的小时不能落库")
	}
	if !segments[3].start.Equal(mustTime(t, "2026-09-20T03:00:00Z")) || !segments[3].end.Equal(now) {
		t.Fatalf("末段范围错误: %s – %s", segments[3].start, segments[3].end)
	}
}

// TestUsageSegmentsHoldBackJustClosedHour 刚封口不到一分钟的小时先别存：
// 几台 Hub 的表差几秒，就可能还有一行要落进那一桶。
func TestUsageSegmentsHoldBackJustClosedHour(t *testing.T) {
	from := mustTime(t, "2026-09-20T01:00:00Z")
	now := mustTime(t, "2026-09-20T02:00:30Z")
	segments := usageSegments(from, now, now)
	if segments[0].whole {
		t.Fatal("刚封口 30 秒的小时还在宽限期里，不该落库")
	}
	later := mustTime(t, "2026-09-20T02:02:00Z")
	if segments := usageSegments(from, later, later); !segments[0].whole {
		t.Fatal("过了宽限期就该落库")
	}
}

// TestUsageSegmentsCoverHalfHourOffsets 半小时时区下，一天的头尾各有半小时的零头。
// 那两段现算，不能被当成整点桶存下来 —— 存了就会把别的日子的量算进来。
func TestUsageSegmentsCoverHalfHourOffsets(t *testing.T) {
	from := mustTime(t, "2026-09-19T18:30:00Z") // +05:30 的当地 00:00
	now := mustTime(t, "2026-09-19T20:02:00Z")
	segments := usageSegments(from, now, now)
	if len(segments) != 3 {
		t.Fatalf("18:30–20:02 应该切成 3 段，得到 %d", len(segments))
	}
	if segments[0].whole {
		t.Fatal("18:30–19:00 不满一个整点，不能落库")
	}
	if !segments[1].whole {
		t.Fatal("19:00–20:00 是完整且封口的小时")
	}
	if segments[2].whole {
		t.Fatal("20:00 起这个小时还没走完")
	}
	// 段与段首尾相接，不重不漏 —— 重了就是把同一批量数两遍。
	for index := 1; index < len(segments); index++ {
		if !segments[index-1].end.Equal(segments[index].start) {
			t.Fatalf("第 %d 段和上一段之间有缝: %s / %s", index, segments[index-1].end, segments[index].start)
		}
	}
	if !segments[0].start.Equal(from) || !segments[len(segments)-1].end.Equal(now) {
		t.Fatal("首尾必须正好盖住 [from, to)")
	}
}

// TestTokensPrefersHubTotal token 数取 Hub 算好的合计，不把四个桶再加一遍 ——
// 合计本来就是那四个加出来的，一起算就是数两遍。
func TestTokensPrefersHubTotal(t *testing.T) {
	units := []dto.DashboardUsageUnit{
		{Unit: contract.UnitInputTokens, Amount: 100},
		{Unit: contract.UnitOutputTokens, Amount: 20},
		{Unit: contract.UnitCacheReadTokens, Amount: 300},
		{Unit: contract.UnitCacheWriteTokens, Amount: 80},
		{Unit: contract.UnitCacheWrite5mTokens, Amount: 80}, // cache_write 的拆分，不再计一遍
		{Unit: contract.UnitReasoningTokens, Amount: 15},    // output 的一部分，同理
		{Unit: contract.UnitTotalTokens, Amount: 500},
		{Unit: contract.UnitCalls, Amount: 7},
	}
	tokens, calls := tokensAndCalls(units)
	if tokens != 500 {
		t.Fatalf("应取 Hub 的合计 500，得到 %d", tokens)
	}
	if calls != 7 {
		t.Fatalf("调用次数错误: %d", calls)
	}
}

// TestTokensFallBackToBuckets 没有合计行时（非中转类能力、老数据）退回四个桶相加。
func TestTokensFallBackToBuckets(t *testing.T) {
	units := []dto.DashboardUsageUnit{
		{Unit: contract.UnitInputTokens, Amount: 100},
		{Unit: contract.UnitOutputTokens, Amount: 20},
		{Unit: contract.UnitCacheReadTokens, Amount: 300},
		{Unit: contract.UnitCacheWriteTokens, Amount: 80},
	}
	if tokens, _ := tokensAndCalls(units); tokens != 500 {
		t.Fatalf("应退回四个桶之和 500，得到 %d", tokens)
	}
}

// TestBuildUsageKeepsBothSidesApart 两端的钱是两个数，不能合成一个。
// 差额是平台毛利 —— 把它们加在一起，得到的是一个没有意义的数字。
func TestBuildUsageKeepsBothSidesApart(t *testing.T) {
	totals := map[usageKey]*usageCell{
		{category: dto.UsageCategoryClaude, unit: contract.UnitTotalTokens}: {amount: 1_000_000, consumerAmount: 3_000_000, providerAmount: 2_000_000},
		{category: dto.UsageCategoryClaude, unit: contract.UnitCalls}:       {amount: 12},
		{category: dto.UsageCategoryCodex, unit: contract.UnitTotalTokens}:  {amount: 400_000, consumerAmount: 800_000, providerAmount: 500_000},
	}
	usage := buildUsage(totals)
	if len(usage.Categories) != 2 {
		t.Fatalf("应该有 claude / codex 两格，得到 %d", len(usage.Categories))
	}
	claude := usage.Categories[0]
	if claude.Category != dto.UsageCategoryClaude {
		t.Fatalf("claude 应排在最前: %s", claude.Category)
	}
	if claude.Tokens != 1_000_000 || claude.Calls != 12 {
		t.Fatalf("claude 的量错误: %d tokens / %d calls", claude.Tokens, claude.Calls)
	}
	if claude.ConsumerAmount != 3_000_000 || claude.ProviderAmount != 2_000_000 || claude.Margin != 1_000_000 {
		t.Fatalf("claude 的钱错误: 收 %d 付 %d 毛利 %d", claude.ConsumerAmount, claude.ProviderAmount, claude.Margin)
	}
	if usage.Total.Tokens != 1_400_000 || usage.Total.Margin != 1_300_000 {
		t.Fatalf("合计错误: %d tokens / 毛利 %d", usage.Total.Tokens, usage.Total.Margin)
	}
}

// TestBuildUsageKeepsEmptyCategories 今天没跑 Codex 是「0」，不是「这一栏消失了」。
// 栏目消失会被读成「我们没有这个业务」。
func TestBuildUsageKeepsEmptyCategories(t *testing.T) {
	usage := buildUsage(map[usageKey]*usageCell{})
	if len(usage.Categories) != 2 {
		t.Fatalf("空数据也该有两格，得到 %d", len(usage.Categories))
	}
	for _, category := range usage.Categories {
		if category.Tokens != 0 || category.Units == nil {
			t.Fatalf("%s 的空格子形状不对", category.Category)
		}
	}
}

// TestMachinesOfCountsOnlineByIdentity 在线机器按散户 / 工作室分开，两者相加等于在线数。
// 没有 provider 行的算散户 —— 注册默认就是散户。
func TestMachinesOfCountsOnlineByIdentity(t *testing.T) {
	rows := []repository.NodePresence{
		{NodeID: "n1", ProviderType: dto.ProviderIndividual, Online: true},
		{NodeID: "n2", ProviderType: "", Online: true},
		{NodeID: "n3", ProviderType: dto.ProviderStudio, Online: true},
		{NodeID: "n4", ProviderType: dto.ProviderStudio, Online: false},
		{NodeID: "n5", ProviderType: dto.ProviderIndividual, Online: true, Banned: true},
	}
	machines := machinesOf(rows)
	if machines.Online != 4 || machines.Offline != 1 || machines.Total != 5 {
		t.Fatalf("在线 / 离线 / 总数错误: %d / %d / %d", machines.Online, machines.Offline, machines.Total)
	}
	if machines.Individual != 3 || machines.Studio != 1 {
		t.Fatalf("散户 / 工作室错误: %d / %d", machines.Individual, machines.Studio)
	}
	if machines.Individual+machines.Studio != machines.Online {
		t.Fatal("两种身份相加必须等于在线数，否则界面上的两个数加不出上面那个")
	}
	if machines.Banned != 1 {
		t.Fatalf("封禁数错误: %d", machines.Banned)
	}
}

// TestIsTokenUnitExcludesCallsAndTime 「还剩多少 token」只加 token 类单位。
// 次数和时长也能设上限，但那不是 token，加在一起没有意义。
func TestIsTokenUnitExcludesCallsAndTime(t *testing.T) {
	for _, unit := range []string{contract.UnitTotalTokens, contract.UnitInputTokens, contract.UnitCacheReadTokens} {
		if !isTokenUnit(unit) {
			t.Fatalf("%s 应该算 token 单位", unit)
		}
	}
	for _, unit := range []string{contract.UnitCalls, contract.UnitTimeSeconds, contract.UnitVideoFrames} {
		if isTokenUnit(unit) {
			t.Fatalf("%s 不该算 token 单位", unit)
		}
	}
}

// TestCapacityBucketAggregates 一档里的上限 / 已用 / 剩余按单位摊开，也给出合计。
// 预留的那部分算「已用」：在途请求占着的量，此刻放不出来。
func TestCapacityBucketAggregates(t *testing.T) {
	bucket := newCapacityBucket(Window5H)
	bucket.add(contract.UnitTotalTokens, 2_000_000, 500_000, 1_500_000)
	bucket.add(contract.UnitTotalTokens, 1_000_000, 1_000_000, 0)
	bucket.add(contract.UnitOutputTokens, 300_000, 100_000, 200_000)
	bucket.machines["n1"] = true
	bucket.cids["n1:relay_claude"] = true

	view := bucket.view()
	if view.Limit != 3_300_000 || view.Used != 1_600_000 || view.Left != 1_700_000 {
		t.Fatalf("合计错误: %d / %d / %d", view.Limit, view.Used, view.Left)
	}
	if len(view.Units) != 2 {
		t.Fatalf("应该有两个单位的明细，得到 %d", len(view.Units))
	}
	if view.Units[0].Unit != contract.UnitOutputTokens || view.Units[0].Left != 200_000 {
		t.Fatalf("单位明细错误: %+v", view.Units[0])
	}
	if view.Machines != 1 || view.Contributions != 1 {
		t.Fatalf("机器 / 贡献数错误: %d / %d", view.Machines, view.Contributions)
	}
}

// TestWindowOrderPutsShortWindowsFirst 档位按窗口从短到长排，不按字母序。
func TestWindowOrderPutsShortWindowsFirst(t *testing.T) {
	if windowOrder(Window5H) >= windowOrder(WindowDay) {
		t.Fatal("5h 应排在 day 前面")
	}
	if windowOrder(WindowDay) >= windowOrder(WindowWeek) {
		t.Fatal("day 应排在 week 前面")
	}
	if windowOrder(WindowMonth) >= windowOrder(WindowTotal) {
		t.Fatal("month 应排在 total 前面")
	}
}

// TestMergeUsageSkipsHourMarker 标记行只是「这个小时算过了」，不是数据。
// 把它并进合计的话，每个小时都会多出一格空类别。
func TestMergeUsageSkipsHourMarker(t *testing.T) {
	hour := mustTime(t, "2026-09-20T02:00:00Z")
	totals := map[usageKey]*usageCell{}
	mergeUsage(totals, []*repository.GalaxyUsageRollup{
		{StatHour: hour, Category: "", Unit: "", RolledAt: time.Now()},
		{StatHour: hour, Category: dto.UsageCategoryClaude, Unit: contract.UnitTotalTokens, Amount: 10, ConsumerAmount: 3, ProviderAmount: 2},
		{StatHour: hour, Category: dto.UsageCategoryClaude, Unit: contract.UnitTotalTokens, Amount: 5, ConsumerAmount: 1, ProviderAmount: 1},
	})
	if len(totals) != 1 {
		t.Fatalf("标记行不该占一格: %d", len(totals))
	}
	cell := totals[usageKey{category: dto.UsageCategoryClaude, unit: contract.UnitTotalTokens}]
	if cell.amount != 15 || cell.consumerAmount != 4 || cell.providerAmount != 3 {
		t.Fatalf("同一格跨小时要相加: %+v", cell)
	}
}
