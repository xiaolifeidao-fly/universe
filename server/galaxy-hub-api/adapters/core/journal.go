package core

import (
	"encoding/json"
	"sync"
	"time"
)

// Journal 是 session / job 的事件日志。
//
// 它和 Exchange 解决的是两个不同的问题：relay 一次请求对应一条消费者连接，字节直接对拷；
// session 的一个回合可能跑几分钟，消费者中途断开重连是常态，工作不能跟着断。
// 所以节点的事件先进日志，消费者随时订阅、可以从任意 seq 回放。
type Journal struct {
	mu      sync.Mutex
	streams map[string]*journalStream
	// persist 把事件落到 MySQL，供进程重启后回放。返回错误只记日志，不阻断流。
	persist func(unitID string, event JournalEvent)
	// bufferSize 每个单元在内存里保留多少条事件。超出的靠 persist 回放。
	bufferSize int
}

// JournalEvent 一条业务事件。Kind 是业务自己的事件名，通用层不解读 Data。
type JournalEvent struct {
	Seq  int             `json:"seq"`
	Kind string          `json:"kind"`
	Data json.RawMessage `json:"data,omitempty"`
	At   time.Time       `json:"at"`
	// Terminal 为真表示这是这个单元的最后一条事件，订阅者收到后可以收线。
	Terminal bool `json:"terminal,omitempty"`
}

type journalStream struct {
	mu     sync.Mutex
	events []JournalEvent
	// nextSeq 独立计数，不看缓冲长度：缓冲会被裁剪，seq 不能跟着重编号，
	// 否则消费者按 seq 续读会重复或跳过（这正是断线重连要靠的东西）。
	nextSeq     int
	subscribers map[int]chan JournalEvent
	nextSub     int
	closed      bool
}

func NewJournal(bufferSize int, persist func(unitID string, event JournalEvent)) *Journal {
	if bufferSize <= 0 {
		bufferSize = 512
	}
	return &Journal{streams: map[string]*journalStream{}, persist: persist, bufferSize: bufferSize}
}

func (j *Journal) stream(unitID string) *journalStream {
	j.mu.Lock()
	defer j.mu.Unlock()
	existing, ok := j.streams[unitID]
	if !ok {
		existing = &journalStream{subscribers: map[int]chan JournalEvent{}}
		j.streams[unitID] = existing
	}
	return existing
}

// Append 追加一条事件：先落库再广播。
// 顺序不能反 —— 先广播的话，消费者可能读到一条数据库里还不存在的事件，
// 断线重连时就会看到「刚才有、现在没了」。
func (j *Journal) Append(unitID string, event JournalEvent) JournalEvent {
	target := j.stream(unitID)
	target.mu.Lock()
	if target.closed {
		target.mu.Unlock()
		return event
	}
	target.nextSeq++
	event.Seq = target.nextSeq
	if event.At.IsZero() {
		event.At = time.Now()
	}
	target.events = append(target.events, event)
	if len(target.events) > j.bufferSize {
		target.events = target.events[len(target.events)-j.bufferSize:]
	}
	subscribers := make([]chan JournalEvent, 0, len(target.subscribers))
	for _, channel := range target.subscribers {
		subscribers = append(subscribers, channel)
	}
	target.mu.Unlock()

	if j.persist != nil {
		j.persist(unitID, event)
	}
	for _, channel := range subscribers {
		// 订阅者跟不上就丢给它，不阻塞节点上行 —— 慢的消费者不该拖住整条链路，
		// 它可以按 seq 从库里补齐。
		select {
		case channel <- event:
		default:
		}
	}
	return event
}

// Subscribe 从 fromSeq 之后开始订阅。返回的第一批是内存里的回放，
// 更早的事件要调用方自己从 unit_event 里取。
func (j *Journal) Subscribe(unitID string, fromSeq int) ([]JournalEvent, <-chan JournalEvent, func()) {
	target := j.stream(unitID)
	channel := make(chan JournalEvent, 64)

	target.mu.Lock()
	replay := make([]JournalEvent, 0, len(target.events))
	for _, event := range target.events {
		if event.Seq > fromSeq {
			replay = append(replay, event)
		}
	}
	if target.closed {
		target.mu.Unlock()
		close(channel)
		return replay, channel, func() {}
	}
	id := target.nextSub
	target.nextSub++
	target.subscribers[id] = channel
	target.mu.Unlock()

	return replay, channel, func() {
		target.mu.Lock()
		if _, ok := target.subscribers[id]; ok {
			delete(target.subscribers, id)
			close(channel)
		}
		target.mu.Unlock()
	}
}

// Finish 关闭一个单元的日志：叫醒所有订阅者，之后 Subscribe 只回放不等待。
func (j *Journal) Finish(unitID string) {
	target := j.stream(unitID)
	target.mu.Lock()
	if target.closed {
		target.mu.Unlock()
		return
	}
	target.closed = true
	for id, channel := range target.subscribers {
		delete(target.subscribers, id)
		close(channel)
	}
	target.mu.Unlock()
}

// Release 丢掉一个单元在内存里的日志。回放此后只能靠数据库。
func (j *Journal) Release(unitID string) {
	j.Finish(unitID)
	j.mu.Lock()
	delete(j.streams, unitID)
	j.mu.Unlock()
}
