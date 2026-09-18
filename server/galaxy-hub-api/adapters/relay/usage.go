package relay

import (
	"bytes"
	"encoding/json"

	"contract"
)

// 平台侧 usage 解析（设计文档 6.1）。Hub 在对拷字节时窥探事件，不修改字节。
// 解析结果比节点自报更可信：节点可以撒谎，透传的上游流不能。

// netInput 把「含缓存命中的总输入」折成「未命中缓存的新增输入」。
//
// 两族的 input 天生不是一个口径：Anthropic 的 input_tokens 与 cache_read / cache_creation
// 三者互不重叠，OpenAI 的 input_tokens 却把 cached_tokens 算在里面。照原样存进去，
// 同一个 llm.input_tokens 在两族之间指的是两件事 —— 界面上的「输入」列没法解释，
// 而 billing 又是逐单位乘单价累加的（service/galaxy/billing.go），OpenAI 这边的缓存
// token 会被收两遍：一次全价 input，一次 cache 价。
//
// 所以在解析这一层就减齐，让库里的三个桶永远互不重叠：
// input = 新增输入，cache_read = 命中缓存，cache_write = 写入缓存。
func netInput(total, cacheRead int64) int64 {
	if cacheRead <= 0 {
		return total
	}
	if total <= cacheRead {
		// 上游偶尔把两个数报得一样大，或干脆报反。减成负数比偏大危险得多 ——
		// 负用量在结算时是往回加额度，会把计数器越烧越松。
		return 0
	}
	return total - cacheRead
}

// cacheWriteBuckets 把缓存写入拆成两个计价桶：5 分钟档与 1 小时档。
//
// 合计取「上游报的 cache_creation_input_tokens」与「分项之和」里大的那个 ——
// 两者本该相等，不等时多的那一方更可能是完整的，取小等于少收。
//
// 分项缺失（上游没给 cache_creation、中转站转发时丢了、或者根本没有 TTL 这个概念的
// OpenAI）就整笔算 5 分钟档：那是 cache_control 不写 ttl 时的默认值，1 小时缓存必须
// 显式申请，申请了的响应就会带上分项。宁可把 1h 的量算成 5m（少收一点），
// 也不能让它从两个计价桶里一起消失（一分不收）。
//
// 5m 一律用减法得出，不直接采信上游报的那一项：这样两个桶之和恒等于合计，
// 上游少报一项时漏的是账面精度，不是钱。
func cacheWriteBuckets(total, ephemeral5m, ephemeral1h int64) (fiveMinutes, oneHour int64) {
	if ephemeral5m < 0 {
		ephemeral5m = 0
	}
	if ephemeral1h < 0 {
		ephemeral1h = 0
	}
	if sum := ephemeral5m + ephemeral1h; sum > total {
		total = sum
	}
	if total <= 0 {
		return 0, 0
	}
	if ephemeral1h > total {
		ephemeral1h = total
	}
	return total - ephemeral1h, ephemeral1h
}

// subsetOf 把「子集类」的量夹在它所属的桶里。
//
// 推理 token 是 output 的一部分，报得比 output 还大只能是上游算错或者中转站拼错了。
// 照单收下的话，界面上会出现「输出 34，其中推理 2000」这种自相矛盾的行，
// 而它又不计价，没有任何一层会因为这个数字不对而报错。
func subsetOf(part, whole int64) int64 {
	if part <= 0 {
		return 0
	}
	if part > whole {
		return whole
	}
	return part
}

// putCacheWrite 把缓存写入的合计与两个计价桶一起写进用量。三者要么一起在，
// 要么一起不在 —— 只写合计会让这一笔没有可计价的桶，只写分项会让合计对不上。
func putCacheWrite(usage contract.Metering, total, ephemeral5m, ephemeral1h int64) {
	fiveMinutes, oneHour := cacheWriteBuckets(total, ephemeral5m, ephemeral1h)
	if fiveMinutes+oneHour <= 0 {
		return
	}
	usage[contract.UnitCacheWriteTokens] = fiveMinutes + oneHour
	if fiveMinutes > 0 {
		usage[contract.UnitCacheWrite5mTokens] = fiveMinutes
	}
	if oneHour > 0 {
		usage[contract.UnitCacheWrite1hTokens] = oneHour
	}
}

// withTotal 补上四个桶的合计。
//
// 合计是解析出来的，不是上游报的 —— 上游只报分项。主人的额度设在合计上时，
// 少补这一行就等于那条上限永远不涨，机器一直显示「还剩满格」。
//
// 只加这四个：5m / 1h 是 cache_write 的拆分，reasoning 是 output 的一部分，
// 把它们也加进来等于把同一批 token 数两遍。
func withTotal(usage contract.Metering) contract.Metering {
	usage[contract.UnitTotalTokens] = usage[contract.UnitInputTokens] +
		usage[contract.UnitOutputTokens] +
		usage[contract.UnitCacheReadTokens] +
		usage[contract.UnitCacheWriteTokens]
	return usage
}

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
	input        int64
	output       int64
	cacheRead    int64
	cacheWrite   int64
	cacheWrite5m int64
	cacheWrite1h int64
	seen         bool
}

