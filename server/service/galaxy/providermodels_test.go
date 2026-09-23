package galaxy

import (
	"testing"
	"time"

	"service/galaxy/internal/repository"
)

// 共享端模型页说的数必须是**结算价**。
//
// 这一页最容易出的错不是崩，是把对外价标上去：共享者按它估收益，估出来的
// 是平台的收入；更糟的是他拿这个数和自己账上的积分一比，就知道平台抽了几成 ——
// 而那正是这一页刻意不给的东西。

func providerModelRows() []*repository.GalaxyPrice {
	return priceRows(
		// 兜底价：对外 ¥15，结算 ¥7.5（priceAt 里结算价固定是对外价的一半）
		priceAt("llm.chat", "", "llm.input_tokens", 3_000_000, time.Hour),
		priceAt("llm.chat", "", "llm.output_tokens", 15_000_000, time.Hour),
		// opus 自己的价：对外 ¥90，结算 ¥45
		priceAt("llm.chat", "claude-opus-5", "llm.input_tokens", 18_000_000, time.Hour),
		priceAt("llm.chat", "claude-opus-5", "llm.output_tokens", 90_000_000, time.Hour),
	)
}

func TestProviderModelViewShowsSettlePriceNotRetail(t *testing.T) {
	view := providerModelView(
		&repository.GalaxyModel{ModelID: "claude-opus-5", Kind: "llm.chat"},
		providerModelRows(), nil, nil, nil,
	)
	if view.OutputPrice != 45_000_000 {
		t.Fatalf("应当给结算价 45,000,000，实际 %d", view.OutputPrice)
	}
	if view.OutputPrice == 90_000_000 {
		t.Fatal("这是对外价 —— 共享端不该看到它")
	}
	if view.InputPrice != 9_000_000 {
		t.Fatalf("输入档的结算价应为 9,000,000，实际 %d", view.InputPrice)
	}
	if !view.Priced {
		t.Fatal("两档都是 opus 自己的行，不该说成统一价")
	}
}

// 没单独定价的模型回落到兜底价，而且要说出来 —— 不说的话一屏模型同一个数字，
// 读起来像页面坏了，而它其实是「运营还没给这些模型单独定价」。
func TestProviderModelViewFallsBackAndSaysSo(t *testing.T) {
	view := providerModelView(
		&repository.GalaxyModel{ModelID: "claude-haiku-4-5", Kind: "llm.chat"},
		providerModelRows(), nil, nil, nil,
	)
	if view.OutputPrice != 7_500_000 {
		t.Fatalf("应当回落到兜底的结算价 7,500,000，实际 %d", view.OutputPrice)
	}
	if view.Priced {
		t.Fatal("回落来的价，Priced 该是 false")
	}
}

// providerModelGroups 三个模型各一个分组，够这组用例区分「加入了哪个」。
func providerModelGroups() []*repository.GalaxyModelGroup {
	return []*repository.GalaxyModelGroup{
		{GroupID: "mg_SONNET", ModelID: "claude-sonnet-5", Name: "标准", Listed: true},
		{GroupID: "mg_OPUS", ModelID: "claude-opus-5", Name: "标准", Listed: true},
		{GroupID: "mg_GPT", ModelID: "gpt-5", Name: "标准", Listed: true},
	}
}

// 「主人开放了没有」和「机器上有没有」是两件事。
//
// 合成一个布尔的话，加入了但上游没有的模型会显示成「没开放」，主人就会去改一个
// 本来没错的设置；反过来合成「开放中」又会让他以为在接单，而实际一单都接不到。
func TestProviderModelViewSeparatesAllowedFromAvailable(t *testing.T) {
	contributions := []*repository.GalaxyContribution{{
		GroupsJSON:          `["mg_SONNET","mg_OPUS"]`,
		ModelsAvailableJSON: `["claude-sonnet-5"]`,
	}}
	rows, groups := providerModelRows(), providerModelGroups()

	sonnet := providerModelView(&repository.GalaxyModel{ModelID: "claude-sonnet-5", Kind: "llm.chat"}, rows, groups, contributions, nil)
	if !sonnet.Allowed || !sonnet.Available {
		t.Fatalf("加入了它的分组且机器上有：allowed=%v available=%v", sonnet.Allowed, sonnet.Available)
	}

	opus := providerModelView(&repository.GalaxyModel{ModelID: "claude-opus-5", Kind: "llm.chat"}, rows, groups, contributions, nil)
	if !opus.Allowed {
		t.Fatal("opus 的分组也加入了，该算接单中")
	}
	if opus.Available {
		t.Fatal("上游没报 opus，Available 该是 false —— 这不是设置错了，是机器上没有")
	}

	gpt := providerModelView(&repository.GalaxyModel{ModelID: "gpt-5", Kind: "llm.chat"}, rows, groups, contributions, nil)
	if gpt.Allowed {
		t.Fatal("没加入 gpt-5 的任何分组，不该算接单中")
	}
}

