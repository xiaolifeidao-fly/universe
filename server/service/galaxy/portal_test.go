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
// 而 output 那格显示的其实是 kind 的通用价 —— 访问者会把它读成这个模型的真实输出价。
func TestPricedNeedsBothOwnPrices(t *testing.T) {
	table := map[contract.MeterUnit]priceRow{
		contract.UnitInputTokens:     {Price: 3_000_000, Currency: "CNY"},
		contract.UnitOutputTokens:    {Price: 15_000_000, Currency: "CNY"},
		contract.UnitCacheReadTokens: {Price: 300_000, Currency: "CNY"},
	}

	cases := []struct {
		name        string
		input       int64
		output      int64
		wantPriced  bool
		wantOutputs int64
	}{
		{"两项都填了才算自己的价", 14_800_000, 88_800_000, true, 88_800_000},
		{"只填了输入价，仍然算统一价", 14_800_000, 0, false, 15_000_000},
		{"只填了输出价，仍然算统一价", 0, 88_800_000, false, 88_800_000},
		{"一项都没填", 0, 0, false, 15_000_000},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			view := portalModelView(&repository.GalaxyModel{
				ModelID: "claude-opus-5", InputPrice: testCase.input, OutputPrice: testCase.output,
			})
			applyKindPrice(&view, table, nil)
			if view.Priced != testCase.wantPriced {
				t.Errorf("Priced = %v，期望 %v", view.Priced, testCase.wantPriced)
			}
			if view.OutputPrice != testCase.wantOutputs {
				t.Errorf("OutputPrice = %d，期望 %d", view.OutputPrice, testCase.wantOutputs)
			}
		})
	}
}

// TestPortalKindsOnlyCoversWhatIsForSale 单价表只列门户上真能买到的能力。
//
// 价格表里还有 delivery.task 这种没有对外文案、门户上也买不到的能力，
// 摆上去只会让人问「这个怎么用」而我们答不上来。
func TestPortalKindsOnlyCoversWhatIsForSale(t *testing.T) {
	models := []dto.PortalModelView{{ModelID: "claude-sonnet-5", Kind: "llm.chat"}}
	packages := []dto.PackageView{
		{PackageCode: "starter"}, // 不限，不贡献 kind
		{PackageCode: "video", AllowedKinds: []string{"video.edit.render"}}, // 显式允许
	}

	kinds := portalKinds(models, packages)
	if !kinds["llm.chat"] {
		t.Error("模型目录里的 kind 应该在")
	}
	if !kinds["video.edit.render"] {
		t.Error("上架商品显式允许的 kind 应该在")
	}
	if kinds["delivery.task"] {
		t.Error("没有模型也没有商品指向 delivery.task，不该出现在单价表里")
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
