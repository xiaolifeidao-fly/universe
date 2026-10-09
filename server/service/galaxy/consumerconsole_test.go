package galaxy

import (
	"testing"

	"contract"
	"service/galaxy/dto"
)

// 页头「最近 N 天消耗」里的 token 必须是该时间窗的原始用量，
// 不能再拿 Today.Usage 充数，也不能把派生的合计/子集重复加进去。
func TestUsageReportTokensCountsIndependentBucketsOnce(t *testing.T) {
	lines := []dto.UsageLine{
		{Model: "gpt-a", Unit: contract.UnitInputTokens, Amount: 560_000},
		{Model: "gpt-a", Unit: contract.UnitOutputTokens, Amount: 68_000},
		{Model: "gpt-a", Unit: contract.UnitCacheReadTokens, Amount: 9_490_000},
		{Model: "gpt-a", Unit: contract.UnitReasoningTokens, Amount: 50_000},
		{Model: "gpt-a", Unit: contract.UnitTotalTokens, Amount: 10_118_000},
		// 另一个模型/档次的行也要累进同一个时间窗。
		{Model: "gpt-b", Unit: contract.UnitInputTokens, Amount: 2_000},
	}

	if got, want := usageReportTokens(lines), int64(10_120_000); got != want {
		t.Fatalf("最近 N 天 token 总量错误：got %d, want %d", got, want)
	}
}

func TestUsageReportTokensDoesNotDoubleCountCacheWriteBreakdown(t *testing.T) {
	lines := []dto.UsageLine{
		{Unit: contract.UnitInputTokens, Amount: 100},
		{Unit: contract.UnitCacheWriteTokens, Amount: 1_000},
		{Unit: contract.UnitCacheWrite5mTokens, Amount: 600},
		{Unit: contract.UnitCacheWrite1hTokens, Amount: 400},
	}

	if got, want := usageReportTokens(lines), int64(1_100); got != want {
		t.Fatalf("cache write 合计和 TTL 分项被重复计数：got %d, want %d", got, want)
	}
}
