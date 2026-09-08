package core

import (
	"bytes"
	"encoding/json"

	"contract"
)

// journalWriter 是 session / job 的写回器：节点上行的是 NDJSON 事件而不是响应字节，
// 收下来进日志，消费者随时订阅。
//
// relay 的写回器直接对拷到消费者连接，这里不行 —— 一个回合可能跑几分钟，
// 中间没有任何一条消费者连接是必须活着的。
type journalWriter struct {
	journal *Journal
	unitID  string
	buffer  bytes.Buffer
	usage   contract.Metering
}

// NewJournalWriter 供 session / job 适配器在 Writer() 里返回。
func NewJournalWriter(journal *Journal, unitID string) EventWriter {
	return &journalWriter{journal: journal, unitID: unitID}
}

// nodeEvent 是节点上行的一行 NDJSON。通用层只认 kind 与 usage 两个字段，
// data 原样转给消费者。
type nodeEvent struct {
	Kind  string            `json:"kind"`
	Data  json.RawMessage   `json:"data,omitempty"`
	Usage contract.Metering `json:"usage,omitempty"`
}

func (w *journalWriter) Head(int, map[string]string) {}

// Write 按行切分。一条事件可能跨多个 chunk，所以要缓冲到换行为止。
func (w *journalWriter) Write(chunk []byte) error {
	w.buffer.Write(chunk)
	for {
		line, err := w.buffer.ReadBytes('\n')
		if err != nil {
			// 没读到换行：把这半行放回去，等下一个 chunk。
			w.buffer.Reset()
			w.buffer.Write(line)
			return nil
		}
		w.consume(bytes.TrimSpace(line))
	}
}

func (w *journalWriter) consume(line []byte) {
	if len(line) == 0 {
		return
	}
	var event nodeEvent
	if err := json.Unmarshal(line, &event); err != nil {
		// 节点吐了不合规的一行：记成 malformed 而不是丢掉，
		// 排障时能看出是节点的问题而不是 Hub 吃了事件。
		w.journal.Append(w.unitID, JournalEvent{Kind: "malformed", Data: json.RawMessage(mustQuote(line))})
		return
	}
	if len(event.Usage) > 0 {
		w.usage = w.usage.Add(event.Usage)
	}
	if event.Kind == "" {
		event.Kind = "event"
	}
	w.journal.Append(w.unitID, JournalEvent{Kind: event.Kind, Data: event.Data})
}

func (w *journalWriter) End() {
	if rest := bytes.TrimSpace(w.buffer.Bytes()); len(rest) > 0 {
		w.consume(rest)
	}
	w.journal.Append(w.unitID, JournalEvent{Kind: "end", Terminal: true})
	w.journal.Finish(w.unitID)
}

func (w *journalWriter) Abort(err error) {
	message, _ := json.Marshal(map[string]string{"message": err.Error()})
	w.journal.Append(w.unitID, JournalEvent{Kind: "aborted", Data: message, Terminal: true})
	w.journal.Finish(w.unitID)
}

func (w *journalWriter) Usage() contract.Metering { return w.usage }

func mustQuote(raw []byte) []byte {
	quoted, err := json.Marshal(string(raw))
	if err != nil {
		return []byte(`"<unprintable>"`)
	}
	return quoted
}
