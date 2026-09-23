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
	want = want.Clone()
	// 合计不用每个用例手写：它按定义就是四个桶之和。这里替 want 补上，
	// 顺带把「解析器必须报合计」变成所有用例共同的硬约束 —— 将来接第四族协议时
	// 忘了 withTotal，这里就会红，而不是等主人发现额度条永远不涨。
	if _, ok := want[contract.UnitTotalTokens]; !ok {
		want[contract.UnitTotalTokens] = want[contract.UnitInputTokens] + want[contract.UnitOutputTokens] +
			want[contract.UnitCacheReadTokens] + want[contract.UnitCacheWriteTokens]
	}
	// 缓存写入的两个计价桶同理：多数用例只关心合计，分项按「上游没给 TTL 就整笔
	// 算 5 分钟档」补出来。要验拆分本身的用例自己把 1h 写进 want，这里就不插手 ——
	// 于是「两个桶之和必须等于合计」也成了所有用例共同的硬约束。
	_, has5m := want[contract.UnitCacheWrite5mTokens]
	_, has1h := want[contract.UnitCacheWrite1hTokens]
	if write := want[contract.UnitCacheWriteTokens]; write > 0 && !has5m && !has1h {
		want[contract.UnitCacheWrite5mTokens] = write
	}
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
		// 流里 input_tokens 报的是 2048，其中 1024 是缓存命中。存进去的是净值 1024 ——
		// OpenAI 的 input_tokens 含 cached_tokens，不减的话缓存那部分会被计两次。
		contract.UnitInputTokens:     1024,
		contract.UnitOutputTokens:    311,
		contract.UnitCacheReadTokens: 1024,
		// 推理是 output 的一部分，不是第五个桶 —— 合计里不加它。
		contract.UnitReasoningTokens:  192,
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
		// 同 Responses：流里 prompt_tokens=97 含 32 个缓存命中，净输入是 65。
		contract.UnitInputTokens:     65,
		contract.UnitOutputTokens:    24,
		contract.UnitCacheReadTokens: 32,
	})
}

// netInput 的边界：上游报得不自洽时，宁可偏大也不能变成负数 ——
// 负用量在结算里是往回加额度。
func TestNetInputNeverGoesNegative(t *testing.T) {
	for _, testCase := range []struct{ total, cacheRead, want int64 }{
		{total: 2048, cacheRead: 1024, want: 1024},
		{total: 100, cacheRead: 0, want: 100},
		{total: 100, cacheRead: 100, want: 0},
		{total: 100, cacheRead: 300, want: 0},
		{total: 100, cacheRead: -5, want: 100},
	} {
		if got := netInput(testCase.total, testCase.cacheRead); got != testCase.want {
			t.Fatalf("netInput(%d,%d)=%d want=%d", testCase.total, testCase.cacheRead, got, testCase.want)
		}
	}
}

