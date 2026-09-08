package relay

import "bytes"

// SSE 事件扫描器。上游的字节按 TCP 分片到达，一个事件可能跨多个 chunk，
// 所以必须自己缓冲到空行（\n\n）才算一个完整事件。
//
// 它只用来「窥探」：解析出的事件不影响写回消费者的字节（除非 Hub 自己注入过参数）。
type sseScanner struct {
	buffer bytes.Buffer
}

type sseEvent struct {
	// Raw 是这个事件的原始字节（含结尾空行），透传时按它重放。
	Raw  []byte
	Name string
	Data []byte
}

// Push 喂入一段字节，返回其中已经完整的事件。
func (s *sseScanner) Push(chunk []byte) []sseEvent {
	s.buffer.Write(chunk)
	var events []sseEvent
	for {
		raw := s.buffer.Bytes()
		index := bytes.Index(raw, []byte("\n\n"))
		if index < 0 {
			break
		}
		block := make([]byte, index+2)
		copy(block, raw[:index+2])
		s.buffer.Next(index + 2)
		events = append(events, parseSSE(block))
	}
	return events
}

// Rest 返回缓冲区里还没构成完整事件的尾巴。流结束时要把它写出去。
func (s *sseScanner) Rest() []byte {
	if s.buffer.Len() == 0 {
		return nil
	}
	rest := make([]byte, s.buffer.Len())
	copy(rest, s.buffer.Bytes())
	s.buffer.Reset()
	return rest
}

func parseSSE(block []byte) sseEvent {
	event := sseEvent{Raw: block}
	var data bytes.Buffer
	for _, line := range bytes.Split(block, []byte("\n")) {
		line = bytes.TrimSuffix(line, []byte("\r"))
		switch {
		case bytes.HasPrefix(line, []byte("event:")):
			event.Name = string(bytes.TrimSpace(line[len("event:"):]))
		case bytes.HasPrefix(line, []byte("data:")):
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.Write(bytes.TrimSpace(line[len("data:"):]))
		}
	}
	event.Data = data.Bytes()
	return event
}