type anthropicUsage struct {
	InputTokens              *int64 `json:"input_tokens"`
	OutputTokens             *int64 `json:"output_tokens"`
	CacheCreationInputTokens *int64 `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     *int64 `json:"cache_read_input_tokens"`
	// CacheCreation 把上面那个合计按 TTL 拆开。两档的单价差 1.6 倍，
	// 只收合计就必然有一边算错（见 contract.UnitCacheWrite5mTokens）。
	CacheCreation *struct {
		Ephemeral5m *int64 `json:"ephemeral_5m_input_tokens"`
		Ephemeral1h *int64 `json:"ephemeral_1h_input_tokens"`
	} `json:"cache_creation"`
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
	if usage.CacheCreation != nil {
		if usage.CacheCreation.Ephemeral5m != nil {
			s.cacheWrite5m = *usage.CacheCreation.Ephemeral5m
		}
		if usage.CacheCreation.Ephemeral1h != nil {
			s.cacheWrite1h = *usage.CacheCreation.Ephemeral1h
		}
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
	// Anthropic 的 input_tokens 本来就不含 cache_read / cache_creation，已经是净值，
	// 不走 netInput。三个桶原样存进去就是互不重叠的。
	usage := contract.Metering{
		contract.UnitInputTokens:  s.input,
		contract.UnitOutputTokens: s.output,
	}
	if s.cacheRead > 0 {
		usage[contract.UnitCacheReadTokens] = s.cacheRead
	}
	putCacheWrite(usage, s.cacheWrite, s.cacheWrite5m, s.cacheWrite1h)
	// Anthropic 不单报推理 token：thinking 的量本来就算在 output_tokens 里，
	// usage 里没有对应字段。这里不造一个出来。
	return withTotal(usage)
}

// ---------- OpenAI Responses ----------

type responsesSniffer struct {
	input      int64
	output     int64
	cacheRead  int64
	cacheWrite int64
	reasoning  int64
	seen       bool
	// LastResponseID 供硬钉使用：下一次带 previous_response_id 的请求必须回同一个贡献。
	lastResponseID string
}

type responsesUsage struct {
	InputTokens        *int64 `json:"input_tokens"`
	OutputTokens       *int64 `json:"output_tokens"`
	InputTokensDetails *struct {
		CachedTokens     *int64 `json:"cached_tokens"`
		CacheWriteTokens *int64 `json:"cache_write_tokens"`
	} `json:"input_tokens_details"`
	// OutputTokensDetails 里的 reasoning_tokens 是 output 的子集。推理模型上它占
	// 绝大多数 —— 不单独记的话，界面上「输出 34」与「输出 29000」看起来是同一件事。
	OutputTokensDetails *struct {
		ReasoningTokens *int64 `json:"reasoning_tokens"`
	} `json:"output_tokens_details"`
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
	if usage.InputTokensDetails != nil {
		if usage.InputTokensDetails.CachedTokens != nil {
			s.cacheRead = *usage.InputTokensDetails.CachedTokens
		}
		if usage.InputTokensDetails.CacheWriteTokens != nil {
			s.cacheWrite = *usage.InputTokensDetails.CacheWriteTokens
		}
	}
	if usage.OutputTokensDetails != nil && usage.OutputTokensDetails.ReasoningTokens != nil {
		s.reasoning = *usage.OutputTokensDetails.ReasoningTokens
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
	// input_tokens 含 cached_tokens（cached 是它的子集），减齐见 netInput。
	usage := contract.Metering{
		contract.UnitInputTokens:  netInput(s.input, s.cacheRead),
		contract.UnitOutputTokens: s.output,
	}
	if s.cacheRead > 0 {
		usage[contract.UnitCacheReadTokens] = s.cacheRead
	}
	// OpenAI 没有 TTL 档位，整笔落在 5m（默认档）那个计价桶上。
	putCacheWrite(usage, s.cacheWrite, 0, 0)
	if reasoning := subsetOf(s.reasoning, s.output); reasoning > 0 {
		usage[contract.UnitReasoningTokens] = reasoning
	}
	return withTotal(usage)
}

// ---------- OpenAI Chat Completions ----------

type chatSniffer struct {
	input     int64
	output    int64
	cacheRead int64
	reasoning int64
	seen      bool
}

type chatUsage struct {
	PromptTokens        *int64 `json:"prompt_tokens"`
	CompletionTokens    *int64 `json:"completion_tokens"`
	PromptTokensDetails *struct {
		CachedTokens *int64 `json:"cached_tokens"`
	} `json:"prompt_tokens_details"`
	CompletionTokensDetails *struct {
		ReasoningTokens *int64 `json:"reasoning_tokens"`
	} `json:"completion_tokens_details"`
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
	if usage.CompletionTokensDetails != nil && usage.CompletionTokensDetails.ReasoningTokens != nil {
		s.reasoning = *usage.CompletionTokensDetails.ReasoningTokens
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
	// prompt_tokens 含 prompt_tokens_details.cached_tokens，同 Responses 一样减齐。
	usage := contract.Metering{
		contract.UnitInputTokens:  netInput(s.input, s.cacheRead),
		contract.UnitOutputTokens: s.output,
	}
	if s.cacheRead > 0 {
		usage[contract.UnitCacheReadTokens] = s.cacheRead
	}
	if reasoning := subsetOf(s.reasoning, s.output); reasoning > 0 {
		usage[contract.UnitReasoningTokens] = reasoning
	}
	// Chat Completions 不报缓存写入，一个桶都不写。
	return withTotal(usage)
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
