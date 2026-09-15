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

	if err := session.Wait(context.Background(), WaitOptions{}); err != nil {
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
	if err := session.Wait(context.Background(), WaitOptions{}); err == nil {
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
	if err := session.Wait(ctx, WaitOptions{}); !errors.Is(err, context.Canceled) {
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

// 下面这组用例守的是同一件事：节点消失时消费者不能干等。
//
// 这条路上没有任何人会来收尾 —— 节点被 kill 不会有 stream 的 EOF，
// 也不会有 complete。少了这几道限，一条领走了活又消失的节点
// 就能让消费者的 SDK 一直转下去，而 Hub 这边看起来一切正常。

func TestWaitGivesUpWhenNodeNeverAttaches(t *testing.T) {
	exchange := NewExchange()
	writer := &recordingWriter{}
	session := exchange.Open("u_1", writer, nil)

	started := time.Now()
	err := session.Wait(context.Background(), WaitOptions{AttachTimeout: 30 * time.Millisecond})

	if !errors.Is(err, ErrNodeNotAttached) {
		t.Fatalf("没人认领上行时应判节点掉线，实际: %v", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("不该等满：%v", elapsed)
	}
	if !HubJudged(err) {
		t.Fatal("这一类失败要能被通道层认出来，否则预留的额度与并发没人还")
	}
	// 首字节还没发出去，所以这次失败可以改派。
	if session.Started() {
		t.Fatal("没有字节流出去过，不该算已开始")
	}
	if writer.aborted == nil {
		t.Fatal("写回器应收到 Abort")
	}
}

func TestWaitKeepsWaitingAfterNodeAttaches(t *testing.T) {
	exchange := NewExchange()
	writer := &recordingWriter{}
	session := exchange.Open("u_1", writer, nil)

	attached, err := exchange.Attach("u_1")
	if err != nil {
		t.Fatalf("节点应能认领: %v", err)
	}
	// 认领之后 attach 这道限就作废：上游慢慢吐字节是正常的，
	// 从这里开始由上行的空闲看门狗判生死。
	go func() {
		time.Sleep(60 * time.Millisecond)
		attached.Head(200, nil)
		_ = attached.Write([]byte("data: hi\n\n"))
		attached.Finish(nil)
	}()

	if err := session.Wait(context.Background(), WaitOptions{AttachTimeout: 20 * time.Millisecond}); err != nil {
		t.Fatalf("已认领的上行不该被 attach 时限打断: %v", err)
	}
	if writer.body.String() != "data: hi\n\n" {
		t.Fatalf("字节没有对拷过去: %q", writer.body.String())
	}
}

func TestWaitGivesUpWhenNodeGoesOffline(t *testing.T) {
	exchange := NewExchange()
	writer := &recordingWriter{}
	session := exchange.Open("u_1", writer, nil)
	if _, err := exchange.Attach("u_1"); err != nil {
		t.Fatalf("节点应能认领: %v", err)
	}

	// 认领了上行，然后整台机器没了：连接还挂着，心跳先断。
	err := session.Wait(context.Background(), WaitOptions{
		AttachTimeout: time.Hour,
		Alive:         func() bool { return false },
		AliveInterval: 10 * time.Millisecond,
	})
	if !errors.Is(err, ErrNodeVanished) {
		t.Fatalf("心跳断了应判节点失联，实际: %v", err)
	}
}

func TestWaitKeepsProbingAfterFirstByte(t *testing.T) {
	// 首字节之后同样要探心跳。上行的空闲看门狗要等满一个静默窗口才动手，
	// 而断电、拔网线这类走法根本不产生 FIN —— 连接就那么半开着，
	// 那条路上的读是最慢的一条证据，反倒要靠心跳先说话。
	exchange := NewExchange()
	writer := &recordingWriter{}
	session := exchange.Open("u_1", writer, nil)
	attached, err := exchange.Attach("u_1")
	if err != nil {
		t.Fatalf("节点应能认领: %v", err)
	}
	attached.Head(200, nil)
	if err := attached.Write([]byte("data: hi\n\n")); err != nil {
		t.Fatalf("首字节应能写出去: %v", err)
	}
	// 机器没了。上行连接还半开着，不会有 EOF，也不会有 complete。

	started := time.Now()
	err = session.Wait(context.Background(), WaitOptions{
		Alive:         func() bool { return false },
		AliveInterval: 10 * time.Millisecond,
	})
	if !errors.Is(err, ErrNodeVanished) {
		t.Fatalf("流到一半机器失联应收口，实际: %v", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("不该等满上行的静默窗口: %v", elapsed)
	}
	// 已经流出去的字节收不回来，改派由 Started 挡住。
	if !session.Started() {
		t.Fatal("首字节已经发出去了，Started 必须为真，否则通道层会去改派")
	}
}

func TestWaitDoesNotDisturbAHealthyStream(t *testing.T) {
	exchange := NewExchange()
	writer := &recordingWriter{}
	session := exchange.Open("u_1", writer, nil)
	attached, err := exchange.Attach("u_1")
	if err != nil {
		t.Fatalf("节点应能认领: %v", err)
	}
	attached.Head(200, nil)

	// 节点还在心跳，只是上游吐得慢。探测再密也不该碰它。
	go func() {
		time.Sleep(60 * time.Millisecond)
		_ = attached.Write([]byte("data: hi\n\n"))
		attached.Finish(nil)
	}()
	if err := session.Wait(context.Background(), WaitOptions{
		Alive:         func() bool { return true },
		AliveInterval: 5 * time.Millisecond,
	}); err != nil {
		t.Fatalf("心跳正常的慢流不该被打断: %v", err)
	}
	if writer.body.String() != "data: hi\n\n" {
		t.Fatalf("字节没有对拷过去: %q", writer.body.String())
	}
}

func TestWaitGivesUpAtUnitDeadline(t *testing.T) {
	exchange := NewExchange()
	writer := &recordingWriter{}
	session := exchange.Open("u_1", writer, nil)
	if _, err := exchange.Attach("u_1"); err != nil {
		t.Fatalf("节点应能认领: %v", err)
	}

	err := session.Wait(context.Background(), WaitOptions{
		AttachTimeout: time.Hour,
		Deadline:      time.Now().Add(30 * time.Millisecond),
	})
	if !errors.Is(err, ErrUnitDeadline) {
		t.Fatalf("超过总时限应收口，实际: %v", err)
	}
}

func TestWaitWithoutLimitsStillBlocks(t *testing.T) {
	// session / job 的交汇点不跟着消费者连接走，用的是零值。
	// 零值必须仍然是「只等 done 与 ctx」，不能被新加的时限影响。
	exchange := NewExchange()
	session := exchange.Open("u_1", &recordingWriter{}, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	if err := session.Wait(ctx, WaitOptions{}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("零值不该自己收口: %v", err)
	}
}

func TestRelayDeadlineComesFromKindSpec(t *testing.T) {
	// 这条守的是一个会静默失效的接线：Submit 收的是值，它在自己那份拷贝上
	// 补的 unit.Deadline 回不到通道层。照着 unit 读，总时限那道限就永远不触发，
	// 而且一切看起来都正常 —— 只有节点真的失联时才会发现消费者还在干等。
	spec := contract.KindSpec{}
	spec.Lease.MaxRunSec = 600
	deadline := relayDeadline(spec)
	if deadline.IsZero() {
		t.Fatal("kind 声明了 maxRunSec，总时限就不能是零值")
	}
	if remaining := time.Until(deadline); remaining < 590*time.Second || remaining > 600*time.Second {
		t.Fatalf("总时限该按 maxRunSec 算，实际还剩 %v", remaining)
	}

	// 没声明 maxRunSec 的 kind 不设这道限。
	if !relayDeadline(contract.KindSpec{}).IsZero() {
		t.Fatal("没有 maxRunSec 就不该凭空造一个总时限")
	}
}
