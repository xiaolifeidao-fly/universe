package galaxy

import (
	"context"
	"testing"
	"time"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 按推理强度定价。
//
// 同一个模型，max 档一次请求烧掉的推理 token 比 low 档多一个量级，而它们全部落在
// output 这一个桶里 —— 不分档的话，深思考的请求每跑一次平台都在亏，浅思考的又收贵了。
//
// 下面几条钉的是**回落规则本身**：回落错一层不会报错，只会让某一档安静地按另一个价收，
// 而那笔钱两头（使用者扣多少、共享者结多少）会一起错。

// 四层由粗到细，越具体越晚盖：
//
//	1  (model='', effort='')   kind 兜底
//	2  (model='', effort=E)    这一档的通价
//	3  (model=M,  effort='')   这个模型不分强度
//	4  (model=M,  effort=E)    这个模型这一档
func TestResolvePricesPrefersTheModelEffortRow(t *testing.T) {
	rows := priceRows(
		priceAt("llm.chat", "", "llm.output_tokens", 15_000_000, time.Hour),
		priceAtEffort("llm.chat", "", "max", "llm.output_tokens", 30_000_000, time.Hour),
		priceAt("llm.chat", "claude-opus-5", "llm.output_tokens", 90_000_000, time.Hour),
		priceAtEffort("llm.chat", "claude-opus-5", "max", "llm.output_tokens", 180_000_000, time.Hour),
	)
	table, own := resolvePrices(rows, "llm.chat", "claude-opus-5", contract.EffortMax)
	if got := table[contract.UnitOutputTokens].Price; got != 180_000_000 {
		t.Fatalf("最具体的那一层该赢，期望 180,000,000，实际 %d", got)
	}
	if !own[contract.UnitOutputTokens] {
		t.Fatal("模型 × 强度那一行也是「这个模型自己的价」，own 该是 true")
	}
}

// 没给这个模型的这一档定价时，落到这个模型不分强度的价 —— 而不是落到「这一档的通价」。
// 模型比强度更具体：一个模型的专属价被隔壁一条「所有模型的 max 档加价」盖掉，
// 就是拿别人的价去收这个模型的钱。
func TestResolvePricesModelBeatsEffortWideRow(t *testing.T) {
	rows := priceRows(
		priceAt("llm.chat", "", "llm.output_tokens", 15_000_000, time.Hour),
		priceAtEffort("llm.chat", "", "max", "llm.output_tokens", 30_000_000, time.Hour),
		priceAt("llm.chat", "claude-opus-5", "llm.output_tokens", 90_000_000, time.Hour),
	)
	table, _ := resolvePrices(rows, "llm.chat", "claude-opus-5", contract.EffortMax)
	if got := table[contract.UnitOutputTokens].Price; got != 90_000_000 {
		t.Fatalf("模型专属价比强度通价更具体，期望 90,000,000，实际 %d", got)
	}
}

// 强度通价只在这个模型自己没定价时起作用。
func TestResolvePricesUsesEffortWideRowWhenModelHasNone(t *testing.T) {
	rows := priceRows(
		priceAt("llm.chat", "", "llm.output_tokens", 15_000_000, time.Hour),
		priceAtEffort("llm.chat", "", "max", "llm.output_tokens", 30_000_000, time.Hour),
	)
	table, own := resolvePrices(rows, "llm.chat", "claude-sonnet-5", contract.EffortMax)
	if got := table[contract.UnitOutputTokens].Price; got != 30_000_000 {
		t.Fatalf("该走这一档的通价 30,000,000，实际 %d", got)
	}
	if own[contract.UnitOutputTokens] {
		t.Fatal("强度通价是全模型共享的，算不上这个模型专属，own 该是 false")
	}
}

// 别的档的价不能串过来。这是最容易出错、也最贵的一种：
// 把 max 档的价收到 low 档头上，使用者每一笔都被多扣。
func TestResolvePricesIgnoresOtherEfforts(t *testing.T) {
	rows := priceRows(
		priceAt("llm.chat", "claude-opus-5", "llm.output_tokens", 90_000_000, time.Hour),
		priceAtEffort("llm.chat", "claude-opus-5", "max", "llm.output_tokens", 180_000_000, time.Hour),
	)
	table, _ := resolvePrices(rows, "llm.chat", "claude-opus-5", contract.EffortLow)
	if got := table[contract.UnitOutputTokens].Price; got != 90_000_000 {
		t.Fatalf("low 档没单独定价，该回落到模型的不分强度价 90,000,000，实际 %d", got)
	}
}

// 回落是**按单位**的，强度这一维也一样：只给 max 档的 output 定了价，
// input 仍然走模型的不分强度价。找到一层就停会让那一档静默归零。
func TestResolvePricesFallsBackPerUnitAcrossEfforts(t *testing.T) {
	rows := priceRows(
		priceAt("llm.chat", "claude-opus-5", "llm.input_tokens", 5_000_000, time.Hour),
		priceAt("llm.chat", "claude-opus-5", "llm.output_tokens", 90_000_000, time.Hour),
		priceAtEffort("llm.chat", "claude-opus-5", "max", "llm.output_tokens", 180_000_000, time.Hour),
	)
	table, _ := resolvePrices(rows, "llm.chat", "claude-opus-5", contract.EffortMax)
	if got := table[contract.UnitInputTokens].Price; got != 5_000_000 {
		t.Fatalf("max 档没给 input 定价，该回落到 5,000,000，实际 %d", got)
	}
	if got := table[contract.UnitOutputTokens].Price; got != 180_000_000 {
		t.Fatalf("output 有 max 档的价，该用 180,000,000，实际 %d", got)
	}
}

// 一行带强度的价都没有时，取价的结果必须和加这一维之前**逐位相同**。
// 存量库跑完迁移之后就是这个状态，行为不能有任何变化。
func TestResolvePricesUnchangedWhenNoEffortRows(t *testing.T) {
	rows := priceRows(
		priceAt("llm.chat", "", "llm.input_tokens", 3_000_000, time.Hour),
		priceAt("llm.chat", "claude-opus-5", "llm.output_tokens", 90_000_000, time.Hour),
	)
	withEffort, _ := resolvePrices(rows, "llm.chat", "claude-opus-5", contract.EffortXHigh)
	without, _ := resolvePrices(rows, "llm.chat", "claude-opus-5", "")
	if len(withEffort) != len(without) {
		t.Fatalf("没有强度行时两次取价该一样，%v ≠ %v", withEffort, without)
	}
	for unit, row := range without {
		if withEffort[unit].Price != row.Price {
			t.Fatalf("%s 的价不一致：带强度 %d，不带 %d", unit, withEffort[unit].Price, row.Price)
		}
	}
}

// 模型页那份「按强度分档」的清单只列**真的单独定过价**的档。
// 把词表里六档一律列出来，回落之后每一档都等于卡片上那几个数，一屏重复的数字
// 既说不清「按强度分档收费」，也说不清「不分档」。
func TestPricedEffortsListsOnlyRowsThatExist(t *testing.T) {
	rows := priceRows(
		priceAt("llm.chat", "claude-opus-5", "llm.output_tokens", 90_000_000, time.Hour),
		priceAtEffort("llm.chat", "claude-opus-5", "max", "llm.output_tokens", 180_000_000, time.Hour),
		priceAtEffort("llm.chat", "", "low", "llm.output_tokens", 8_000_000, time.Hour),
		// 别的模型的强度行不能串进来。
		priceAtEffort("llm.chat", "claude-haiku-4-5", "xhigh", "llm.output_tokens", 1, time.Hour),
	)
	got := pricedEfforts(rows, "llm.chat", "claude-opus-5", contract.FamilyAnthropic)
	want := []contract.Effort{contract.EffortLow, contract.EffortMax}
	if len(got) != len(want) {
		t.Fatalf("期望 %v，实际 %v", want, got)
	}
	// 顺序按词表由浅到深：界面上「越深越贵」要一眼看得出来。
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("顺序该是由浅到深 %v，实际 %v", want, got)
		}
	}
	if len(pricedEfforts(rows, "llm.chat", "claude-sonnet-5", contract.FamilyAnthropic)) != 1 {
		t.Fatal("没有自己的强度行时，仍然该看得见兜底那一档（low）")
	}
}

