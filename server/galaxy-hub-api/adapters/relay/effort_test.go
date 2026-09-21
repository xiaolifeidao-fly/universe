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

// Claude：thinking 关掉就是 none，压过 effort。
//
// 思考关掉之后一个推理 token 都不会产生，而 effort 那时只影响措辞长短 ——
// 把它当成 low 档收费，收的是一笔没有发生的推理。
func TestAnthropicDisabledThinkingWinsOverEffort(t *testing.T) {
	if got := anthropicEffort("disabled", "low", 0); got != contract.EffortNone {
		t.Fatalf("thinking 关掉就是 none，实际 %q", got)
	}
	if got := anthropicEffort("disabled", "max", 30000); got != contract.EffortNone {
		t.Fatalf("关掉之后 effort 与 budget 都不作数，实际 %q", got)
	}
}

// output_config.effort 是当前模型上的正主。
func TestAnthropicReadsOutputConfigEffort(t *testing.T) {
	for _, effort := range []string{"low", "medium", "high", "xhigh", "max"} {
		if got := anthropicEffort("adaptive", effort, 0); got != effort {
			t.Fatalf("%q 该原样读出来，实际 %q", effort, got)
		}
	}
	// minimal 是 Codex 的档，Claude 没有。认不出来就回落到默认档，
	// **不能**猜一个最近的 —— 按一个从没发生过的档收钱比少收一笔更糟。
	if got := anthropicEffort("adaptive", "minimal", 0); got != contract.EffortHigh {
		t.Fatalf("不属于这一族的档该回落到默认档 high，实际 %q", got)
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
		if got := anthropicEffort("enabled", "", budget); got != want {
			t.Fatalf("budget %d 该折成 %q，实际 %q", budget, want, got)
		}
	}
}

// 什么都没写时补上官方默认档。
//
// 不补的话「没填」是一个查不到价的空档，会静默回落到不分强度价 ——
// 而上游那一次是实打实按默认档跑的，那笔推理 token 真的产生了。
func TestEffortDefaultsMatchUpstream(t *testing.T) {
	if got := anthropicEffort("", "", 0); got != contract.EffortHigh {
		t.Fatalf("Claude 不写 output_config 时官方默认 high，实际 %q", got)
	}
	if got := openaiEffort(""); got != contract.EffortMedium {
		t.Fatalf("Codex 不写 reasoning 时官方默认 medium，实际 %q", got)
	}
}

// Codex 只有 reasoning.effort 一个出处，minimal 是它独有的一档。
func TestOpenAIReadsReasoningEffort(t *testing.T) {
	for _, effort := range []string{"none", "minimal", "low", "medium", "high"} {
		if got := openaiEffort(effort); got != effort {
			t.Fatalf("%q 该原样读出来，实际 %q", effort, got)
		}
	}
	// xhigh / max 是 Claude 的档，Codex 没有。
	if got := openaiEffort("xhigh"); got != contract.EffortMedium {
		t.Fatalf("不属于这一族的档该回落到默认档 medium，实际 %q", got)
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
		{"claude 关掉思考", "/v1/messages",
			`{"model":"claude-opus-5","thinking":{"type":"disabled"}}`, contract.EffortNone},
		{"claude 老式预算", "/v1/messages",
			`{"model":"claude-haiku-4-5","thinking":{"type":"enabled","budget_tokens":31999}}`, contract.EffortHigh},
		{"claude 什么都没写", "/v1/messages",
			`{"model":"claude-opus-5"}`, contract.EffortHigh},
		{"codex 显式 low", "/v1/responses",
			`{"model":"gpt-5.6-terra","reasoning":{"effort":"low"}}`, contract.EffortLow},
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
