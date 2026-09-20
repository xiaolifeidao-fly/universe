package galaxy

import (
	"testing"
	"time"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 按模型定价。
//
// 原先整张价目表只按 kind 走：opus 和 haiku 都是 llm.chat，同样一百万 token
// 结给共享者的钱一模一样，而门户上两者标价能差几十倍 —— 平台毛利随使用者
// 调哪个模型漂移，贵模型每跑一次都在亏。下面几条钉的是回落规则本身，
// 因为回落错一档不会报错，只会让某个单位安静地按另一个价收。

// priceRows 造一批已经按仓储顺序排好的行。
//
// 顺序是 (kind, model_id, unit, effective_from) **升序** —— 和 ListEffectivePrices
// 一致（升序才走得上唯一键，见那边的注释）。也就是说同一组里**最后**一条才是
// 最新生效的。写反了用例照样过，但验的是另一回事。
func priceRows(rows ...*repository.GalaxyPrice) []*repository.GalaxyPrice { return rows }

func priceAt(kind, model, unit string, price int64, ago time.Duration) *repository.GalaxyPrice {
	return &repository.GalaxyPrice{
		Kind: kind, ModelID: model, Unit: unit, Price: price, Currency: "CNY",
		ProviderPrice: price / 2, EffectiveFrom: time.Now().Add(-ago),
	}
}

func TestResolvePricesPrefersTheModelRow(t *testing.T) {
	rows := priceRows(
		priceAt("llm.chat", "", "llm.output_tokens", 15_000_000, time.Hour),
		priceAt("llm.chat", "claude-opus-5", "llm.output_tokens", 90_000_000, time.Hour),
	)
	table, own := resolvePrices(rows, "llm.chat", "claude-opus-5")
	if got := table[contract.UnitOutputTokens].Price; got != 90_000_000 {
		t.Fatalf("应当用这个模型自己的价 90,000,000，实际 %d", got)
	}
	if !own[contract.UnitOutputTokens] {
		t.Fatal("这一档是模型自己的，own 该是 true —— 门户靠它区分「统一价」")
	}
}

// 回落是**按单位**的：只给 output 单独定了价，input 仍然走兜底。
// 按行回落（「这个模型有价就整张表用它的」）会让只填了一档的模型把其余几档静默归零。
func TestResolvePricesFallsBackPerUnit(t *testing.T) {
	rows := priceRows(
		priceAt("llm.chat", "", "llm.input_tokens", 3_000_000, time.Hour),
		priceAt("llm.chat", "", "llm.output_tokens", 15_000_000, time.Hour),
		priceAt("llm.chat", "claude-opus-5", "llm.output_tokens", 90_000_000, time.Hour),
	)
	table, own := resolvePrices(rows, "llm.chat", "claude-opus-5")
	if got := table[contract.UnitInputTokens].Price; got != 3_000_000 {
		t.Fatalf("模型没给 input 定价，应当回落到兜底的 3,000,000，实际 %d", got)
	}
	if own[contract.UnitInputTokens] {
		t.Fatal("input 是回落来的，own 该是 false")
	}
	if got := table[contract.UnitOutputTokens].Price; got != 90_000_000 {
		t.Fatalf("output 应当用模型自己的价，实际 %d", got)
	}
}

// 别的模型的价不能漏过来。漏过来是最难发现的一种错：账照记，只是金额是别人的。
func TestResolvePricesIgnoresOtherModels(t *testing.T) {
	rows := priceRows(
		priceAt("llm.chat", "", "llm.output_tokens", 15_000_000, time.Hour),
		priceAt("llm.chat", "claude-opus-5", "llm.output_tokens", 90_000_000, time.Hour),
	)
	table, own := resolvePrices(rows, "llm.chat", "claude-haiku-4-5")
	if got := table[contract.UnitOutputTokens].Price; got != 15_000_000 {
		t.Fatalf("haiku 没单独定价，应当走兜底的 15,000,000，实际 %d", got)
	}
	if own[contract.UnitOutputTokens] {
		t.Fatal("走的是兜底价，own 该是 false")
	}
}

// 模型为空（单元行被清掉、或者这个 kind 本来就不分模型）只认兜底价。
func TestResolvePricesWithoutModelUsesFallbackOnly(t *testing.T) {
	rows := priceRows(
		priceAt("llm.chat", "", "llm.output_tokens", 15_000_000, time.Hour),
		priceAt("llm.chat", "claude-opus-5", "llm.output_tokens", 90_000_000, time.Hour),
	)
	table, own := resolvePrices(rows, "llm.chat", "")
	if got := table[contract.UnitOutputTokens].Price; got != 15_000_000 {
		t.Fatalf("没有模型就只能走兜底价，实际 %d", got)
	}
	if len(own) != 0 {
		t.Fatalf("没有模型就没有「模型自己的价」，实际 %v", own)
	}
}

// 同一 (kind, model, unit) 下取最新生效的那条，模型行和兜底行各自算各自的。
func TestResolvePricesTakesLatestEffectiveRowPerGroup(t *testing.T) {
	rows := priceRows(
		priceAt("llm.chat", "", "llm.output_tokens", 20_000_000, 30*24*time.Hour), // 被取代的历史价
		priceAt("llm.chat", "", "llm.output_tokens", 15_000_000, time.Hour),
		priceAt("llm.chat", "claude-opus-5", "llm.output_tokens", 99_000_000, 30*24*time.Hour),
		priceAt("llm.chat", "claude-opus-5", "llm.output_tokens", 90_000_000, time.Hour),
	)
	if got := mustPrice(t, rows, "llm.chat", "claude-opus-5", contract.UnitOutputTokens); got != 90_000_000 {
		t.Fatalf("模型价应取最新的 90,000,000，实际 %d", got)
	}
	if got := mustPrice(t, rows, "llm.chat", "other", contract.UnitOutputTokens); got != 15_000_000 {
		t.Fatalf("兜底价应取最新的 15,000,000，实际 %d", got)
	}
}

// 别的 kind 的行不能串过来。
func TestResolvePricesIgnoresOtherKinds(t *testing.T) {
	rows := priceRows(priceAt("video.edit.render", "", "llm.output_tokens", 99_000_000, time.Hour))
	table, _ := resolvePrices(rows, "llm.chat", "")
	if len(table) != 0 {
		t.Fatalf("别的 kind 的价不该出现在这张表里，实际 %v", table)
	}
}

func mustPrice(t *testing.T, rows []*repository.GalaxyPrice, kind, model string, unit contract.MeterUnit) int64 {
	t.Helper()
	table, _ := resolvePrices(rows, kind, model)
	row, ok := table[unit]
	if !ok {
		t.Fatalf("%s/%s 查不到 %s 的价", kind, model, unit)
	}
	return row.Price
}

// 「有量无价」的告警只认兜底行。
//
// 模型单独定的价只覆盖它自己。拿它去消掉告警，等于替其余模型宣布了一件没发生的事 ——
// 而那些模型此刻真的在按 0 计费。
func TestMarkLivePricesOnlyCountsFallbackAsPriced(t *testing.T) {
	now := time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)
	views, priced := markLivePrices([]*repository.GalaxyPrice{
		{Kind: "llm.chat", ModelID: "claude-opus-5", Unit: "llm.output_tokens",
			Price: 90_000_000, EffectiveFrom: now.AddDate(0, 0, -1)},
	}, now)

	if !views[0].Effective {
		t.Fatal("模型行到点了也该标成生效中")
	}
	if views[0].ModelID != "claude-opus-5" {
		t.Fatalf("视图要带上模型名，实际 %q", views[0].ModelID)
	}
	if priced[priceKey("llm.chat", "", "llm.output_tokens")] {
		t.Fatal("只有一个模型有价 ≠ 这个单位有价可查，兜底行还缺着")
	}
	unpriced := unpricedFrom([]repository.UsageRow{
		{Kind: "llm.chat", Unit: "llm.output_tokens"},
	}, priced)
	if len(unpriced) != 1 {
		t.Fatalf("它应当还留在「有量无价」里，实际 %v", unpriced)
	}
}