// 多台机器：任意一条贡献加入了它的分组就算接单中。
// 要求「所有贡献都加入」的话，主人新加一台还没配的机器会把整页变成「未接」。
func TestProviderModelViewAllowedIsAnyContribution(t *testing.T) {
	view := providerModelView(
		&repository.GalaxyModel{ModelID: "gpt-5", Kind: "llm.chat"},
		providerModelRows(), providerModelGroups(),
		[]*repository.GalaxyContribution{
			{GroupsJSON: `["mg_SONNET"]`},
			{GroupsJSON: `["mg_GPT"]`},
		},
		nil,
	)
	if !view.Allowed {
		t.Fatal("第二条贡献加入了它的分组，就算接单中")
	}
}

// 「不限分组」的车道（存量贡献，那一列是空的）什么单都接，模型也就都算开放。
func TestProviderModelViewUnrestrictedContributionAllowsEverything(t *testing.T) {
	view := providerModelView(
		&repository.GalaxyModel{ModelID: "gpt-5", Kind: "llm.chat"},
		providerModelRows(), providerModelGroups(),
		[]*repository.GalaxyContribution{{GroupsJSON: ""}},
		nil,
	)
	if !view.GroupsUnrestricted {
		t.Fatal("空名单就是不限分组")
	}
	if !view.Allowed {
		t.Fatal("不限分组的车道接得到 gpt-5 的单，该算开放")
	}
}

// 没有分组在卖的模型，连「不限分组」的车道也接不到它的单 —— 那一页上说成「已开放」
// 就是句空话：使用端根本签不出能调用它的密钥。
func TestProviderModelViewModelWithoutGroupsIsNotAllowed(t *testing.T) {
	view := providerModelView(
		&repository.GalaxyModel{ModelID: "claude-haiku-5", Kind: "llm.chat"},
		providerModelRows(), providerModelGroups(),
		[]*repository.GalaxyContribution{{GroupsJSON: ""}},
		nil,
	)
	if view.Allowed {
		t.Fatal("这个模型一个分组都没上架，不该算接单中")
	}
}

func TestProviderModelViewCarriesEarnings(t *testing.T) {
	view := providerModelView(
		&repository.GalaxyModel{ModelID: "claude-opus-5", Kind: "llm.chat"},
		providerModelRows(), nil, nil,
		map[string]int64{"claude-opus-5": 12_345_678},
	)
	if view.Earned7d != 12_345_678 {
		t.Fatalf("近 7 天收益没带上：%d", view.Earned7d)
	}
}

// ---------- 模型候选 ----------

// 候选项按厂商分组，而且组内顺序跟着目录。
//
// 顺序是有意的：仓储按 sort_order 排过，运营把主推的模型排在前面。
// 在这里重排一次，主人打开下拉看到的第一个就不是平台想推的那个。
func TestModelOptionGroupsKeepCatalogOrder(t *testing.T) {
	groups := modelOptionGroups([]*repository.GalaxyModel{
		{ModelID: "claude-sonnet-5", DisplayName: "Sonnet 5", Family: "claude", Vendor: "anthropic"},
		{ModelID: "gpt-5.6-terra", DisplayName: "GPT-5.6", Family: "gpt", Vendor: "openai"},
		{ModelID: "claude-opus-5", DisplayName: "Opus 5", Family: "claude", Vendor: "anthropic"},
	}, nil, nil)
	if len(groups) != 2 {
		t.Fatalf("两家厂商应当分成两组，实际 %d 组", len(groups))
	}
	if groups[0].Family != "claude" || groups[1].Family != "gpt" {
		t.Fatalf("组的顺序应当按首次出现：%s / %s", groups[0].Family, groups[1].Family)
	}
	if len(groups[0].Models) != 2 || groups[0].Models[0].ModelID != "claude-sonnet-5" {
		t.Fatalf("组内顺序应当跟着目录，实际 %+v", groups[0].Models)
	}
	if groups[0].Models[1].DisplayName != "Opus 5" {
		t.Fatalf("显示名应当原样给出，实际 %q", groups[0].Models[1].DisplayName)
	}
}

