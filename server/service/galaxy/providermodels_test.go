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
		providerModelRows(), nil, nil,
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
		providerModelRows(), nil, nil,
	)
	if view.OutputPrice != 7_500_000 {
		t.Fatalf("应当回落到兜底的结算价 7,500,000，实际 %d", view.OutputPrice)
	}
	if view.Priced {
		t.Fatal("回落来的价，Priced 该是 false")
	}
}

// 「名单放不放它过」和「机器上有没有」是两件事。
//
// 合成一个布尔的话，允许了但上游没有的模型会显示成「没开放」，主人就会去改一个
// 本来没错的设置；反过来合成「开放中」又会让他以为在接单，而实际一单都接不到。
func TestProviderModelViewSeparatesAllowedFromAvailable(t *testing.T) {
	contributions := []*repository.GalaxyContribution{{
		ModelsAllowJSON:     `["claude-*"]`,
		ModelsAvailableJSON: `["claude-sonnet-5"]`,
	}}
	rows := providerModelRows()

	sonnet := providerModelView(&repository.GalaxyModel{ModelID: "claude-sonnet-5", Kind: "llm.chat"}, rows, contributions, nil)
	if !sonnet.Allowed || !sonnet.Available {
		t.Fatalf("名单放过且机器上有：allowed=%v available=%v", sonnet.Allowed, sonnet.Available)
	}

	opus := providerModelView(&repository.GalaxyModel{ModelID: "claude-opus-5", Kind: "llm.chat"}, rows, contributions, nil)
	if !opus.Allowed {
		t.Fatal("claude-* 通配应当放 opus 过")
	}
	if opus.Available {
		t.Fatal("上游没报 opus，Available 该是 false —— 这不是设置错了，是机器上没有")
	}

	gpt := providerModelView(&repository.GalaxyModel{ModelID: "gpt-5", Kind: "llm.chat"}, rows, contributions, nil)
	if gpt.Allowed {
		t.Fatal("白名单只写了 claude-*，gpt-5 不该算接单中")
	}
}

// 多台机器：任意一条贡献放它过就算接单中。
// 要求「所有贡献都放过」的话，主人新加一台还没配的机器会把整页变成「未接」。
func TestProviderModelViewAllowedIsAnyContribution(t *testing.T) {
	view := providerModelView(
		&repository.GalaxyModel{ModelID: "gpt-5", Kind: "llm.chat"},
		providerModelRows(),
		[]*repository.GalaxyContribution{
			{ModelsAllowJSON: `["claude-*"]`},
			{ModelsAllowJSON: `["gpt-*"]`},
		},
		nil,
	)
	if !view.Allowed {
		t.Fatal("第二条贡献放它过，就算接单中")
	}
}

// 拒绝名单优先于允许名单：两边都写了同一个模型时，结论是不接。
func TestProviderModelViewDenyBeatsAllow(t *testing.T) {
	view := providerModelView(
		&repository.GalaxyModel{ModelID: "claude-opus-5", Kind: "llm.chat"},
		providerModelRows(),
		[]*repository.GalaxyContribution{{
			ModelsAllowJSON: `["claude-*"]`,
			ModelsDenyJSON:  `["claude-opus-*"]`,
		}},
		nil,
	)
	if view.Allowed {
		t.Fatal("拒绝名单点了名，就不该算接单中")
	}
}

func TestProviderModelViewCarriesEarnings(t *testing.T) {
	view := providerModelView(
		&repository.GalaxyModel{ModelID: "claude-opus-5", Kind: "llm.chat"},
		providerModelRows(), nil,
		map[string]int64{"claude-opus-5": 12_345_678},
	)
	if view.Earned7d != 12_345_678 {
		t.Fatalf("近 7 天收益没带上：%d", view.Earned7d)
	}
}
