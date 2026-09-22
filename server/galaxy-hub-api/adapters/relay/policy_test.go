package relay

import (
	"encoding/json"
	"testing"

	"contract"
	corepkg "galaxy-hub-api/adapters/core"
)

// 分组把强度与快速夹到它卖的范围内，并**真的改写请求体**。
//
// 只改记账不改字节是最贵的一种错：上游照着请求体里那一档跑（烧的是深档的 token），
// 平台按分组卖的浅档收钱，差额全由平台垫，而且两边都不报错 —— 对账也看不出来，
// 因为两头记的是同一个（错的）档。所以下面每一条都同时验「算出来的值」和「字节」。

func fieldOf(t *testing.T, raw []byte, path ...string) any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("请求体不是合法 JSON：%v", err)
	}
	var current any = payload
	for _, key := range path {
		object, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		current = object[key]
	}
	return current
}

// Claude：要的档不在分组里 → 夹到分组里**最浅**的那一档，并改写 output_config.effort。
func TestApplyPolicyClampsAnthropicEffort(t *testing.T) {
	adapter := New(nil, Options{})
	parsed := parseBody(t, "/v1/messages", `{"model":"claude-opus-5","output_config":{"effort":"max"},"metadata":{"user":"u1"}}`)
	policy := contract.GroupPolicy{
		GroupID: "mg_STD", Family: contract.FamilyAnthropic,
		// 故意不按由浅到深给：最浅的一档要按词表判，不是按数组顺序。
		Efforts: []contract.Effort{contract.EffortHigh, contract.EffortMedium},
	}
	effort, fast := adapter.ApplyPolicy(parsed, policy)
	if effort != contract.EffortMedium {
		t.Fatalf("该夹到分组里最浅的 medium，实际 %q", effort)
	}
	if fast {
		t.Fatal("请求没要快速，夹完也不该变成快速")
	}
	if got := fieldOf(t, parsed.body, "output_config", "effort"); got != "medium" {
		t.Fatalf("请求体要被改写成 medium，实际 %v", got)
	}
	// 其余字节原样保留：这条通道对请求体的承诺是「只改该改的那个字段」。
	if got := fieldOf(t, parsed.body, "metadata", "user"); got != "u1" {
		t.Fatalf("不相干的字段被改动了：%v", got)
	}
}

// 老模型（只有 thinking.budget_tokens）夹档要改**预算**，不是塞一个它不认识的 output_config。
//
// 塞 output_config 的后果：上游原样忽略，照旧按 31999 的预算深想一遍，
// 而平台按 low 收钱 —— 正是这条改写要防的那件事。
func TestApplyPolicyClampsBudgetBackToBudget(t *testing.T) {
	adapter := New(nil, Options{})
	parsed := parseBody(t, "/v1/messages", `{"model":"claude-haiku-4-5","thinking":{"type":"enabled","budget_tokens":31999}}`)
	if parsed.effort != contract.EffortHigh {
		t.Fatalf("预算 31999 该折成 high，实际 %q", parsed.effort)
	}
	policy := contract.GroupPolicy{GroupID: "mg_STD", Family: contract.FamilyAnthropic, Efforts: []contract.Effort{contract.EffortLow}}
	if effort, _ := adapter.ApplyPolicy(parsed, policy); effort != contract.EffortLow {
		t.Fatalf("该夹到 low，实际 %q", effort)
	}
	if got := fieldOf(t, parsed.body, "thinking", "budget_tokens"); got != float64(4000) {
		t.Fatalf("要改回老式预算 4000，实际 %v", got)
	}
	if got := fieldOf(t, parsed.body, "thinking", "type"); got != "enabled" {
		t.Fatalf("thinking 里别的字段要原样留着，实际 %v", got)
	}
	if fieldOf(t, parsed.body, "output_config") != nil {
		t.Fatal("老模型不认 output_config，不该给它塞一个")
	}
}

// Codex：改的是 reasoning.effort。
func TestApplyPolicyClampsOpenAIEffort(t *testing.T) {
	adapter := New(nil, Options{})
	parsed := parseBody(t, "/v1/responses", `{"model":"gpt-5.6-terra","reasoning":{"effort":"high","summary":"auto"}}`)
	policy := contract.GroupPolicy{GroupID: "mg_STD", Family: contract.FamilyOpenAI, Efforts: []contract.Effort{contract.EffortMinimal, contract.EffortLow}}
	if effort, _ := adapter.ApplyPolicy(parsed, policy); effort != contract.EffortMinimal {
		t.Fatalf("该夹到 minimal，实际 %q", effort)
	}
	if got := fieldOf(t, parsed.body, "reasoning", "effort"); got != "minimal" {
		t.Fatalf("请求体要被改写成 minimal，实际 %v", got)
	}
	if got := fieldOf(t, parsed.body, "reasoning", "summary"); got != "auto" {
		t.Fatalf("reasoning 里别的字段要原样留着，实际 %v", got)
	}
}