// 门户卡片：回落到模型自己的计价行时，标的就是它真会被收的价，不该再说成「统一价」。
func TestApplyKindPriceKeepsPricedWhenTheRowIsTheModelsOwn(t *testing.T) {
	table := map[contract.MeterUnit]priceRow{
		contract.UnitInputTokens:  {Price: 18_000_000, Currency: "CNY"},
		contract.UnitOutputTokens: {Price: 90_000_000},
	}
	own := map[contract.MeterUnit]bool{
		contract.UnitInputTokens: true, contract.UnitOutputTokens: true,
	}

	model := dto.PortalModelView{}
	applyKindPrice(&model, table, own)
	if !model.Priced {
		t.Fatal("两档都是这个模型自己的计价行，卡片上不该再标「统一价」")
	}
	if model.InputPrice != 18_000_000 || model.OutputPrice != 90_000_000 {
		t.Fatalf("价格没填对：input=%d output=%d", model.InputPrice, model.OutputPrice)
	}

	// 只有一档是模型自己的，另一档还是统一价 —— 那就不能说整份都是专属的。
	half := dto.PortalModelView{}
	applyKindPrice(&half, table, map[contract.MeterUnit]bool{contract.UnitOutputTokens: true})
	if half.Priced {
		t.Fatal("input 走的是兜底价，Priced 该是 false")
	}
}
