package relay

import (
	"bytes"
	"encoding/json"

	"contract"
)

// 平台侧 usage 解析（设计文档 6.1）。Hub 在对拷字节时窥探事件，不修改字节。
// 解析结果比节点自报更可信：节点可以撒谎，透传的上游流不能。

// sniffer 一族协议的用量解析器。
type sniffer interface {
	// Event 喂入一个 SSE 事件。
	Event(event sseEvent)
	// Body 喂入非流式响应的完整 JSON。
	Body(raw []byte)
	Usage() contract.Metering
}

// ---------- Anthropic Messages ----------

type anthropicSniffer struct {
	input      int64
	output     int64
	cacheRead  int64
	cacheWrite int64
	seen       bool
}

type anthropicUsage struct {
	InputTokens              *int64 `json:"input_tokens"`
	OutputTokens             *int64 `json:"output_tokens"`
	CacheCreationInputTokens *int64 `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     *int64 `json:"cache_read_input_tokens"`
}

func (s *anthropicSniffer) apply(usage anthropicUsage) {
	if usage.InputTokens != nil {
		s.input = *usage.InputTokens
		s.seen = true
	}
	// output 在 message_delta 里是累计值，取最后一次。
	if usage.OutputTokens != nil {
		s.output = *usage.OutputTokens
		s.seen = true
	}
	if usage.CacheCreationInputTokens != nil {
		s.cacheWrite = *usage.CacheCreationInputTokens
		s.seen = true
	}
	if usage.CacheReadInputTokens != nil {
		s.cacheRead = *usage.CacheReadInputTokens
		s.seen = true
	}
}

func (s *anthropicSniffer) Event(event sseEvent) {
	if len(event.Data) == 0 {
		return
	}
	var payload struct {
		Type    string `json:"type"`
		Message *struct {
			Usage anthropicUsage `json:"usage"`
		} `json:"message"`
		Usage *anthropicUsage `json:"usage"`
	}
	if err := json.Unmarshal(event.Data, &payload); err != nil {
		return
	}
	name := payload.Type
	if name == "" {
		name = event.Name
	}
	switch name {
	case "message_start":
		if payload.Message != nil {
			s.apply(payload.Message.Usage)
		}
	case "message_delta":
		if payload.Usage != nil {
			s.apply(*payload.Usage)
		}
	}
}

func (s *anthropicSniffer) Body(raw []byte) {
	var payload struct {
		Usage *anthropicUsage `json:"usage"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil || payload.Usage == nil {
		return
	}
	s.apply(*payload.Usage)
}

func (s *anthropicSniffer) Usage() contract.Metering {
	if !s.seen {
		return nil
	}
	usage := contract.Metering{
		contract.UnitInputTokens:  s.input,
		contract.UnitOutputTokens: s.output,
	}
	if s.cacheRead > 0 {
		usage[contract.UnitCacheReadTokens] = s.cacheRead
	}
	if s.cacheWrite > 0 {
		usage[contract.UnitCacheWriteTokens] = s.cacheWrite
	}
	return usage
}

// ---------- OpenAI Responses ----------

type responsesSniffer struct {
	input     int64
	output    int64
	cacheRead int64
	seen      bool
	// LastResponseID 供硬钉使用：下一次带 previous_response_id 的请求必须回同一个贡献。
	lastResponseID string
}

type responsesUsage struct {
	InputTokens        *int64 `json:"input_tokens"`
	OutputTokens       *int64 `json:"output_tokens"`
	InputTokensDetails *struct {
		CachedTokens *int64 `json:"cached_tokens"`
	} `json:"input_tokens_details"`
}

func (s *responsesSniffer) apply(usage responsesUsage) {
	if usage.InputTokens != nil {
		s.input = *usage.InputTokens
		s.seen = true
	}
	if usage.OutputTokens != nil {
		s.output = *usage.OutputTokens
		s.seen = true
	}
	if usage.InputTokensDetails != nil && usage.InputTokensDetails.CachedTokens != nil {
		s.cacheRead = *usage.InputTokensDetails.CachedTokens
	}
}