// 档在分组里就一个字节都不动。夹是例外，不是每次请求都要走一遍的改写。
func TestApplyPolicyLeavesAllowedEffortAlone(t *testing.T) {
	adapter := New(nil, Options{})
	body := `{"model":"claude-opus-5","output_config":{"effort":"high"}}`
	parsed := parseBody(t, "/v1/messages", body)
	policy := contract.GroupPolicy{GroupID: "mg_DEEP", Family: contract.FamilyAnthropic, AllowFast: true,
		Efforts: []contract.Effort{contract.EffortHigh, contract.EffortMax}}
	effort, _ := adapter.ApplyPolicy(parsed, policy)
	if effort != contract.EffortHigh {
		t.Fatalf("这一档分组卖，不该动，实际 %q", effort)
	}
	if string(parsed.body) != body {
		t.Fatalf("请求体不该被重写：%s", parsed.body)
	}
}

// 档位表为空 = 不限：请求带什么档就按什么打上游。
func TestApplyPolicyWithoutLadderPassesThrough(t *testing.T) {
	adapter := New(nil, Options{})
	parsed := parseBody(t, "/v1/messages", `{"model":"claude-opus-5","output_config":{"effort":"max"}}`)
	if effort, _ := adapter.ApplyPolicy(parsed, contract.GroupPolicy{GroupID: "mg_ANY", Family: contract.FamilyAnthropic, AllowFast: true}); effort != contract.EffortMax {
		t.Fatalf("不限档的分组不该夹，实际 %q", effort)
	}
	if got := fieldOf(t, parsed.body, "output_config", "effort"); got != "max" {
		t.Fatalf("请求体不该被改，实际 %v", got)
	}
}

// 快速：分组没开就把 service_tier 钉成普通档。
//
// **改写而不是删掉**：删掉等于回到 auto，上游仍然可能把它调度到快速通道上，
// 而平台这边已经按普通档记了账。
func TestApplyPolicyStripsFastWhenGroupSaysNo(t *testing.T) {
	adapter := New(nil, Options{})
	parsed := parseBody(t, "/v1/messages", `{"model":"claude-opus-5","service_tier":"priority"}`)
	if !parsed.fast {
		t.Fatal("service_tier=priority 就是在要快速")
	}
	_, fast := adapter.ApplyPolicy(parsed, contract.GroupPolicy{GroupID: "mg_STD", Family: contract.FamilyAnthropic})
	if fast {
		t.Fatal("分组没开快速，这一次就不该算快速")
	}
	if got := fieldOf(t, parsed.body, "service_tier"); got != standardValueAnthropic {
		t.Fatalf("要钉成 %q，实际 %v", standardValueAnthropic, got)
	}
}

// 同一件事在 Codex 一族上写的是另一个值：它没有 standard_only。
func TestApplyPolicyStripsFastForOpenAI(t *testing.T) {
	adapter := New(nil, Options{})
	parsed := parseBody(t, "/v1/responses", `{"model":"gpt-5.6-terra","service_tier":"priority"}`)
	_, fast := adapter.ApplyPolicy(parsed, contract.GroupPolicy{GroupID: "mg_STD", Family: contract.FamilyOpenAI})
	if fast {
		t.Fatal("分组没开快速，这一次就不该算快速")
	}
	if got := fieldOf(t, parsed.body, "service_tier"); got != standardValueOpenAI {
		t.Fatalf("要钉成 %q，实际 %v", standardValueOpenAI, got)
	}
}

// 分组开了快速就原样放行 —— 那正是使用者买它的原因。
func TestApplyPolicyKeepsFastWhenGroupSellsIt(t *testing.T) {
	adapter := New(nil, Options{})
	body := `{"model":"claude-opus-5","service_tier":"priority"}`
	parsed := parseBody(t, "/v1/messages", body)
	_, fast := adapter.ApplyPolicy(parsed, contract.GroupPolicy{GroupID: "mg_FAST", Family: contract.FamilyAnthropic, AllowFast: true})
	if !fast {
		t.Fatal("分组卖快速，这一次就是快速")
	}
	if string(parsed.body) != body {
		t.Fatalf("请求体不该被重写：%s", parsed.body)
	}
}

// service_tier 的 auto 不算「要快速」。
//
// 它是「你看着办」，不是使用者要的档；当成快速的话，每一个没写这个字段的请求
// （也就是绝大多数）都会被分组闸改写一道，凭空多出一次请求体重写。
func TestAutoTierIsNotFast(t *testing.T) {
	for _, tier := range []string{"", "auto", "standard_only", "flex"} {
		if parseFast(tier) {
			t.Fatalf("service_tier=%q 不该算快速", tier)
		}
	}
	if !parseFast("Priority") {
		t.Fatal("大小写不该影响判定")
	}
}

// 夹过之后的值要一路带到工作单元上 —— 结算只看得到信封里那份 JSON。
func TestUnitCarriesGroupAndFast(t *testing.T) {
	adapter := New(nil, Options{})
	parsed := parseBody(t, "/v1/messages", `{"model":"claude-opus-5","service_tier":"priority","output_config":{"effort":"max"}}`)
	adapter.ApplyPolicy(parsed, contract.GroupPolicy{
		GroupID: "mg_STD", Family: contract.FamilyAnthropic, Efforts: []contract.Effort{contract.EffortLow},
	})
	unit := adapter.ToUnit(parsed, corepkg.Caller{KeyID: "ck_test"})
	if unit.Effort != contract.EffortLow {
		t.Fatalf("单元上要带夹过之后的档，实际 %q", unit.Effort)
	}
	if unit.Fast {
		t.Fatal("分组没开快速，单元上不该记成快速")
	}
}
