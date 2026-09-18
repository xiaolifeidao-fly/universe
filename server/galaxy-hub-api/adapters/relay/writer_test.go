package relay

import (
	"net/http/httptest"
	"os"
	"testing"

	"github.com/gin-gonic/gin"

	"contract"
)

// newTestWriter 造一个只连着 ResponseRecorder 的写回器：不派单、不连共享池，
// 只看「上游字节进来之后，消费者收到什么、用量解析出什么」。
func newTestWriter(sniff sniffer, requestedStream, stripUsage bool) (*relayWriter, *httptest.ResponseRecorder) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ginContext, _ := gin.CreateTestContext(recorder)
	return &relayWriter{
		context: ginContext, unitID: "u_test",
		sniffer: sniff, requestedStream: requestedStream, stripUsage: stripUsage,
	}, recorder
}

func feedWriter(t *testing.T, writer *relayWriter, raw []byte, chunkSize int) {
	t.Helper()
	for offset := 0; offset < len(raw); offset += chunkSize {
		end := offset + chunkSize
		if end > len(raw) {
			end = len(raw)
		}
		if err := writer.Write(raw[offset:end]); err != nil {
			t.Fatalf("写回失败: %v", err)
		}
	}
	writer.End()
}

// 上游漏了 content-type 的事件流：用量照样要解析出来。
//
// 这是线上真出过的一笔 —— 中转站转发 SSE 时没带 content-type，Hub 把整条流当成一段 JSON 收，
// 解析器拿到的是 SSE 文本，usage 一个都解不出来。请求全部成功、账单全是 0 个 token，
// 一路上没有任何一处报错。
func TestStreamWithoutContentTypeStillMeters(t *testing.T) {
	raw, err := os.ReadFile("testdata/responses-stream.sse")
	if err != nil {
		t.Fatalf("读取 golden 失败: %v", err)
	}
	for _, requestedStream := range []bool{true, false} {
		sniff := &responsesSniffer{}
		writer, recorder := newTestWriter(sniff, requestedStream, false)
		// 上游只给了状态码，一个头都没有。
		writer.Head(200, map[string]string{})
		feedWriter(t, writer, raw, 17)

		assertUsage(t, writer.Usage(), contract.Metering{
			// 净输入：流里的 2048 减掉 1024 个缓存命中（见 usage.go 的 netInput）。
			contract.UnitInputTokens:     1024,
			contract.UnitOutputTokens:    311,
			contract.UnitCacheReadTokens: 1024,
			// 推理是 output 的一部分，不是第五个桶 —— 合计里不加它。
			contract.UnitReasoningTokens:  192,
			contract.UnitCacheWriteTokens: 256,
		})
		// 逐字节透传是硬要求：端到端必须和直连一模一样。
		if got := recorder.Body.String(); got != string(raw) {
			t.Fatalf("消费者收到的字节和上游不一致（requestedStream=%v）:\n%q", requestedStream, got)
		}
	}
}

// 上游把事件流标成了 application/json：字节说了算，用量照样要解析出来。
func TestStreamMislabelledAsJSONStillMeters(t *testing.T) {
	raw, err := os.ReadFile("testdata/responses-stream.sse")
	if err != nil {
		t.Fatalf("读取 golden 失败: %v", err)
	}
	sniff := &responsesSniffer{}
	writer, recorder := newTestWriter(sniff, true, false)
	writer.Head(200, map[string]string{"content-type": "application/json"})
	feedWriter(t, writer, raw, 31)

	if writer.Usage() == nil {
		t.Fatal("上游标错 content-type 就解不出用量了")
	}
	if got := recorder.Body.String(); got != string(raw) {
		t.Fatalf("消费者收到的字节和上游不一致: %q", got)
	}
}

// 上游明确说了不是事件流：按整段 JSON 收，非流式的 usage 也要解出来。
func TestNonStreamBodyStillMeters(t *testing.T) {
	body := []byte(`{"id":"resp_x","status":"completed","usage":{"input_tokens":11,"output_tokens":3}}`)
	sniff := &responsesSniffer{}
	writer, recorder := newTestWriter(sniff, false, false)
	writer.Head(200, map[string]string{"content-type": "application/json"})
	feedWriter(t, writer, body, 9)

	assertUsage(t, writer.Usage(), contract.Metering{
		contract.UnitInputTokens:  11,
		contract.UnitOutputTokens: 3,
	})
	if got := recorder.Body.String(); got != string(body) {
		t.Fatalf("非流式响应被改写了: %q", got)
	}
}

// 上游没带 content-type、回的又是一整段 JSON（常见于错误体）：不能当成事件流。
func TestJSONWithoutContentTypeIsNotTreatedAsStream(t *testing.T) {
	body := []byte(`{"error":{"message":"boom"}}`)
	sniff := &responsesSniffer{}
	// 消费者要的是流，上游却回了 JSON —— 判断只认真正到达的字节。
	writer, recorder := newTestWriter(sniff, true, false)
	writer.Head(400, map[string]string{})
	feedWriter(t, writer, body, 5)

	if writer.streaming {
		t.Fatal("一整段 JSON 不该被当成事件流")
	}
	if got := recorder.Body.String(); got != string(body) {
		t.Fatalf("错误体被改写了: %q", got)
	}
}

// 流的末尾没有空行时，残尾只能被写出去一次。
//
// 逐字节透传那条路每个 chunk 都已经原样写过了，End 再补一次就是把尾巴发两遍；
// 剥 usage 那条路写回的是完整事件，不补反而会丢。
func TestTrailingPartialEventWrittenExactlyOnce(t *testing.T) {
	// 最后一条事件后面故意不留空行。
	raw := []byte("event: a\ndata: {\"type\":\"a\"}\n\nevent: b\ndata: {\"type\":\"b\"}\n")

	passthrough, recorder := newTestWriter(&responsesSniffer{}, true, false)
	passthrough.Head(200, map[string]string{"content-type": "text/event-stream"})
	feedWriter(t, passthrough, raw, 11)
	if got := recorder.Body.String(); got != string(raw) {
		t.Fatalf("透传时残尾被写了两遍:\n%q", got)
	}

	stripping, stripRecorder := newTestWriter(&chatSniffer{}, true, true)
	stripping.Head(200, map[string]string{"content-type": "text/event-stream"})
	feedWriter(t, stripping, raw, 11)
	if got := stripRecorder.Body.String(); got != string(raw) {
		t.Fatalf("剥 usage 时残尾丢了:\n%q", got)
	}
}
