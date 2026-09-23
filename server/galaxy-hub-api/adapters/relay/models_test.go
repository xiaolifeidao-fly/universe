package relay

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"

	corepkg "galaxy-hub-api/adapters/core"
)

// 模型清单是第三方客户端接入的第一步：拿不到就连模型都选不了，后面的额度、
// 计费一概谈不上。所以这里钉的是**响应形状**，而不只是「返回了 200」。

func modelsProbe(t *testing.T, options Options, path string) (int, []byte) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	// 和 router.go 一样走 Register：顺带证明 relay 确实被当成 SelfRegistering 挂上了。
	corepkg.Register(engine.Group("/v1"), New(&corepkg.Deps{}, options), corepkg.Deps{})
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
	return response.Code, response.Body.Bytes()
}

func decodeCatalog(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("清单不是合法 JSON: %v (%s)", err, raw)
	}
	return body
}

func catalogIDs(t *testing.T, body map[string]any) []string {
	t.Helper()
	rows, ok := body["data"].([]any)
	if !ok {
		t.Fatalf("data 不是数组: %#v", body["data"])
	}
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		item, ok := row.(map[string]any)
		if !ok {
			t.Fatalf("条目不是对象: %#v", row)
		}
		id, _ := item["id"].(string)
		ids = append(ids, id)
	}
	return ids
}

// 同一个 base_url 上两族客户端都会打这条路由，两套字段少任何一套，对应那族的
// 解析器就会把清单读成空 —— 客户端表现出来是「连上了但没有模型」。
func TestModelCatalogCarriesBothFamilyShapes(t *testing.T) {
	status, raw := modelsProbe(t, Options{Models: []string{"claude-opus-5"}}, "/v1/models")
	if status != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200", status)
	}
	body := decodeCatalog(t, raw)
	if body["object"] != "list" || body["has_more"] != false {
		t.Fatalf("外层形状不对: %#v", body)
	}
	if body["first_id"] != "claude-opus-5" || body["last_id"] != "claude-opus-5" {
		t.Fatalf("翻页字段不对: first=%v last=%v", body["first_id"], body["last_id"])
	}
	rows, _ := body["data"].([]any)
	if len(rows) != 1 {
		t.Fatalf("条目数 = %d，期望 1", len(rows))
	}
	entry, _ := rows[0].(map[string]any)
	// OpenAI 侧认 object / created / owned_by，Anthropic 侧认 type / display_name / created_at。
	for _, field := range []string{"id", "object", "type", "display_name", "created", "created_at", "owned_by"} {
		if _, ok := entry[field]; !ok {
			t.Fatalf("条目缺字段 %s: %#v", field, entry)
		}
	}
	if entry["object"] != "model" || entry["type"] != "model" {
		t.Fatalf("条目类型不对: %#v", entry)
	}
	// 时间戳固定：清单每次请求都长一样，客户端的缓存比对才不会误判模型换了。
	if entry["created"] != float64(catalogCreated.Unix()) {
		t.Fatalf("created = %v，期望固定值 %d", entry["created"], catalogCreated.Unix())
	}
}

// 配置里的书写顺序就是客户端下拉里的顺序，替部署方排序等于把这个决定抹掉；
// 顺手把空白项与重复项挡掉 —— 逗号分隔的配置项里这两样最常见。
func TestModelCatalogKeepsConfiguredOrderAndDedupes(t *testing.T) {
	options := Options{Models: []string{" claude-opus-5 ", "", "gpt-5.6-terra", "claude-opus-5", "  "}}
	status, raw := modelsProbe(t, options, "/v1/models")
	if status != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200", status)
	}
	ids := catalogIDs(t, decodeCatalog(t, raw))
	if len(ids) != 2 || ids[0] != "claude-opus-5" || ids[1] != "gpt-5.6-terra" {
		t.Fatalf("清单 = %v，期望 [claude-opus-5 gpt-5.6-terra]", ids)
	}
}

// 部署方没配就得走兜底：空清单和这条路由不存在，对客户端是同一件事 ——
// 都卡在「至少要有一个模型」那一步。
func TestModelCatalogFallsBackToDefaults(t *testing.T) {
	status, raw := modelsProbe(t, Options{}, "/v1/models")
	if status != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200", status)
	}
	ids := catalogIDs(t, decodeCatalog(t, raw))
	if len(ids) == 0 {
		t.Fatal("兜底清单是空的：客户端会卡在模型发现这一步")
	}
	if len(ids) != len(DefaultModels) || ids[0] != DefaultModels[0] {
		t.Fatalf("兜底清单 = %v，期望 %v", ids, DefaultModels)
	}
}

func TestRetrieveModel(t *testing.T) {
	options := Options{Models: []string{"claude-opus-5"}}

	status, raw := modelsProbe(t, options, "/v1/models/claude-opus-5")
	if status != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200", status)
	}
	if decodeCatalog(t, raw)["id"] != "claude-opus-5" {
		t.Fatalf("retrieve 返回的不是那个模型: %s", raw)
	}

	// 清单里没有的模型给 404，错误体仍是官方形态 —— 客户端要能把它当错误读出来，
	// 而不是当成一个字段都对不上的模型对象。
	status, raw = modelsProbe(t, options, "/v1/models/gpt-nonexistent")
	if status != http.StatusNotFound {
		t.Fatalf("状态码 = %d，期望 404", status)
	}
	body := decodeCatalog(t, raw)
	failure, ok := body["error"].(map[string]any)
	if !ok || failure["message"] == "" {
		t.Fatalf("错误体形态不对: %s", raw)
	}
	if failure["type"] != "not_found_error" {
		t.Fatalf("错误类型 = %v，期望 not_found_error", failure["type"])
	}
}