// 词表里没有的档（历史上填错、或上游加了新档而我们还没跟上）排在最后，不丢。
// 丢掉它会让运营看着库里有价、页面上没有，而那种不一致没有任何地方会报错。
func TestPricedEffortsKeepsUnknownLevels(t *testing.T) {
	rows := priceRows(
		priceAtEffort("llm.chat", "claude-opus-5", "max", "llm.output_tokens", 180_000_000, time.Hour),
		priceAtEffort("llm.chat", "claude-opus-5", "ludicrous", "llm.output_tokens", 999, time.Hour),
	)
	got := pricedEfforts(rows, "llm.chat", "claude-opus-5", contract.FamilyAnthropic)
	if len(got) != 2 || got[0] != contract.EffortMax || got[1] != "ludicrous" {
		t.Fatalf("认识的档在前、不认识的在后，期望 [max ludicrous]，实际 %v", got)
	}
}

// 档位名是一个封闭小词表，填错了不报错、也匹配不上任何一次请求 ——
// 那行价会永远躺在表里，而运营以为自己给 max 档加过价。所以保存时要拦。
func TestSaveAdminPriceRejectsUnknownEffort(t *testing.T) {
	svc, _, _ := banHarness(t, nil)
	for _, effort := range []string{"medium-high", "persistent", "ultracode", "思考"} {
		err := svc.SaveAdminPrice(context.Background(), dto.SavePriceRequest{
			Kind: "llm.chat", Unit: "llm.input_tokens", Effort: effort, Price: 3_000_000,
		})
		if err == nil {
			t.Fatalf("编出来的档 %q 应当被拒 —— 它匹配不上任何一次请求", effort)
		}
	}
	// 两族真实存在的档都要放过，包括只有一族有的那几个。
	for _, effort := range []string{"", contract.EffortMinimal, contract.EffortXHigh, contract.EffortNone, contract.EffortUltra} {
		if err := svc.SaveAdminPrice(context.Background(), dto.SavePriceRequest{
			Kind: "llm.chat", Unit: "llm.input_tokens", Effort: effort, Price: 3_000_000,
		}); err != nil {
			t.Fatalf("%q 是上游真实存在的档，不该被拦：%v", effort, err)
		}
	}
}

