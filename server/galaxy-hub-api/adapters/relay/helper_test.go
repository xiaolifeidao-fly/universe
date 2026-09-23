package relay

import (
	"encoding/json"
	"testing"
)

func jsonUnmarshal(raw []byte, target any) error { return json.Unmarshal(raw, target) }

func TestDetachPreviousResponseIDKeepsPortableContext(t *testing.T) {
	raw := []byte(`{"model":"gpt-test","previous_response_id":"resp_old","input":[{"role":"user","content":"完整上下文"}]}`)
	detached, ok := detachPreviousResponseID(raw)
	if !ok {
		t.Fatal("完整 Responses 请求应能解除旧 response id")
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(detached, &body); err != nil {
		t.Fatalf("解除后的请求不是合法 JSON：%v", err)
	}
	if _, exists := body["previous_response_id"]; exists {
		t.Fatalf("旧 response id 仍在请求里：%s", detached)
	}
	if string(body["input"]) == "" {
		t.Fatalf("完整上下文被误删：%s", detached)
	}
}
