package relay

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"contract"
	corepkg "galaxy-hub-api/adapters/core"
)

// 从请求体里读推理强度。
//
// 这一步读错不会报错、不会让请求失败 —— 它只是让这次请求按另一档的价结算。
// 使用者被多扣或少扣、共享者被多结或少结，两头一起错，而且错在同一个方向上，
// 对账也发现不了。所以两族各自的判定顺序在下面逐条钉死。

// Claude 的档位表就是 output_config.effort 那五个，一个不多一个不少。
//
// 出处是 CLI 自己的校验提示：`claude --effort bogus` 回
// 「Valid values: low, medium, high, xhigh, max.」
//
// **ultracode 不在其中，而且不该在。** CLI 接受 `--effort ultracode`，但它的定义是
// 「xhigh + 动态工作流编排，只对本会话生效」—— 上线时 effort 字段里写的是 xhigh。
// 给它开一档，就是一行永远匹配不上的价。
func TestAnthropicLadderMatchesUpstream(t *testing.T) {
	want := []contract.Effort{
		contract.EffortLow, contract.EffortMedium, contract.EffortHigh,
		contract.EffortXHigh, contract.EffortMax,
	}
	got := contract.FamilyEfforts(contract.FamilyAnthropic)
	if len(got) != len(want) {
		t.Fatalf("期望 %v，实际 %v", want, got)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("档位表要由浅到深且与上游一致，期望 %v，实际 %v", want, got)
		}
	}
	// none 只有 Codex 有。Claude 关思考走的是 thinking.type=disabled，那是另一个字段。
	if contract.NormalizeEffort(contract.FamilyAnthropic, contract.EffortNone) != "" {
		t.Fatal("Claude 没有 none 这一档")
	}
}

// Codex 的档位表比 Claude 长三档（none / minimal 在下，ultra 在上）。
//
// 出处是本机的 ~/.codex/models_cache.json：每个模型带一份 supported_reasoning_levels，
// gpt-5.6-sol / terra 是 low / medium / high / xhigh / max / ultra；none 出现在
// 不可配推理的那些模型上；minimal 来自上游 400 的合法值清单（老一些的 gpt-5 走它）。
//
// 别去二进制里 strings 捞这张表：那样会捞到 `…maxultrapersistent`，而 persistent
// 属于另一个枚举 —— 照它定的价一次也匹配不上。
func TestOpenAILadderMatchesUpstream(t *testing.T) {
	want := []contract.Effort{
		contract.EffortNone, contract.EffortMinimal, contract.EffortLow,
		contract.EffortMedium, contract.EffortHigh, contract.EffortXHigh,
		contract.EffortMax, contract.EffortUltra,
	}
	got := contract.FamilyEfforts(contract.FamilyOpenAI)
	if len(got) != len(want) {
		t.Fatalf("期望 %v，实际 %v", want, got)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("档位表要由浅到深且与上游一致，期望 %v，实际 %v", want, got)
		}
	}
}

// output_config.effort 是当前模型上的正主。
func TestAnthropicReadsOutputConfigEffort(t *testing.T) {
	for _, effort := range []string{"low", "medium", "high", "xhigh", "max"} {
		if got := anthropicEffort(effort, 0); got != effort {
			t.Fatalf("%q 该原样读出来，实际 %q", effort, got)
		}
	}
	// minimal / ultra 是 Codex 的档，Claude 没有。认不出来就回落到默认档，
	// **不能**猜一个最近的 —— 按一个从没发生过的档收钱比少收一笔更糟。
	for _, alien := range []string{"minimal", "none", "ultra", "ultracode"} {
		if got := anthropicEffort(alien, 0); got != contract.EffortHigh {
			t.Fatalf("%q 不属于这一族，该回落到默认档 high，实际 %q", alien, got)
		}
	}
}

// 关掉思考**不影响**这次记哪一档：effort 和 thinking 是两个正交的字段，
// 关了之后 output_config.effort 照样按它的单价收，只是那一次不产生推理 token ——
// 而「少了一大桶 token」已经由实际计量如实反映，不该再在单价上折一次。
func TestAnthropicDisabledThinkingKeepsEffort(t *testing.T) {
	if got := anthropicEffort("low", 0); got != contract.EffortLow {
		t.Fatalf("effort 说 low 就是 low，实际 %q", got)
	}
}

// 老模型只有 thinking.budget_tokens 这一个深浅刻度。
// 分界取的是 Claude Code 那三档预设之间的空档，真实流量几乎全落在这三个值上。
func TestAnthropicFoldsLegacyBudgetIntoLevels(t *testing.T) {
	cases := map[int64]contract.Effort{
		4000:  contract.EffortLow,    // think
		10000: contract.EffortMedium, // think hard
		31999: contract.EffortHigh,   // ultrathink
		64000: contract.EffortHigh,   // 比 ultrathink 还深，老口径里没有更高的档
	}
	for budget, want := range cases {
		if got := anthropicEffort("", budget); got != want {
			t.Fatalf("budget %d 该折成 %q，实际 %q", budget, want, got)
		}
	}
}