func (s *responsesSniffer) Event(event sseEvent) {
	if len(event.Data) == 0 {
		return
	}
	var payload struct {
		Type     string `json:"type"`
		Response *struct {
			ID    string          `json:"id"`
			Usage *responsesUsage `json:"usage"`
		} `json:"response"`
	}
	if err := json.Unmarshal(event.Data, &payload); err != nil || payload.Response == nil {
		return
	}
	if payload.Response.ID != "" {
		s.lastResponseID = payload.Response.ID
	}
	name := payload.Type
	if name == "" {
		name = event.Name
	}
	if name == "response.completed" && payload.Response.Usage != nil {
		s.apply(*payload.Response.Usage)
	}
}

func (s *responsesSniffer) Body(raw []byte) {
	var payload struct {
		ID    string          `json:"id"`
		Usage *responsesUsage `json:"usage"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return
	}
	if payload.ID != "" {
		s.lastResponseID = payload.ID
	}
	if payload.Usage != nil {
		s.apply(*payload.Usage)
	}
}

func (s *responsesSniffer) Usage() contract.Metering {
	if !s.seen {
		return nil
	}
	usage := contract.Metering{
		contract.UnitInputTokens:  s.input,
		contract.UnitOutputTokens: s.output,
	}
	if s.cacheRead > 0 {
		usage[contract.UnitCacheReadTokens] = s.cacheRead
	}
	return usage
}

// ---------- OpenAI Chat Completions ----------

type chatSniffer struct {
	input     int64
	output    int64
	cacheRead int64
	seen      bool
}

type chatUsage struct {
	PromptTokens        *int64 `json:"prompt_tokens"`
	CompletionTokens    *int64 `json:"completion_tokens"`
	PromptTokensDetails *struct {
		CachedTokens *int64 `json:"cached_tokens"`
	} `json:"prompt_tokens_details"`
}

func (s *chatSniffer) apply(usage chatUsage) {
	if usage.PromptTokens != nil {
		s.input = *usage.PromptTokens
		s.seen = true
	}
	if usage.CompletionTokens != nil {
		s.output = *usage.CompletionTokens
		s.seen = true
	}
	if usage.PromptTokensDetails != nil && usage.PromptTokensDetails.CachedTokens != nil {
		s.cacheRead = *usage.PromptTokensDetails.CachedTokens
	}
}

func (s *chatSniffer) Event(event sseEvent) {
	if len(event.Data) == 0 || bytes.Equal(event.Data, []byte("[DONE]")) {
		return
	}
	var payload struct {
		Usage *chatUsage `json:"usage"`
	}
	if err := json.Unmarshal(event.Data, &payload); err != nil || payload.Usage == nil {
		return
	}
	s.apply(*payload.Usage)
}

func (s *chatSniffer) Body(raw []byte) {
	var payload struct {
		Usage *chatUsage `json:"usage"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil || payload.Usage == nil {
		return
	}
	s.apply(*payload.Usage)
}

func (s *chatSniffer) Usage() contract.Metering {
	if !s.seen {
		return nil
	}
	usage := contract.Metering{
		contract.UnitInputTokens:  s.input,
		contract.UnitOutputTokens: s.output,
	}
	if s.cacheRead > 0 {
		usage[contract.UnitCacheReadTokens] = s.cacheRead
	}
	return usage
}

// isInjectedUsageChunk 判断一个 chat.completion.chunk 是不是「只带 usage 的那一条」。
// Hub 为了拿到用量给上游注入了 stream_options.include_usage 时，
// 这一条是我们自己加出来的，写回消费者前要剥掉，否则客户端会多收到一个空 choices 的 chunk。
func isInjectedUsageChunk(data []byte) bool {
	if len(data) == 0 || bytes.Equal(data, []byte("[DONE]")) {
		return false
	}
	var payload struct {
		Choices []json.RawMessage `json:"choices"`
		Usage   *chatUsage        `json:"usage"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return false
	}
	return payload.Usage != nil && len(payload.Choices) == 0
}
