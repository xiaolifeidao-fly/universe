package relay

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	corepkg "galaxy-api/adapters/core"
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
