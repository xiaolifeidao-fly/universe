package relay

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	corepkg "galaxy-hub-api/adapters/core"
)

// 客户端的会话身份要一路到上游。
//
// 上游的前缀缓存按会话路由：同一条对话的连续请求落到同一台机器上才命中得了。
// 这几个头被白名单挡掉的时候，Codex 这一路能命中的就只剩 instructions + tools
// 那段所有请求共用的开头，对话本身有多长都白搭 —— 而三层都不会因此报错。
func TestCodexSessionHeadersAreForwarded(t *testing.T) {
	sent := map[string]string{
		"session-id":                             "01a0-bfb9-conversation",
		"thread-id":                              "01a0-bfb9-conversation",
		"x-client-request-id":                    "01a0-bfb9-turn",
		"x-codex-window-id":                      "01a0-bfb9-conversation:0",
		"x-codex-turn-metadata":                  `{"installation_id":"c4e6"}`,
		"x-codex-beta-features":                  "remote_compaction_v2",
		"x-openai-internal-codex-responses-lite": "true",
		"originator":                             "codex_exec",
		"user-agent":                             "codex_exec/0.154.0",
	}
	in := parseWithHeaders(t, "/v1/responses", `{"model":"gpt-5.6-sol"}`, sent)
	for name, want := range sent {
		if got := in.headers[name]; got != want {
			t.Fatalf("%s 没进白名单：期望 %q，实际 %q", name, want, got)
		}
	}

	// 白名单之外的东西不该混进来，凭据尤其不能。
	for _, name := range []string{"authorization", "cookie", "x-api-key"} {
		if _, ok := in.headers[name]; ok {
			t.Fatalf("%s 不该被转发", name)
		}
	}

	// 头要真的随工作单元下发，节点才拿得到。
	unit := (&Adapter{options: Options{}.withDefaults()}).ToUnit(in, corepkg.Caller{KeyID: "ck_test"})
	var carried map[string]string
	for _, payload := range unit.Inputs {
		if payload.Name == "headers" {
			if err := json.Unmarshal(payload.Inline, &carried); err != nil {
				t.Fatalf("头载荷不是合法 JSON：%v", err)
			}
		}
	}
	if carried["session-id"] != sent["session-id"] {
		t.Fatalf("工作单元里没带上会话身份：%v", carried)
	}
}

func parseWithHeaders(t *testing.T, path, body string, headers map[string]string) *input {
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
	request.Header.Set("Authorization", "Bearer 不该转发")
	request.Header.Set("Cookie", "不该转发")
	for name, value := range headers {
		request.Header.Set(name, value)
	}
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
