package galaxy

import (
	"testing"

	"contract"
)

// TestClawbackPlanOnlyRefundsWhatWasCharged 盯的是钱：追回只能覆盖当初真收过钱的
// 单位。calls 与 time 不计价，当初没进账本，退它就是凭空发钱。
func TestClawbackPlanOnlyRefundsWhatWasCharged(t *testing.T) {
	prices := map[contract.MeterUnit]priceRow{
		"llm.tokens.input":  {Price: 3000, ProviderShare: 0.7},
		"llm.tokens.output": {Price: 15000, ProviderShare: 0.7},
		"llm.calls":         {Price: 0, ProviderShare: 0.7}, // 不计价
	}
	amounts := contract.Metering{
		"llm.tokens.input":  1_000_000,
		"llm.tokens.output": 200_000,
		"llm.calls":         3,
		"llm.time.seconds":  42, // 定价表里根本没有
	}
	refund, clawback := clawbackPlan(amounts, prices)

	if len(refund) != 2 {
		t.Fatalf("只该退两个计价单位，实际退了 %v", refund)
	}
	if refund["llm.tokens.input"] != 1_000_000 || refund["llm.tokens.output"] != 200_000 {
		t.Fatalf("退回的量应与计量一致，实际 %v", refund)
	}
	if _, ok := refund["llm.calls"]; ok {
		t.Fatal("不计价的单位不该出现在退款里")
	}
	if _, ok := refund["llm.time.seconds"]; ok {
		t.Fatal("定价表里没有的单位不该出现在退款里")
	}

	// 追回额必须等于当初分给提供者的那部分，逐单位用同一个 splitCost 算。
	_, inputShare := splitCost(1_000_000, prices["llm.tokens.input"])
	_, outputShare := splitCost(200_000, prices["llm.tokens.output"])
	if want := inputShare + outputShare; clawback != want {
		t.Fatalf("追回额应为 %d，实际 %d", want, clawback)
	}
}

// TestClawbackPlanIgnoresSubCentUsage 用量太小、当初压根没收到一分钱的，
// 不该退出一笔钱来。
func TestClawbackPlanIgnoresSubCentUsage(t *testing.T) {
	prices := map[contract.MeterUnit]priceRow{"llm.tokens.input": {Price: 3000, ProviderShare: 0.7}}
	refund, clawback := clawbackPlan(contract.Metering{"llm.tokens.input": 10}, prices)
	if len(refund) != 0 || clawback != 0 {
		t.Fatalf("不足一个计价单位不该产生退款，实际 refund=%v clawback=%d", refund, clawback)
	}
}

// TestClawbackPlanEmptyIsSafe 没有计量流水时不该退任何东西。
func TestClawbackPlanEmptyIsSafe(t *testing.T) {
	refund, clawback := clawbackPlan(contract.Metering{}, map[contract.MeterUnit]priceRow{})
	if len(refund) != 0 || clawback != 0 {
		t.Fatalf("没有计量就没有可退的，实际 refund=%v clawback=%d", refund, clawback)
	}
}

// TestSplitCostBelowOneUnitIsFree 小额用量折下来不足一分钱就不计费。
// 这条得钉住：如果它变成「至少收一分」，那退款侧会退不出这一分（refund 走的是
// 同一个函数，返回 0 就不进账本），账立刻对不平。
func TestSplitCostBelowOneUnitIsFree(t *testing.T) {
	cost, share := splitCost(10, priceRow{Price: 3000, ProviderShare: 0.7})
	if cost != 0 || share != 0 {
		t.Fatalf("不足一个计价单位应当不计费，实际 cost=%d share=%d", cost, share)
	}
}

func TestDisputeReasonsAreClosed(t *testing.T) {
	// 理由是个封闭集合。开放自由文本的话，运营就没法按类型统计，
	// 「这个提供者被投诉的都是伪造」这种判断也就做不出来。
	for _, reason := range []string{"not_delivered", "wrong_output", "overcharged", "forged", "other"} {
		if !disputeReasons[reason] {
			t.Fatalf("%s 应当是合法理由", reason)
		}
	}
	if disputeReasons["随便写点什么"] {
		t.Fatal("不该接受集合外的理由")
	}
}
