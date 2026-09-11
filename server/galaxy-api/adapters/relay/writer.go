package relay

import (
	"bytes"
	"context"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"

	"contract"
	"service/galaxy"
)

// relayWriter 把节点回来的上游字节原样写给消费者，同时窥探用量。
//
// 默认逐字节透传（端到端与直连一致，验收标准要求逐字节比对）。唯一的例外是
// Hub 为了拿到用量而给 chat/completions 注入了 stream_options.include_usage：
// 那条多出来的 usage chunk 是我们自己造的，写回前要剥掉。
type relayWriter struct {
	context *gin.Context
	galaxy  galaxy.Service
	unitID  string
	family  string

	sniffer    sniffer
	scanner    sseScanner
	stripUsage bool
	// requestedStream 是消费者在请求体里写的 stream。上游没带 content-type 时按它先猜一手，
	// 猜的结果决定要不要给消费者加禁缓冲的响应头 —— 那两个头只能在首字节之前发出去。
	requestedStream bool

	streaming bool
	// sniffPending 表示上游没明说是事件流，streaming 还要拿首个 chunk 的字节再定一次。
	sniffPending bool
	body         bytes.Buffer
	usage        contract.Metering
	cid          string
	// eventNames 是响应里出现过的事件类型。抽检比对结构时用它。
	// 只记名字，不记次数也不记内容：次数取决于回答长短，是噪声不是信号；
	// 内容则根本不该留在抽检表里。
	eventNames map[string]struct{}
}

// looksLikeSSE 按字节判断这段响应是不是事件流。
//
// 只看开头：SSE 的第一行必然是字段行（event / data / id / retry）或注释（以 : 开头），
// 而两族的非流式响应都是一整个 JSON 对象。够分辨这两者就行，不必真的解析。
func looksLikeSSE(chunk []byte) bool {
	head := bytes.TrimLeft(chunk, " \t\r\n\uFEFF")
	for _, prefix := range [][]byte{[]byte("event:"), []byte("data:"), []byte("id:"), []byte("retry:"), []byte(":")} {
		if bytes.HasPrefix(head, prefix) {
			return true
		}
	}
	return false
}

// 上游响应里原样带回给消费者的头：限流提示与请求追踪（非功能需求·兼容）。
func passthroughHeader(name string) bool {
	name = strings.ToLower(name)
	switch name {
	case "content-type", "request-id", "retry-after", "x-should-retry":
		return true
	}
	return strings.HasPrefix(name, "anthropic-ratelimit-") || strings.HasPrefix(name, "x-ratelimit-")
}

func (w *relayWriter) Head(status int, headers map[string]string) {
	for name, value := range headers {
		if passthroughHeader(name) {
			w.context.Header(name, value)
		}
	}
	contentType := headers["content-type"]
	if contentType == "" {
		contentType = headers["Content-Type"]
	}
	// 「是不是事件流」不能只听 content-type：见过的中转站里就有转发 SSE 时把这个头丢掉的，
	// 而一旦按整段 JSON 收，解析器拿到的是一大段 SSE 文本，usage 永远解不出来 ——
	// 计费不会报错，只会静静地把每一笔都记成 0 个 token。
	// 所以只有上游明确说了 text/event-stream 才直接采信；其余情况先按消费者请求里的
	// stream 猜一手（禁缓冲的响应头只能在首字节之前发），再在首个 chunk 到达时用字节定论。
	w.streaming = strings.HasPrefix(strings.ToLower(contentType), "text/event-stream")
	if !w.streaming {
		w.streaming = contentType == "" && w.requestedStream
		w.sniffPending = true
	}
	if w.streaming {
		w.context.Header("Cache-Control", "no-cache, no-transform")
		w.context.Header("X-Accel-Buffering", "no")
	}
	w.context.Status(status)
	w.context.Writer.Flush()
}

func (w *relayWriter) Write(chunk []byte) error {
	if w.sniffPending {
		// 只看首个 chunk：这时两条路都还没往缓冲里放过东西，改判是安全的。
		w.sniffPending = false
		w.streaming = looksLikeSSE(chunk)
	}
	if !w.streaming {
		// 非流式：写通的同时留一份，End 时整体解析 usage。响应体受 bodyLimit 约束。
		w.body.Write(chunk)
		return w.emit(chunk)
	}
	events := w.scanner.Push(chunk)
	for _, event := range events {
		w.note(event.Name)
	}
	if !w.stripUsage {
		// 逐字节透传：解析只是旁路，不参与写回。
		for _, event := range events {
			w.sniffer.Event(event)
		}
		return w.emit(chunk)
	}
	for _, event := range events {
		w.sniffer.Event(event)
		if isInjectedUsageChunk(event.Data) {
			continue
		}
		if err := w.emit(event.Raw); err != nil {
			return err
		}
	}
	return nil
}

func (w *relayWriter) emit(chunk []byte) error {
	if len(chunk) == 0 {
		return nil
	}
	if _, err := w.context.Writer.Write(chunk); err != nil {
		return err
	}
	w.context.Writer.Flush()
	return nil
}

func (w *relayWriter) End() {
	if w.streaming {
		// 只有剥 usage 的那条路才要补写残尾：它写回的是扫描器交出的完整事件，
		// 不成事件的尾巴没人写过。逐字节透传那条路每个 chunk 都已经原样写出去了，
		// 再写一遍等于把尾巴发两次。
		if rest := w.scanner.Rest(); len(rest) > 0 && w.stripUsage {
			_ = w.emit(rest)
		}
	} else {
		w.sniffer.Body(w.body.Bytes())
	}
	w.usage = w.sniffer.Usage()
	w.rememberResponse()
}

func (w *relayWriter) Abort(err error) {
	// 中途失败也要把已经解析到的用量留下：消费者主动断开时按已产出计费（C-11）。
	if w.streaming {
		w.usage = w.sniffer.Usage()
	} else if w.body.Len() > 0 {
		w.sniffer.Body(w.body.Bytes())
		w.usage = w.sniffer.Usage()
	}
	w.rememberResponse()
}

func (w *relayWriter) Usage() contract.Metering { return w.usage }

func (w *relayWriter) note(name string) {
	if name == "" {
		return
	}
	if w.eventNames == nil {
		w.eventNames = map[string]struct{}{}
	}
	w.eventNames[name] = struct{}{}
}

// Signature 响应的结构签名：流式取事件名与量级，非流式取 JSON 键路径。
// 抽检比的是结构不是内容 —— 同一个提问两次回答本来就不一样。
func (w *relayWriter) Signature() string {
	if !w.streaming {
		return galaxy.ResponseSignature(w.body.Bytes())
	}
	names := make([]string, 0, len(w.eventNames))
	for name := range w.eventNames {
		names = append(names, name)
	}
	sort.Strings(names)
	return strings.Join(names, ",")
}

// Placed 由通道层在放置成功后回填贡献 id。
func (w *relayWriter) Placed(cid string) { w.cid = cid }

// rememberResponse 记住 Responses 的 id → 贡献映射。
// previous_response_id 引用的是上游账号侧状态，后续请求必须回原节点（5.1 唯一硬约束）。
func (w *relayWriter) rememberResponse() {
	sniffer, ok := w.sniffer.(*responsesSniffer)
	if !ok || sniffer.lastResponseID == "" || w.cid == "" || w.galaxy == nil {
		return
	}
	_ = w.galaxy.RememberResponse(context.Background(), sniffer.lastResponseID, w.cid)
}