// 大小写在保存时收敛。请求体里发过来的永远是小写，运营在表单上敲一个 "High"
// 如果原样入库，这行价就再也匹配不上任何一次请求 —— 和填错一个档没有区别。
func TestSaveAdminPriceNormalisesEffortCase(t *testing.T) {
	svc, _, _ := banHarness(t, nil)
	if err := svc.SaveAdminPrice(context.Background(), dto.SavePriceRequest{
		Kind: "llm.chat", Unit: "llm.input_tokens", Effort: " High ", Price: 3_000_000,
	}); err != nil {
		t.Fatalf("大小写和空白不该让整条保存失败：%v", err)
	}
}

// 兜底行（effort 为空）才算「这个单位有价可查」。
// 只给 max 档定了价，其余几档此刻真的在按 0 计费 —— 告警不能被它消掉。
func TestMarkLivePricesEffortRowIsNotFallback(t *testing.T) {
	now := time.Date(2026, 9, 20, 12, 0, 0, 0, time.UTC)
	views, priced := markLivePrices([]*repository.GalaxyPrice{
		{Kind: "llm.chat", Effort: "max", Unit: "llm.output_tokens",
			Price: 180_000_000, EffectiveFrom: now.AddDate(0, 0, -1)},
	}, now)
	if views[0].Effort != "max" {
		t.Fatalf("视图要带上强度，实际 %q", views[0].Effort)
	}
	if priced[priceKey("llm.chat", "", "", "llm.output_tokens")] {
		t.Fatal("只有 max 档有价 ≠ 这个单位有价可查，兜底行还缺着")
	}
}