// Codex 的模型发现走的是另一套形状，而且只在部署方交出一份清单时才开。
// 这几条钉的是「什么时候换形状」和「换了之后条目有没有被我们动过」。

func writeManifest(t *testing.T, document string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "codex-models.json")
	if err := os.WriteFile(path, []byte(document), 0o600); err != nil {
		t.Fatalf("写清单文件失败: %v", err)
	}
	return path
}

// 清单里的条目要原样出去：那三十来个字段是 Codex 自己的协议，我们插一层结构体
// 就会把没认出来的字段吃掉，客户端一升级就解析失败。
func TestCodexManifestServedVerbatimForCodexProbe(t *testing.T) {
	path := writeManifest(t, `{"fetched_at":"2026-09-18T10:17:44Z","models":[
		{"slug":"gpt-5.6-terra","display_name":"GPT-5.6 Terra","base_instructions":"probe","future_field":{"kept":true}},
		{"slug":"gpt-5.6-sol","display_name":"GPT-5.6 Sol","base_instructions":"probe"},
		{"slug":"gpt-4o-not-declared","display_name":"没在 galaxy.models 里"}]}`)
	options := Options{Models: []string{"gpt-5.6-sol", "claude-opus-5", "gpt-5.6-terra"}, CodexManifest: path}

	status, raw := modelsProbe(t, options, "/v1/models?client_version=0.154.0")
	if status != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200", status)
	}
	body := decodeCatalog(t, raw)
	if _, ok := body["data"]; ok {
		t.Fatalf("Codex 那一路不该再带两族的 data: %s", raw)
	}
	rows, ok := body["models"].([]any)
	if !ok {
		t.Fatalf("models 不是数组: %#v", body["models"])
	}
	// 只给 galaxy.models 声明过的，且按它的书写顺序 —— 清单的语义仍归 galaxy.models 管。
	if len(rows) != 2 {
		t.Fatalf("条目数 = %d，期望 2（清单里第三条没被声明）", len(rows))
	}
	first, _ := rows[0].(map[string]any)
	second, _ := rows[1].(map[string]any)
	if first["slug"] != "gpt-5.6-sol" || second["slug"] != "gpt-5.6-terra" {
		t.Fatalf("顺序没跟着 galaxy.models: %#v", rows)
	}
	if _, ok := second["future_field"]; !ok {
		t.Fatalf("条目被我们动过，没认出来的字段丢了: %#v", second)
	}
}

// 同一条路由上还有两族的官方 SDK。它们不带 client_version，拿到的必须还是老形状，
// 否则「为 Codex 修一个」会把另外两家一起改坏。
func TestCodexManifestLeavesClassicClientsAlone(t *testing.T) {
	path := writeManifest(t, `{"models":[{"slug":"gpt-5.6-terra","display_name":"GPT-5.6 Terra"}]}`)
	options := Options{Models: []string{"gpt-5.6-terra"}, CodexManifest: path}

	status, raw := modelsProbe(t, options, "/v1/models")
	if status != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200", status)
	}
	body := decodeCatalog(t, raw)
	if body["object"] != "list" {
		t.Fatalf("不带 client_version 时形状不该变: %s", raw)
	}
	if ids := catalogIDs(t, body); len(ids) != 1 || ids[0] != "gpt-5.6-terra" {
		t.Fatalf("经典形状的清单 = %v", ids)
	}
}

// 没配清单是默认状态：Codex 照样拿到老形状，它自己回落到内置清单。
// 这条钉的是「默认不接管客户端的提示词」。
func TestCodexProbeFallsBackToClassicShapeWithoutManifest(t *testing.T) {
	status, raw := modelsProbe(t, Options{Models: []string{"gpt-5.6-terra"}}, "/v1/models?client_version=0.154.0")
	if status != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200", status)
	}
	if _, ok := decodeCatalog(t, raw)["models"]; ok {
		t.Fatalf("没配清单却给了 Codex 形状: %s", raw)
	}
}

// 清单配岔了（和 galaxy.models 一条都对不上、文件读不出、根本不是 JSON）都不能把
// Hub 带崩，也不能给 Codex 一个空 models —— 那等于说「这儿没有模型」，比回落更糟。
func TestCodexManifestDegradesInsteadOfServingNothing(t *testing.T) {
	cases := map[string]Options{
		"一条都没对上": {Models: []string{"claude-opus-5"},
			CodexManifest: writeManifest(t, `{"models":[{"slug":"gpt-5.6-terra"}]}`)},
		"条目没有 slug": {Models: []string{"gpt-5.6-terra"},
			CodexManifest: writeManifest(t, `{"models":[{"display_name":"没有 slug"}]}`)},
		"不是 JSON": {Models: []string{"gpt-5.6-terra"},
			CodexManifest: writeManifest(t, `这不是 JSON`)},
		"文件不存在": {Models: []string{"gpt-5.6-terra"},
			CodexManifest: filepath.Join(t.TempDir(), "缺席.json")},
	}
	for name, options := range cases {
		t.Run(name, func(t *testing.T) {
			status, raw := modelsProbe(t, options, "/v1/models?client_version=0.154.0")
			if status != http.StatusOK {
				t.Fatalf("状态码 = %d，期望 200", status)
			}
			body := decodeCatalog(t, raw)
			if _, ok := body["models"]; ok {
				t.Fatalf("清单不可用却仍给了 Codex 形状: %s", raw)
			}
			if len(catalogIDs(t, body)) == 0 {
				t.Fatalf("退回经典形状后清单是空的: %s", raw)
			}
		})
	}
}
