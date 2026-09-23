package galaxy

import (
	"testing"
	"time"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// TestPricedNeedsBothOwnPrices 半份价格比没有价格更危险。
//
// 只填了 input 的那一行如果被当成「已定价」，门户就不再标「统一价」，
// Priced 说的是「卡片上这几个数字是不是这个模型专属的」。
//
// 它只看计价表里有没有这个模型自己的那一行 —— 模型目录上曾经也存过四档展示价，
// 那是第二份数据：门户照目录标、账上照计价表扣，对不上时两边都不报错，
// 而访问者看到的是一个他付不到的价。现在目录只管「这个模型是什么」。
//
// 要**输入和输出都是**它自己的行才算数。用 || 的话，只有一档专属的模型会被当成
// 整份都专属，另一档其实是该能力的统一价 —— 半份专属价比没有专属价更误导人。
func TestPricedNeedsBothOwnPrices(t *testing.T) {
	table := map[contract.MeterUnit]priceRow{
		contract.UnitInputTokens:     {Price: 3_000_000, Currency: "CNY"},
		contract.UnitOutputTokens:    {Price: 15_000_000, Currency: "CNY"},
		contract.UnitCacheReadTokens: {Price: 300_000, Currency: "CNY"},
	}

	cases := []struct {
		name       string
		own        map[contract.MeterUnit]int
		wantPriced bool
	}{
		{"两档都是模型自己的行", map[contract.MeterUnit]int{
			contract.UnitInputTokens: priceLayerModel, contract.UnitOutputTokens: priceLayerModel}, true},
		{"只有输入是自己的，输出还是统一价", map[contract.MeterUnit]int{
			contract.UnitInputTokens: priceLayerModel}, false},
		{"只有输出是自己的", map[contract.MeterUnit]int{
			contract.UnitOutputTokens: priceLayerGroup}, false},
		{"整个能力一个统一价", nil, false},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			view := portalModelView(&repository.GalaxyModel{ModelID: "claude-opus-5"})
			applyKindPrice(&view, table, testCase.own)
			if view.Priced != testCase.wantPriced {
				t.Errorf("Priced = %v，期望 %v", view.Priced, testCase.wantPriced)
			}
			// 不管专不专属，卡片上那几个数都得来自计价表：目录已经不供价了，
			// 这里留成 0 就是门户上白着一格。
			if view.OutputPrice != 15_000_000 {
				t.Errorf("OutputPrice = %d，期望从计价表取到 15,000,000", view.OutputPrice)
			}
		})
	}
}

func TestAdminPortalModelViewIncludesRecordID(t *testing.T) {
	row := &repository.GalaxyModel{ID: 42, ModelID: "gpt-5.6-terra", Listed: true}

	publicView := portalModelView(row)
	if publicView.ID != 0 {
		t.Fatalf("公开目录不应带数据库主键，实际 %d", publicView.ID)
	}

	adminView := adminPortalModelView(row)
	if adminView.ID != 42 {
		t.Fatalf("管理目录 ID = %d，期望 42", adminView.ID)
	}
	if adminView.Listed == nil || !*adminView.Listed {
		t.Fatal("管理目录应继续带上下架状态")
	}
}

// TestCacheWriteBothTTLTiersReachTheCard 缓存写入的两档都要到卡片上。
//
// TTL 是调用方在请求体的 cache_control 里自己写的（不写 = 5 分钟），平台既控制不了
// 也预测不了。只标 5 分钟那一档的话，设了 1h 的人按卡片算出来的成本比他真会付的
// 少六成 —— 而那笔钱照收，账单上才露面。
//
// 顺带钉住合计那一档不许漏进来：llm.cache_write_tokens 是 5m + 1h 的和，
// billing 的 derivedUnits 永远不让它进账本，拿它填卡片就是标一个不会被收的价。
func TestCacheWriteBothTTLTiersReachTheCard(t *testing.T) {
	table := map[contract.MeterUnit]priceRow{
		contract.UnitInputTokens:        {Price: 3_000_000, Currency: "CNY"},
		contract.UnitOutputTokens:       {Price: 15_000_000, Currency: "CNY"},
		contract.UnitCacheWrite5mTokens: {Price: 3_750_000, Currency: "CNY"},
		contract.UnitCacheWrite1hTokens: {Price: 6_000_000, Currency: "CNY"},
		// 合计：库里真有这么一行时（运营手填过）也不许被取到。
		contract.UnitCacheWriteTokens: {Price: 9_750_000, Currency: "CNY"},
	}

	view := portalModelView(&repository.GalaxyModel{ModelID: "claude-opus-5"})
	applyKindPrice(&view, table, nil)

	if view.CacheWritePrice != 3_750_000 {
		t.Errorf("CacheWritePrice = %d，期望 5 分钟档的 3,750,000", view.CacheWritePrice)
	}
	if view.CacheWrite1hPrice != 6_000_000 {
		t.Errorf("CacheWrite1hPrice = %d，期望 1 小时档的 6,000,000", view.CacheWrite1hPrice)
	}
}

