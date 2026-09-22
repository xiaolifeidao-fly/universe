package galaxy

import (
	"testing"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 密钥的范围：「这把密钥调不调得动这个模型」。
//
// 请求路径上的 AuthorizeRoute 和拆开的两个判定（kindAllowed / modelAllowed）
// 必须给同一个答案 —— 后者还被别处直接调用，两边分叉就意味着同一把密钥
// 在两个地方被判成不同的结论。

func callerWith(kinds, tiers []string) dto.Caller {
	return dto.Caller{AllowedKinds: kinds, ModelTier: tiers}
}

func TestScopePredicatesAgreeWithAuthorizeRoute(t *testing.T) {
	cases := []struct {
		name         string
		kinds, tiers []string
		kind, model  string
	}{
		{"范围全空就是不限", nil, nil, "llm.chat", "claude-opus-5"},
		{"模型档放行", nil, []string{"claude-opus-5"}, "llm.chat", "claude-opus-5"},
		{"模型档拦下", nil, []string{"claude-haiku-4-5"}, "llm.chat", "claude-opus-5"},
		{"通配放整族", nil, []string{"claude-*"}, "llm.chat", "claude-opus-5"},
		{"能力放行", []string{"llm.chat"}, nil, "llm.chat", "claude-opus-5"},
		{"能力拦下", []string{"llm.chat"}, nil, "video.edit.render", "sora-2"},
		{"限了能力也限了模型", []string{"llm.chat"}, []string{"claude-*"}, "llm.chat", "claude-opus-5"},
		{"模型为空不判模型那道", nil, []string{"claude-opus-5"}, "llm.chat", ""},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			viaRoute := AuthorizeRoute(callerWith(item.kinds, item.tiers),
				contract.RouteKey{Kind: item.kind, Model: item.model}) == nil
			viaPredicates := kindAllowed(item.kinds, item.kind) && modelAllowed(item.tiers, item.model)
			if viaRoute != viaPredicates {
				t.Fatalf("两处答案不一致：请求路径 %v，下单检查 %v", viaRoute, viaPredicates)
			}
		})
	}
}

// 钉住模型档这一道的两个方向，连同「范围不限」的默认。
func TestModelAllowedHonoursTheKeysScope(t *testing.T) {
	haikuOnly := []string{"claude-haiku-4-5"}
	if modelAllowed(haikuOnly, "claude-opus-5") {
		t.Fatal("只允许 Haiku 的密钥不该调得动 Opus")
	}
	if !modelAllowed(haikuOnly, "claude-haiku-4-5") {
		t.Fatal("它自己的模型当然要放行")
	}
	// 范围不限的老密钥照旧什么都能收 —— 这一层不该顺手收紧存量密钥。
	if !modelAllowed(nil, "claude-opus-5") {
		t.Fatal("没设范围的密钥不该被这一道拦住")
	}
}

// 共享端模型卡上的「缓存写入」取 5 分钟那一档。
//
// 原先取的是合计（llm.cache_write_tokens）—— 那个单位永远不进账本，价目表里
// 通常压根没有它的价，于是这一格恒为 0：共享者看到「缓存写入 0 积分」，
// 以为跑缓存白干，而他实际是按 5m / 1h 两档分别拿钱的。
func TestProviderModelCacheWritePriceComesFromTheRealBucket(t *testing.T) {
	rows := []*repository.GalaxyPrice{
		priceAt("llm.chat", "claude-opus-5", contract.UnitInputTokens, 18_000_000, 0),
		priceAt("llm.chat", "claude-opus-5", contract.UnitOutputTokens, 90_000_000, 0),
		priceAt("llm.chat", "claude-opus-5", contract.UnitCacheWrite5mTokens, 22_500_000, 0),
	}
	view := providerModelView(&repository.GalaxyModel{ModelID: "claude-opus-5", Kind: "llm.chat"}, rows, nil, nil, map[string]int64{})
	// priceAt 的结算价是对外价的一半。
	if view.CacheWritePrice != 11_250_000 {
		t.Fatalf("缓存写入应当按 5 分钟那一档的结算价 11,250,000，实际 %d", view.CacheWritePrice)
	}
	if view.OutputPrice != 45_000_000 {
		t.Fatalf("输出价应当是 45,000,000，实际 %d", view.OutputPrice)
	}
}