// 什么都没写时补上官方默认档。
//
// 不补的话「没填」是一个查不到价的空档，会静默回落到不分强度价 ——
// 而上游那一次是实打实按默认档跑的，那笔推理 token 真的产生了。
func TestEffortDefaultsMatchUpstream(t *testing.T) {
	if got := anthropicEffort("", 0); got != contract.EffortHigh {
		t.Fatalf("Claude 不写 output_config 时官方默认 high，实际 %q", got)
	}
	if got := openaiEffort(""); got != contract.EffortMedium {
		t.Fatalf("Codex 不写 reasoning 时官方默认 medium，实际 %q", got)
	}
}

// Codex 只有 reasoning.effort 一个出处，八档全认。
func TestOpenAIReadsReasoningEffort(t *testing.T) {
	for _, effort := range []string{"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"} {
		if got := openaiEffort(effort); got != effort {
			t.Fatalf("%q 该原样读出来，实际 %q", effort, got)
		}
	}
	// 编出来的档回落到默认，不猜一个最近的。persistent 在这里特意点名：
	// 它是 strings(1) 从二进制里捞出来的假档，属于另一个枚举。
	for _, alien := range []string{"medium-high", "persistent", "ultracode"} {
		if got := openaiEffort(alien); got != contract.EffortMedium {
			t.Fatalf("%q 不是上游认识的档，该回落到默认档 medium，实际 %q", alien, got)
		}
	}
}

// 整条 Parse 走一遍：强度要真的落在 input 上，而不是只有那两个纯函数是对的。
func TestParseCarriesEffortPerFamily(t *testing.T) {
	cases := []struct {
		name string
		path string
		body string
		want contract.Effort
	}{
		{"claude 显式 max", "/v1/messages",
			`{"model":"claude-opus-5","output_config":{"effort":"max"}}`, contract.EffortMax},
		{"claude 关掉思考仍按 effort 算", "/v1/messages",
			`{"model":"claude-opus-5","thinking":{"type":"disabled"},"output_config":{"effort":"low"}}`, contract.EffortLow},
		{"claude 老式预算", "/v1/messages",
			`{"model":"claude-haiku-4-5","thinking":{"type":"enabled","budget_tokens":31999}}`, contract.EffortHigh},
		{"claude 什么都没写", "/v1/messages",
			`{"model":"claude-opus-5"}`, contract.EffortHigh},
		{"codex 显式 low", "/v1/responses",
			`{"model":"gpt-5.6-terra","reasoning":{"effort":"low"}}`, contract.EffortLow},
		{"codex 独有的 minimal", "/v1/responses",
			`{"model":"gpt-5.6-terra","reasoning":{"effort":"minimal"}}`, contract.EffortMinimal},
		{"codex 什么都没写", "/v1/chat/completions",
			`{"model":"gpt-5.6-terra"}`, contract.EffortMedium},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := parseBody(t, testCase.path, testCase.body).effort; got != testCase.want {
				t.Fatalf("期望 %q，实际 %q", testCase.want, got)
			}
		})
	}
}

// 强度要一路带到工作单元上 —— 结算只看得到信封里那份 JSON。
func TestRouteAndUnitCarryEffort(t *testing.T) {
	adapter := New(nil, Options{})
	parsed := parseBody(t, "/v1/messages", `{"model":"claude-opus-5","output_config":{"effort":"xhigh"}}`)
	route, err := adapter.Route(context.Background(), parsed)
	if err != nil {
		t.Fatalf("路由失败：%v", err)
	}
	if route.Effort != contract.EffortXHigh {
		t.Fatalf("路由键要带强度，实际 %q", route.Effort)
	}
	if unit := adapter.ToUnit(parsed, corepkg.Caller{KeyID: "ck_test"}); unit.Effort != contract.EffortXHigh {
		t.Fatalf("工作单元要带强度，实际 %q", unit.Effort)
	}
}

// parseBody 让请求真的走一遍 gin 引擎再交给 Parse。
//
// 不能直接 CreateTestContext 手搓一个：Parse 第一步读的是 FullPath()，而那个值只有
// 引擎真正路由过之后才有。手搓的上下文里它是空串，Parse 会以「不支持的路径」退出 ——
// 用例全绿，但一行强度解析都没跑到。
func parseBody(t *testing.T, path, body string) *input {
	t.Helper()
	gin.SetMode(gin.TestMode)
	adapter := New(nil, Options{})

	var parsed corepkg.Input
	var parseErr error
	engine := gin.New()
	engine.POST(path, func(ginContext *gin.Context) {
		parsed, parseErr = adapter.Parse(ginContext)
	})
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(httptest.NewRecorder(), request)

	if parseErr != nil {
		t.Fatalf("解析失败：%v", parseErr)
	}
	in, ok := parsed.(*input)
	if !ok {
		t.Fatalf("入参形状不对：%T", parsed)
	}
	return in
}
