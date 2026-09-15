package relay

import (
	"os"
	"testing"

	"contract"
)

// usage golden：用真实形态的 SSE 流做基准，解析结果必须与流内 usage 相等。
// 上游格式升级时先补 golden，再改解析器 —— 反过来做等于把计费错误发上线。

func feedStream(t *testing.T, target sniffer, path string, chunkSize int) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取 golden 失败: %v", err)
	}
	var scanner sseScanner
	for offset := 0; offset < len(raw); offset += chunkSize {
		end := offset + chunkSize
		if end > len(raw) {
			end = len(raw)
		}
		for _, event := range scanner.Push(raw[offset:end]) {
			target.Event(event)
		}
	}
}

func assertUsage(t *testing.T, got, want contract.Metering) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("用量维度数量不符: got=%v want=%v", got, want)
	}
	for unit, expected := range want {
		if got[unit] != expected {
			t.Fatalf("%s 解析错误: got=%d want=%d", unit, got[unit], expected)
		}
	}
}

func TestAnthropicStreamUsage(t *testing.T) {
	// 分片大小刻意取质数：事件必然跨 chunk，能验证扫描器的缓冲是对的。
	for _, chunkSize := range []int{7, 64, 4096} {
		sniff := &anthropicSniffer{}
		feedStream(t, sniff, "testdata/anthropic-stream.sse", chunkSize)
		assertUsage(t, sniff.Usage(), contract.Metering{
			contract.UnitInputTokens: 1820,
			// output 在 message_delta 里是累计值，必须取最后一次而不是求和。
			contract.UnitOutputTokens:     964,
			contract.UnitCacheReadTokens:  1500,
			contract.UnitCacheWriteTokens: 64,
		})
	}
}

func TestAnthropicNonStreamUsage(t *testing.T) {
	raw, err := os.ReadFile("testdata/anthropic-nonstream.json")
	if err != nil {
		t.Fatalf("读取 golden 失败: %v", err)
	}
	sniff := &anthropicSniffer{}
	sniff.Body(raw)
	assertUsage(t, sniff.Usage(), contract.Metering{
		contract.UnitInputTokens:     42,
		contract.UnitOutputTokens:    7,
		contract.UnitCacheReadTokens: 10,
	})
}

func TestResponsesStreamUsage(t *testing.T) {
	sniff := &responsesSniffer{}
	feedStream(t, sniff, "testdata/responses-stream.sse", 13)
	assertUsage(t, sniff.Usage(), contract.Metering{
		contract.UnitInputTokens:      2048,
		contract.UnitOutputTokens:     311,
		contract.UnitCacheReadTokens:  1024,
		contract.UnitCacheWriteTokens: 256,
	})
	// response id 要被记住：下一次带 previous_response_id 的请求必须回同一个贡献。
	if sniff.lastResponseID != "resp_abc123" {
		t.Fatalf("未记住 response id: %s", sniff.lastResponseID)
	}
}

func TestChatStreamUsage(t *testing.T) {
	sniff := &chatSniffer{}
	feedStream(t, sniff, "testdata/chat-stream.sse", 29)
	assertUsage(t, sniff.Usage(), contract.Metering{
		contract.UnitInputTokens:     97,
		contract.UnitOutputTokens:    24,
		contract.UnitCacheReadTokens: 32,
	})
}

func TestUsageAbsentWhenUpstreamNeverReports(t *testing.T) {
	sniff := &anthropicSniffer{}
	var scanner sseScanner
	for _, event := range scanner.Push([]byte("event: ping\ndata: {\"type\":\"ping\"}\n\n")) {
		sniff.Event(event)
	}
	// 解析不出用量时返回 nil，让结算回退到节点自报并记 usage_parse_failed。
	if sniff.Usage() != nil {
		t.Fatalf("没有 usage 事件时不该编出一个用量: %v", sniff.Usage())
	}
}

func TestInjectedUsageChunkDetection(t *testing.T) {
	usageOnly := []byte(`{"id":"c","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2}}`)
	if !isInjectedUsageChunk(usageOnly) {
		t.Fatal("空 choices + usage 就是 Hub 注入出来的那一条")
	}
	normal := []byte(`{"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"x"}}]}`)
	if isInjectedUsageChunk(normal) {
		t.Fatal("正常内容 chunk 不该被剥掉")
	}
	if isInjectedUsageChunk([]byte("[DONE]")) {
		t.Fatal("[DONE] 必须原样透传")
	}
}

func TestInjectIncludeUsagePreservesOtherFields(t *testing.T) {
	patched, ok := injectIncludeUsage([]byte(`{"model":"gpt-4o","stream":true,"messages":[{"role":"user","content":"hi"}]}`))
	if !ok {
		t.Fatal("注入失败")
	}
	sniffModel := struct {
		Model         string `json:"model"`
		Stream        bool   `json:"stream"`
		StreamOptions struct {
			IncludeUsage bool `json:"include_usage"`
		} `json:"stream_options"`
		Messages []map[string]string `json:"messages"`
	}{}
	if err := jsonUnmarshal(patched, &sniffModel); err != nil {
		t.Fatalf("注入后的请求体不是合法 JSON: %v", err)
	}
	if !sniffModel.StreamOptions.IncludeUsage {
		t.Fatal("include_usage 没被打开")
	}
	if sniffModel.Model != "gpt-4o" || !sniffModel.Stream || len(sniffModel.Messages) != 1 {
		t.Fatalf("注入不该动其他字段: %+v", sniffModel)
	}
}

func TestInjectIncludeUsageKeepsExistingStreamOptions(t *testing.T) {
	patched, ok := injectIncludeUsage([]byte(`{"model":"gpt-4o","stream":true,"stream_options":{"other":1}}`))
	if !ok {
		t.Fatal("注入失败")
	}
	var payload struct {
		StreamOptions map[string]any `json:"stream_options"`
	}
	if err := jsonUnmarshal(patched, &payload); err != nil {
		t.Fatalf("注入后的请求体不是合法 JSON: %v", err)
	}
	if payload.StreamOptions["include_usage"] != true || payload.StreamOptions["other"] == nil {
		t.Fatalf("已有的 stream_options 字段应保留: %v", payload.StreamOptions)
	}
}