// Anthropic 的 input_tokens 已经是净值，再减一次就把新增输入抹掉了。
func TestAnthropicInputIsNotNettedAgain(t *testing.T) {
	sniff := &anthropicSniffer{}
	sniff.Body([]byte(`{"usage":{"input_tokens":120,"output_tokens":9,"cache_read_input_tokens":6235}}`))
	assertUsage(t, sniff.Usage(), contract.Metering{
		contract.UnitInputTokens:     120,
		contract.UnitOutputTokens:    9,
		contract.UnitCacheReadTokens: 6235,
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

// 合计要跟着预估一起预留。
//
// 只在结算时扣的话，请求跑着的那几十秒里放置算法看到的合计剩余是满格的，
// 会把远超上限的请求一股脑放进来 —— 主人设的「一天 200 万」就形同虚设。
func TestEstimateReservesTheTotal(t *testing.T) {
	adapter := New(nil, Options{})

	chat := adapter.Estimate(&input{
		spec:      pathSpec{family: FamilyAnthropic},
		body:      []byte(`{"model":"claude-sonnet-5","max_tokens":1000}`),
		maxTokens: 1000,
	})
	if got, want := chat[contract.UnitTotalTokens], chat[contract.UnitInputTokens]+chat[contract.UnitOutputTokens]; got != want {
		t.Fatalf("预估的合计要等于输入加输出: got=%d want=%d", got, want)
	}
	if chat[contract.UnitTotalTokens] <= 0 {
		t.Fatal("预估没有预留合计，主人的总量上限会在请求跑完之前一直显示满格")
	}

	// count_tokens 只数不生成，没有输出要预留，合计就等于输入。
	counting := adapter.Estimate(&input{
		spec: pathSpec{family: FamilyAnthropic, countTokens: true},
		body: []byte(`{"model":"claude-sonnet-5"}`),
	})
	if got, want := counting[contract.UnitTotalTokens], counting[contract.UnitInputTokens]; got != want {
		t.Fatalf("count_tokens 的合计要等于输入: got=%d want=%d", got, want)
	}
}

// 缓存写入按 TTL 拆开，因为两档的单价差 1.6 倍（5 分钟 1.25×、1 小时 2×）。
// 混在一个桶里按一个单价收，必然有一边算错，而且事后从流水里还原不回来。
func TestAnthropicCacheWriteSplitsByTTL(t *testing.T) {
	sniff := &anthropicSniffer{}
	sniff.Body([]byte(`{"usage":{"input_tokens":100,"output_tokens":20,
		"cache_creation_input_tokens":900,
		"cache_creation":{"ephemeral_5m_input_tokens":400,"ephemeral_1h_input_tokens":500}}}`))

	assertUsage(t, sniff.Usage(), contract.Metering{
		contract.UnitInputTokens:        100,
		contract.UnitOutputTokens:       20,
		contract.UnitCacheWriteTokens:   900,
		contract.UnitCacheWrite5mTokens: 400,
		contract.UnitCacheWrite1hTokens: 500,
	})
}

// 上游没给 cache_creation（老版本、中转站转发时丢了、或者根本没有 TTL 概念的 OpenAI）
// 时整笔算 5 分钟档。要的是「一定落进某个可计价的桶」—— 落错档只是少收一点，
// 一个桶都不落就是一分不收，而且不报错。
func TestCacheWriteAlwaysLandsInAPriceableBucket(t *testing.T) {
	for _, item := range []struct {
		name                            string
		total, ephemeral5m, ephemeral1h int64
		wantFiveMinutes, wantOneHour    int64
	}{
		{"没给分项就整笔算默认档", 900, 0, 0, 900, 0},
		{"分项齐全就照分项", 900, 400, 500, 400, 500},
		{"只报了 1h，5m 用减法补齐", 900, 0, 500, 400, 500},
		{"分项之和大于合计时以分项为准", 100, 400, 500, 400, 500},
		{"1h 超过合计就整笔算 1h", 300, 0, 900, 0, 900},
		{"负数当没报", 500, -1, -1, 500, 0},
		{"没有缓存写入就一个桶都不给", 0, 0, 0, 0, 0},
	} {
		fiveMinutes, oneHour := cacheWriteBuckets(item.total, item.ephemeral5m, item.ephemeral1h)
		if fiveMinutes != item.wantFiveMinutes || oneHour != item.wantOneHour {
			t.Fatalf("%s：got 5m=%d 1h=%d, want 5m=%d 1h=%d",
				item.name, fiveMinutes, oneHour, item.wantFiveMinutes, item.wantOneHour)
		}
	}
}

// 推理 token 是 output 的子集。报得比 output 还大只能是上游算错或中转站拼错了，
// 照单收下会让界面出现「输出 34，其中推理 2000」这种自相矛盾的行 ——
// 而它不计价，没有任何一层会因为这个数字不对而报错。
func TestReasoningNeverExceedsOutput(t *testing.T) {
	sniff := &responsesSniffer{}
	sniff.Body([]byte(`{"usage":{"input_tokens":10,"output_tokens":30,
		"output_tokens_details":{"reasoning_tokens":9000}}}`))

	assertUsage(t, sniff.Usage(), contract.Metering{
		contract.UnitInputTokens:     10,
		contract.UnitOutputTokens:    30,
		contract.UnitReasoningTokens: 30,
	})
}

// Chat Completions 也报推理，字段名不同（completion_tokens_details）。
func TestChatReasoningTokens(t *testing.T) {
	sniff := &chatSniffer{}
	sniff.Body([]byte(`{"usage":{"prompt_tokens":50,"completion_tokens":40,
		"completion_tokens_details":{"reasoning_tokens":31}}}`))

	assertUsage(t, sniff.Usage(), contract.Metering{
		contract.UnitInputTokens:     50,
		contract.UnitOutputTokens:    40,
		contract.UnitReasoningTokens: 31,
	})
}

// 派生单位不能进合计：合计只数四个桶，多数一次就等于把同一批 token 收两遍。
func TestDerivedUnitsStayOutOfTheTotal(t *testing.T) {
	sniff := &responsesSniffer{}
	sniff.Body([]byte(`{"usage":{"input_tokens":1000,"output_tokens":300,
		"input_tokens_details":{"cached_tokens":200,"cache_write_tokens":100},
		"output_tokens_details":{"reasoning_tokens":250}}}`))

	usage := sniff.Usage()
	// 净输入 800 + 输出 300 + 缓存读 200 + 缓存写 100
	if got := usage[contract.UnitTotalTokens]; got != 1400 {
		t.Fatalf("合计该是四个桶之和 1400，实际 %d", got)
	}
	if usage[contract.UnitCacheWrite5mTokens] != 100 || usage[contract.UnitReasoningTokens] != 250 {
		t.Fatalf("派生单位没记下来: %v", usage)
	}
}