// TestPortalKindsOnlyCoversWhatIsOnOffer 单价表只列门户上真能用到的能力。

// 价格表里还有 delivery.task 这种没有对外文案、门户上也用不上的能力，
// 摆上去只会让人问「这个怎么用」而我们答不上来。
func TestPortalKindsOnlyCoversWhatIsOnOffer(t *testing.T) {
	models := []dto.PortalModelView{
		{ModelID: "claude-sonnet-5", Kind: "llm.chat"},
		{ModelID: "sora-2", Kind: "video.edit.render"},
	}

	kinds := portalKinds(models)
	if !kinds["llm.chat"] {
		t.Error("模型目录里的 kind 应该在")
	}
	if !kinds["video.edit.render"] {
		t.Error("视频模型的 kind 同样在目录里，应该在")
	}
	if kinds["delivery.task"] {
		t.Error("没有模型指向 delivery.task，不该出现在单价表里")
	}
}

// TestWholeDaysNeverSwallowsAConfiguredWindow 不足一天但大于零的算一天。
//
// 直接向下取整的话，配成 12h 的冻结期会在门户上显示成「先冻结 0 天」——
// 一句读起来像 bug 的承诺，而它其实只是被截断了。
func TestWholeDaysNeverSwallowsAConfiguredWindow(t *testing.T) {
	cases := map[time.Duration]int{
		0:                   0,
		-time.Hour:          0,
		12 * time.Hour:      1,
		24 * time.Hour:      1,
		30 * 24 * time.Hour: 30,
		47 * time.Hour:      1,
	}
	for value, want := range cases {
		if got := wholeDays(value); got != want {
			t.Errorf("wholeDays(%s) = %d，期望 %d", value, got, want)
		}
	}
}

// TestFallbackModelViewsStayFactual 目录表为空时只摊出模型名与推出来的族，
// 上下文长度、标签这些没有出处的东西一律留空 —— 门户上不能出现编的信息。
func TestFallbackModelViewsStayFactual(t *testing.T) {
	views := fallbackModelViews([]string{" claude-opus-5 ", "gpt-5.6-terra", "claude-opus-5", ""})
	if len(views) != 2 {
		t.Fatalf("去重去空之后应剩 2 个，实际 %d", len(views))
	}
	if views[0].ModelID != "claude-opus-5" || views[0].Family != "claude" || views[0].Vendor != "anthropic" {
		t.Errorf("第一个回落条目不对：%+v", views[0])
	}
	if views[1].Family != "gpt" || views[1].Vendor != "openai" {
		t.Errorf("第二个回落条目不对：%+v", views[1])
	}
	for _, view := range views {
		if view.ContextTokens != 0 || len(view.Tags) != 0 || view.Summary != "" || view.Priced {
			t.Errorf("回落条目不该带任何没出处的信息：%+v", view)
		}
	}
}

// TestClipCountsRunesNotBytes varchar 数的是字符，Go 的 len() 数的是字节。
// 按字节截会把一个汉字拦腰砍成半个，然后在「刚好填满」时报 1406。
func TestClipCountsRunesNotBytes(t *testing.T) {
	if got := clip("  张三丰  ", 2); got != "张三" {
		t.Errorf("clip = %q，期望 %q", got, "张三")
	}
	if got := clip("张三", 10); got != "张三" {
		t.Errorf("没超长不该动：%q", got)
	}
}
