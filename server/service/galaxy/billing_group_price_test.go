package galaxy

import (
	"context"
	"testing"
	"time"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 按**模型分组**定价（2026-09-22 起）。
//
// 分组取代了原先的「推理强度」那一维：价挂在分组上，强度与快速变成分组的属性。
// 下面几条钉的是**回落规则本身**：回落错一层不会报错，只会让某个分组安静地按
// 另一个价收，而那笔钱两头（使用者扣多少、共享者结多少）会一起错。

// 三层由粗到细，越具体越晚盖：
//
//	0  (model='', group='')   kind 兜底
//	1  (model=M,  group='')   这个模型的通价
//	2  (model=M,  group=G)    这个分组的价
func TestResolvePricesPrefersTheGroupRow(t *testing.T) {
	rows := priceRows(
		priceAt("llm.chat", "", "llm.output_tokens", 15_000_000, time.Hour),
		priceAt("llm.chat", "claude-opus-5", "llm.output_tokens", 90_000_000, time.Hour),
		priceAtGroup("llm.chat", "claude-opus-5", "mg_DEEP", "llm.output_tokens", 180_000_000, time.Hour),
	)
	table, at := resolvePrices(rows, "llm.chat", "claude-opus-5", "mg_DEEP")
	if got := table[contract.UnitOutputTokens].Price; got != 180_000_000 {
		t.Fatalf("最具体的那一层该赢，期望 180,000,000，实际 %d", got)
	}
	if at[contract.UnitOutputTokens] != priceLayerGroup {
		t.Fatalf("这一档该落在分组层，实际第 %d 层", at[contract.UnitOutputTokens])
	}
}

// 分组没单独定价时落到这个模型的通价 —— 这正是「标准」分组的常态：
// 建了分组但不必给它填一份重复的价。
func TestResolvePricesFallsBackToModelWideRow(t *testing.T) {
	rows := priceRows(
		priceAt("llm.chat", "", "llm.output_tokens", 15_000_000, time.Hour),
		priceAt("llm.chat", "claude-opus-5", "llm.output_tokens", 90_000_000, time.Hour),
	)
	table, at := resolvePrices(rows, "llm.chat", "claude-opus-5", "mg_STANDARD")
	if got := table[contract.UnitOutputTokens].Price; got != 90_000_000 {
		t.Fatalf("该走模型通价 90,000,000，实际 %d", got)
	}
	if at[contract.UnitOutputTokens] != priceLayerModel {
		t.Fatalf("该停在模型层，实际第 %d 层", at[contract.UnitOutputTokens])
	}
}

// 别的分组的价不能串过来。这是最容易出错、也最贵的一种：
// 把「深度」的价收到「标准」头上，使用者每一笔都被多扣。
func TestResolvePricesIgnoresOtherGroups(t *testing.T) {
	rows := priceRows(
		priceAt("llm.chat", "claude-opus-5", "llm.output_tokens", 90_000_000, time.Hour),
		priceAtGroup("llm.chat", "claude-opus-5", "mg_DEEP", "llm.output_tokens", 180_000_000, time.Hour),
	)
	table, _ := resolvePrices(rows, "llm.chat", "claude-opus-5", "mg_STANDARD")
	if got := table[contract.UnitOutputTokens].Price; got != 90_000_000 {
		t.Fatalf("标准分组没单独定价，该回落到模型通价 90,000,000，实际 %d", got)
	}
}

// 回落是**按单位**的，分组这一维也一样：只给某个分组的 output 定了价，
// input 仍然走模型通价。找到一层就停会让那一档静默归零。
func TestResolvePricesFallsBackPerUnitAcrossGroups(t *testing.T) {
	rows := priceRows(
		priceAt("llm.chat", "claude-opus-5", "llm.input_tokens", 5_000_000, time.Hour),
		priceAt("llm.chat", "claude-opus-5", "llm.output_tokens", 90_000_000, time.Hour),
		priceAtGroup("llm.chat", "claude-opus-5", "mg_DEEP", "llm.output_tokens", 180_000_000, time.Hour),
	)
	table, _ := resolvePrices(rows, "llm.chat", "claude-opus-5", "mg_DEEP")
	if got := table[contract.UnitInputTokens].Price; got != 5_000_000 {
		t.Fatalf("分组没给 input 定价，该回落到 5,000,000，实际 %d", got)
	}
	if got := table[contract.UnitOutputTokens].Price; got != 180_000_000 {
		t.Fatalf("output 有分组价，该用 180,000,000，实际 %d", got)
	}
}

// 不属于任何模型的分组行（model 为空、group 非空）一律忽略。
//
// 迁移把这种行删干净了，保存接口也拦着 —— 但库是长久的，真躺下一行时，
// 让它落到「所有模型的这个分组」上，就是拿一个谁也说不清归属的价去收钱。
func TestResolvePricesIgnoresGroupRowWithoutModel(t *testing.T) {
	rows := priceRows(
		priceAt("llm.chat", "", "llm.output_tokens", 15_000_000, time.Hour),
		priceAtGroup("llm.chat", "", "mg_DEEP", "llm.output_tokens", 999_000_000, time.Hour),
	)
	table, _ := resolvePrices(rows, "llm.chat", "claude-opus-5", "mg_DEEP")
	if got := table[contract.UnitOutputTokens].Price; got != 15_000_000 {
		t.Fatalf("无主的分组行该被忽略，期望兜底价 15,000,000，实际 %d", got)
	}
}

// 一行带分组的价都没有时，取价的结果必须和加这一维之前**逐位相同**。
// 存量库跑完迁移之后就是这个状态，行为不能有任何变化。
func TestResolvePricesUnchangedWhenNoGroupRows(t *testing.T) {
	rows := priceRows(
		priceAt("llm.chat", "", "llm.input_tokens", 3_000_000, time.Hour),
		priceAt("llm.chat", "claude-opus-5", "llm.output_tokens", 90_000_000, time.Hour),
	)
	withGroup, _ := resolvePrices(rows, "llm.chat", "claude-opus-5", "mg_ANY")
	without, _ := resolvePrices(rows, "llm.chat", "claude-opus-5", "")
	if len(withGroup) != len(without) {
		t.Fatalf("没有分组行时两次取价该一样，%v ≠ %v", withGroup, without)
	}
	for unit, row := range without {
		if withGroup[unit].Price != row.Price {
			t.Fatalf("%s 的价不一致：带分组 %d，不带 %d", unit, withGroup[unit].Price, row.Price)
		}
	}
}

// 兜底行（model 与 group 都为空）才算「这个单位有价可查」。
// 只给某个分组定了价，其余分组此刻真的在按 0 计费 —— 告警不能被它消掉。
func TestMarkLivePricesGroupRowIsNotFallback(t *testing.T) {
	now := time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)
	views, priced := markLivePrices([]*repository.GalaxyPrice{
		{Kind: "llm.chat", ModelID: "claude-opus-5", GroupID: "mg_DEEP", Unit: "llm.output_tokens",
			Price: 180_000_000, EffectiveFrom: now.AddDate(0, 0, -1)},
	}, now)
	if views[0].GroupID != "mg_DEEP" {
		t.Fatalf("视图要带上分组，实际 %q", views[0].GroupID)
	}
	if priced[priceKey("llm.chat", "", "", "llm.output_tokens")] {
		t.Fatal("只有一个分组有价 ≠ 这个单位有价可查，兜底行还缺着")
	}
}

// 分组 id 填错、或者指向别的模型底下的分组，都会让这行价永远匹配不上任何请求 ——
// 而运营以为自己给「深度」加过价。保存时要当场拦下来。
func TestSaveAdminPriceRejectsUnknownGroup(t *testing.T) {
	svc, _, _ := banHarness(t, nil)
	ctx := context.Background()
	err := svc.SaveAdminPrice(ctx, dto.SavePriceRequest{
		Kind: "llm.chat", ModelID: "claude-opus-5", GroupID: "mg_NOPE",
		Unit: "llm.input_tokens", Price: 3_000_000,
	})
	if err == nil {
		t.Fatal("不存在的分组应当被拒 —— 它匹配不上任何一次请求")
	}
	// 不带分组的兜底价与模型通价照旧能存。
	for _, model := range []string{"", "claude-opus-5"} {
		if err := svc.SaveAdminPrice(ctx, dto.SavePriceRequest{
			Kind: "llm.chat", ModelID: model, Unit: "llm.input_tokens", Price: 3_000_000,
		}); err != nil {
			t.Fatalf("模型 %q 的通价不该被拦：%v", model, err)
		}
	}
}
