package galaxy

import (
	"context"
	"testing"
	"time"

	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// TestMarkLivePricesPicksTheLatestRowThatHasArrived 盯的是「哪一行是现在的价」。
//
// 同一个 (kind, unit) 底下三行：一行排在未来、一行是当前、一行是被取代的历史。
// 挑错一行的后果不是报错 —— 界面照样画出来，只是运营照着一个不生效的数字去
// 对账，而账单是按另一个数字算的。
func TestMarkLivePricesPicksTheLatestRowThatHasArrived(t *testing.T) {
	now := time.Date(2026, 9, 16, 12, 0, 0, 0, time.UTC)
	rows := []*repository.GalaxyPrice{
		// 取回顺序就是仓储的顺序：kind, unit, effective_from desc。
		{Kind: "llm.chat", Unit: "llm.input_tokens", Price: 5_000_000, EffectiveFrom: now.AddDate(0, 0, 7)},
		{Kind: "llm.chat", Unit: "llm.input_tokens", Price: 3_000_000, EffectiveFrom: now.AddDate(0, 0, -1)},
		{Kind: "llm.chat", Unit: "llm.input_tokens", Price: 1_000_000, EffectiveFrom: now.AddDate(0, 0, -30)},
	}
	views, priced := markLivePrices(rows, now)

	if len(views) != 3 {
		t.Fatalf("三行都该回出来（历史与未来价是这一页的内容），实际 %d 行", len(views))
	}
	if views[0].Effective {
		t.Error("排在未来的那一行不是当前价")
	}
	if !views[1].Effective {
		t.Error("最新的、已经到点的那一行才是当前价")
	}
	if views[2].Effective {
		t.Error("被取代的历史价不该再标成生效中")
	}
	if !priced[priceKey("llm.chat", "llm.input_tokens")] {
		t.Error("有生效价的组合应当算「已定价」")
	}
}

// TestMarkLivePricesTreatsAFutureOnlyRowAsUnpriced 只排了未来价、此刻一行都没到点的，
// 现在仍然是**没有价**。
//
// 这条最容易搞错：界面上明明有一行，于是看着像已经定过价了；但计费那一刻
// priceTable 查不到它，扣费静默算 0。所以它不能进「已定价」集合，
// 那张「有量无价」的告警要照样把它列出来。
func TestMarkLivePricesTreatsAFutureOnlyRowAsUnpriced(t *testing.T) {
	now := time.Date(2026, 9, 16, 12, 0, 0, 0, time.UTC)
	rows := []*repository.GalaxyPrice{
		{Kind: "video.edit.render", Unit: "video.output_seconds", Price: 9_000_000, EffectiveFrom: now.Add(time.Hour)},
	}
	views, priced := markLivePrices(rows, now)

	if views[0].Effective {
		t.Error("还没到生效时间的行不该标成生效中")
	}
	if priced[priceKey("video.edit.render", "video.output_seconds")] {
		t.Fatal("只排了未来价 = 此刻没有价，不能当成已定价")
	}
	unpriced := unpricedFrom([]repository.UsageRow{
		{Kind: "video.edit.render", Unit: "video.output_seconds", Amount: 120},
	}, priced)
	if len(unpriced) != 1 {
		t.Fatalf("它应当出现在「有量无价」里，实际 %v", unpriced)
	}
}

// TestUnpricedFromListsEveryMeteredUnitWithoutAPrice 有量无价的那张告警。
//
// 不猜「这个单位本来就该免费」：次数与时长默认不计价是**一个决定**，
// 而库里没有任何地方记着这个决定。列出来、让运营填一行 0，
// 「0 是有意的」和「忘了填」才区分得开。
func TestUnpricedFromListsEveryMeteredUnitWithoutAPrice(t *testing.T) {
	priced := map[string]bool{priceKey("llm.chat", "llm.input_tokens"): true}
	usage := []repository.UsageRow{
		{Kind: "llm.chat", Unit: "llm.output_tokens"},
		{Kind: "llm.chat", Unit: "llm.input_tokens"},  // 已定价，不该出现
		{Kind: "llm.chat", Unit: "llm.calls"},         // 默认不计价，但仍然要列
		{Kind: "llm.chat", Unit: "llm.output_tokens"}, // 同一组的第二行（不同上游），只算一次
	}
	out := unpricedFrom(usage, priced)

	if len(out) != 2 {
		t.Fatalf("应当只列出两个未定价的单位，实际 %v", out)
	}
	if out[0].Unit != "llm.calls" || out[1].Unit != "llm.output_tokens" {
		t.Fatalf("结果要按 kind、unit 排好，实际 %v", out)
	}
}

// TestSaveAdminPriceRefusesAShareOutsideZeroToOne 分成比例越界。
//
// 放过去的不是报错，是一笔算错的分账 —— 1.5 意味着给提供者的钱比收上来的还多。
func TestSaveAdminPriceRefusesAShareOutsideZeroToOne(t *testing.T) {
	svc, _, _ := banHarness(t, nil)
	for _, share := range []float64{-0.1, 1.5} {
		err := svc.SaveAdminPrice(context.Background(), dto.SavePriceRequest{
			Kind: "llm.chat", Unit: "llm.input_tokens", Price: 3_000_000, ProviderShare: share,
		})
		if err == nil {
			t.Fatalf("分成比例 %v 应当被拒", share)
		}
	}
}

// TestSaveAdminPriceRefusesANegativePrice 负单价会让这条用量倒着给用户发钱。
func TestSaveAdminPriceRefusesANegativePrice(t *testing.T) {
	svc, _, _ := banHarness(t, nil)
	err := svc.SaveAdminPrice(context.Background(), dto.SavePriceRequest{
		Kind: "llm.chat", Unit: "llm.input_tokens", Price: -1, ProviderShare: 0.7,
	})
	if err == nil {
		t.Fatal("负单价应当被拒")
	}
}
