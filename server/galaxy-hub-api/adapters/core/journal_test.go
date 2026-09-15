package core

import (
	"encoding/json"
	"sync"
	"testing"
	"time"
)

// 事件日志是 session / job 的命脉：消费者中途断开重连是常态，
// 「不重不漏」不是锦上添花，是这套异步模型能不能用的前提。

func TestJournalReplaysThenStreams(t *testing.T) {
	journal := NewJournal(64, nil)
	journal.Append("u_1", JournalEvent{Kind: "text", Data: json.RawMessage(`{"t":"a"}`)})
	journal.Append("u_1", JournalEvent{Kind: "text", Data: json.RawMessage(`{"t":"b"}`)})

	replay, live, cancel := journal.Subscribe("u_1", 0)
	defer cancel()
	if len(replay) != 2 || replay[0].Seq != 1 || replay[1].Seq != 2 {
		t.Fatalf("订阅时应先拿到已有事件: %+v", replay)
	}

	journal.Append("u_1", JournalEvent{Kind: "text", Data: json.RawMessage(`{"t":"c"}`)})
	select {
	case event := <-live:
		if event.Seq != 3 || event.Kind != "text" {
			t.Fatalf("实时事件不对: %+v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("没收到实时事件")
	}
}

// 断线重连：客户端说「我读到第 2 条了」，就该从第 3 条接着给，不重不漏。
func TestJournalResumesFromSeq(t *testing.T) {
	journal := NewJournal(64, nil)
	for i := 0; i < 5; i++ {
		journal.Append("u_2", JournalEvent{Kind: "text"})
	}
	replay, _, cancel := journal.Subscribe("u_2", 2)
	defer cancel()
	if len(replay) != 3 || replay[0].Seq != 3 {
		t.Fatalf("应从 fromSeq 之后开始回放: %+v", replay)
	}
}

// 先落库再广播：反过来的话，消费者可能读到一条数据库里还不存在的事件，
// 断线重连时就会看到「刚才有、现在没了」。
func TestJournalPersistsBeforeBroadcast(t *testing.T) {
	var mu sync.Mutex
	persisted := map[int]bool{}
	journal := NewJournal(64, func(unitID string, event JournalEvent) {
		mu.Lock()
		persisted[event.Seq] = true
		mu.Unlock()
	})
	_, live, cancel := journal.Subscribe("u_3", 0)
	defer cancel()
	journal.Append("u_3", JournalEvent{Kind: "text"})

	select {
	case event := <-live:
		mu.Lock()
		defer mu.Unlock()
		if !persisted[event.Seq] {
			t.Fatal("广播到订阅者时，这条事件必须已经落库")
		}
	case <-time.After(time.Second):
		t.Fatal("没收到事件")
	}
}

func TestJournalFinishClosesSubscribers(t *testing.T) {
	journal := NewJournal(64, nil)
	_, live, cancel := journal.Subscribe("u_4", 0)
	defer cancel()
	journal.Finish("u_4")
	select {
	case _, ok := <-live:
		if ok {
			t.Fatal("关闭后不该再有事件")
		}
	case <-time.After(time.Second):
		t.Fatal("Finish 应该叫醒所有订阅者")
	}
	// 关闭之后再订阅只回放不等待，否则消费者会挂在一条永远不会来事件的流上。
	replay, closed, cancel2 := journal.Subscribe("u_4", 0)
	defer cancel2()
	_ = replay
	if _, ok := <-closed; ok {
		t.Fatal("已关闭的日志，订阅拿到的应是一条关好的通道")
	}
}

// 慢的消费者不该拖住节点上行：它可以按 seq 从库里补齐，
// 但整条链路不能因为它卡住。
func TestJournalDoesNotBlockOnSlowSubscriber(t *testing.T) {
	journal := NewJournal(16, nil)
	_, _, cancel := journal.Subscribe("u_5", 0)
	defer cancel()

	done := make(chan struct{})
	go func() {
		for i := 0; i < 500; i++ {
			journal.Append("u_5", JournalEvent{Kind: "text"})
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("订阅者不读，Append 也不能卡住")
	}
}

// 内存里只留最近一段，更早的靠数据库回放。缓冲无限增长的话，
// 一个跑几小时的回合会把 Hub 的内存吃光。
func TestJournalBufferIsBounded(t *testing.T) {
	journal := NewJournal(8, nil)
	for i := 0; i < 100; i++ {
		journal.Append("u_6", JournalEvent{Kind: "text"})
	}
	replay, _, cancel := journal.Subscribe("u_6", 0)
	defer cancel()
	if len(replay) != 8 {
		t.Fatalf("内存缓冲应有上限: %d", len(replay))
	}
	// seq 仍然是全局递增的：回放边界靠它对齐，不能因为裁剪就重编号。
	if replay[len(replay)-1].Seq != 100 {
		t.Fatalf("裁剪不该影响 seq: %d", replay[len(replay)-1].Seq)
	}
}

func TestJournalWriterParsesNDJSONAcrossChunks(t *testing.T) {
	journal := NewJournal(64, nil)
	writer := NewJournalWriter(journal, "u_7")

	// 一条事件跨三个 chunk：TCP 分片不会照着 JSON 的边界来。
	if err := writer.Write([]byte(`{"kind":"tex`)); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	if err := writer.Write([]byte(`t","data":{"v":1}}` + "\n" + `{"kind":"done"`)); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	if err := writer.Write([]byte(`,"usage":{"llm.output_tokens":42}}` + "\n")); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	writer.End()

	replay, _, cancel := journal.Subscribe("u_7", 0)
	defer cancel()
	if len(replay) != 3 {
		t.Fatalf("应收到 text、done、end 三条: %+v", replay)
	}
	if replay[0].Kind != "text" || string(replay[0].Data) != `{"v":1}` {
		t.Fatalf("跨 chunk 的事件没拼对: %+v", replay[0])
	}
	if !replay[2].Terminal {
		t.Fatal("最后一条要标成终态，订阅者据此收线")
	}
	if usage := writer.Usage(); usage["llm.output_tokens"] != 42 {
		t.Fatalf("用量应从事件里累计出来: %v", usage)
	}
}

func TestJournalWriterKeepsMalformedLines(t *testing.T) {
	journal := NewJournal(64, nil)
	writer := NewJournalWriter(journal, "u_8")
	_ = writer.Write([]byte("not json\n"))
	writer.End()

	replay, _, cancel := journal.Subscribe("u_8", 0)
	defer cancel()
	if len(replay) != 2 || replay[0].Kind != "malformed" {
		t.Fatalf("坏行应记成 malformed 而不是被吃掉: %+v", replay)
	}
}