// 组名要和贡献视图上的 Category 对得上 —— 前端就是拿那个字段查这张表的。
//
// 两边各写一套的话，relay_claude 那条车道会查不到任何一组，候选项静静地空掉：
// 界面不报错，主人只会以为平台没有模型可选。
func TestModelOptionGroupsCategoryMatchesLane(t *testing.T) {
	groups := modelOptionGroups([]*repository.GalaxyModel{
		{ModelID: "claude-sonnet-5", Family: "claude", Vendor: "anthropic"},
		{ModelID: "gpt-5.6-terra", Family: "gpt", Vendor: "openai"},
	}, nil, nil)
	byCategory := map[string]string{}
	for _, group := range groups {
		byCategory[group.Category] = group.Family
	}
	// 节点报上来的路由键就是这两个，贡献视图按它们算 Category。
	if got := byCategory[usageCategory("", "claude_oauth", "llm.chat")]; got != "claude" {
		t.Fatalf("relay_claude 那条车道应当查到 claude 组，实际 %q", got)
	}
	if got := byCategory[usageCategory("", "codex_chatgpt", "llm.chat")]; got != "gpt" {
		t.Fatalf("relay_codex 那条车道应当查到 gpt 组，实际 %q", got)
	}
}

// 目录里没填厂商的行按模型名推，别把它们堆进「其它」。
//
// 堆进去的后果是这个模型在共享设置里选不到：它不属于任何一条车道认得的那一组，
// 而主人并不知道原因出在运营没填 vendor 那一列。
func TestModelOptionGroupsInferMissingVendor(t *testing.T) {
	groups := modelOptionGroups([]*repository.GalaxyModel{{ModelID: "claude-haiku-4-5"}}, nil, nil)
	if len(groups) != 1 {
		t.Fatalf("应当只有一组，实际 %d", len(groups))
	}
	if groups[0].Family != "claude" || groups[0].Vendor != "anthropic" || groups[0].Category != "claude" {
		t.Fatalf("应当从模型名推出 claude/anthropic，实际 %+v", groups[0])
	}
	if groups[0].Models[0].DisplayName != "claude-haiku-4-5" {
		t.Fatal("目录没填显示名时回落到模型 id —— 界面上不该出现一行空名字")
	}
}

// 候选项带的是**结算价**，不是对外价。
//
// 勾不勾一个分组就是「这一档值不值得我接」的决定，而共享端从来看不到对外价 ——
// 报成对外价的话，共享者会照着一个自己永远拿不到的数做这个决定。
func TestModelOptionGroupsCarrySettlePrice(t *testing.T) {
	groups := modelOptionGroups(
		[]*repository.GalaxyModel{{ModelID: "claude-opus-5", Kind: "llm.chat", Family: "claude", Vendor: "anthropic"}},
		[]*repository.GalaxyModelGroup{
			{GroupID: "mg_OPUS_STD", ModelID: "claude-opus-5", Name: "标准", Listed: true},
			// 下架的分组不进候选：不卖了就不该再让人加入它。
			{GroupID: "mg_OPUS_OLD", ModelID: "claude-opus-5", Name: "旧档", Listed: false},
		},
		providerModelRows(),
	)
	rows := groups[0].Models[0].Groups
	if len(rows) != 1 || rows[0].GroupID != "mg_OPUS_STD" {
		t.Fatalf("只该给上架的那一个分组，实际 %+v", rows)
	}
	// providerModelRows 里 opus 的输出价对外 90，结算是它的一半（priceAt 的约定）。
	if rows[0].OutputPrice != 45_000_000 {
		t.Fatalf("应当给结算价 45,000,000，实际 %d", rows[0].OutputPrice)
	}
}

// 空目录回空切片，不是 nil：nil 序列化出去是 null，前端那一侧要多一处判空。
func TestModelOptionGroupsEmptyCatalog(t *testing.T) {
	groups := modelOptionGroups(nil, nil, nil)
	if groups == nil {
		t.Fatal("空目录也要回空切片")
	}
	if len(groups) != 0 {
		t.Fatalf("空目录不该分出组，实际 %d", len(groups))
	}
}
