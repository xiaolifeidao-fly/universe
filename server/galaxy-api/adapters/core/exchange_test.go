package core

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"contract"
)

type recordingWriter struct {
	status   int
	headers  map[string]string
	body     bytes.Buffer
	ended    bool
	aborted  error
	writeErr error
}

func (w *recordingWriter) Head(status int, headers map[string]string) {
	w.status = status
	w.headers = headers
}

func (w *recordingWriter) Write(chunk []byte) error {
	if w.writeErr != nil {
		return w.writeErr
	}
	w.body.Write(chunk)
	return nil
}

func (w *recordingWriter) End()            { w.ended = true }
func (w *recordingWriter) Abort(err error) { w.aborted = err }
func (w *recordingWriter) Usage() contract.Metering {
	return contract.Metering{contract.UnitOutputTokens: 7}
}

func TestExchangeCopiesBytesToConsumer(t *testing.T) {
	exchange := NewExchange()
	writer := &recordingWriter{}
	firstByte := 0
	session := exchange.Open("u_1", writer, func() { firstByte++ })

	attached, err := exchange.Attach("u_1")
	if err != nil {
		t.Fatalf("节点应能认领交汇点: %v", err)
	}
	attached.Head(200, map[string]string{"content-type": "text/event-stream"})
	if err := attached.Write([]byte("data: hi\n\n")); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	attached.Finish(nil)

	if err := session.Wait(context.Background()); err != nil {
		t.Fatalf("正常结束不该有错: %v", err)
	}
	if writer.status != 200 || writer.body.String() != "data: hi\n\n" || !writer.ended {
		t.Fatalf("字节没有原样对拷: status=%d body=%q ended=%v", writer.status, writer.body.String(), writer.ended)
	}
	// 首字节回调只触发一次：它是失败语义的分水岭，重复触发会把计费口径搞乱。
	attached.Head(500, nil)
	if firstByte != 1 {
		t.Fatalf("首字节回调应恰好一次，实际 %d", firstByte)
	}
}

func TestExchangeRejectsSecondAttach(t *testing.T) {
	exchange := NewExchange()
	exchange.Open("u_2", &recordingWriter{}, nil)
	if _, err := exchange.Attach("u_2"); err != nil {
		t.Fatalf("第一次认领应成功: %v", err)
	}
	if _, err := exchange.Attach("u_2"); err == nil {
		t.Fatal("一个单元同时只允许一条上行连接")
	}
}

func TestExchangeReportsMissingSession(t *testing.T) {
	exchange := NewExchange()
	if _, err := exchange.Attach("u_missing"); !errors.Is(err, ErrNotAttached) {
		t.Fatalf("没有交汇点时应明确报出: %v", err)
	}
}

// 消费者断开：节点的下一次写入必须立刻失败，好让它 abort 上游、不再烧提供者额度。
func TestConsumerGoneStopsNodeWrite(t *testing.T) {
	exchange := NewExchange()
	writer := &recordingWriter{}
	exchange.Open("u_3", writer, nil)
	attached, _ := exchange.Attach("u_3")

	exchange.Close("u_3")
	if err := attached.Write([]byte("late")); !errors.Is(err, ErrConsumerGone) {
		t.Fatalf("消费者走后写入应返回 ErrConsumerGone: %v", err)
	}
	if writer.aborted == nil {
		t.Fatal("写回器应收到 Abort")
	}
}

func TestWriteFailurePropagatesAsConsumerGone(t *testing.T) {
	exchange := NewExchange()
	writer := &recordingWriter{writeErr: errors.New("broken pipe")}
	session := exchange.Open("u_4", writer, nil)
	attached, _ := exchange.Attach("u_4")

	if err := attached.Write([]byte("x")); !errors.Is(err, ErrConsumerGone) {
		t.Fatalf("底层写失败应转成 ErrConsumerGone: %v", err)
	}
	if err := session.Wait(context.Background()); err == nil {
		t.Fatal("等待方应看到失败")
	}
}

func TestWaitReturnsWhenConsumerContextCancelled(t *testing.T) {
	exchange := NewExchange()
	session := exchange.Open("u_5", &recordingWriter{}, nil)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(10 * time.Millisecond)
		cancel()
	}()
	if err := session.Wait(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("消费者自己断开时 Wait 应返回取消: %v", err)
	}
}

func TestStartedTracksFirstByte(t *testing.T) {
	exchange := NewExchange()
	session := exchange.Open("u_6", &recordingWriter{}, nil)
	if session.Started() {
		t.Fatal("还没发首字节")
	}
	attached, _ := exchange.Attach("u_6")
	attached.Head(200, nil)
	if !session.Started() {
		t.Fatal("发过首字节之后就不能再改派了")
	}
}
