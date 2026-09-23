package businessassistant

import "testing"

// 业务访谈的默认落点是那台常驻访谈主机。没配、配错都不该退化成命令队列：
// 那会让每一轮访谈停在队列里等一个可能根本没上线的 Worker。
func TestNewDefaultsToTheInterviewHost(t *testing.T) {
	for _, transport := range []string{"", "  ", "http", "HTTP", "kodes"} {
		assistant := New(Config{Transport: transport, RemoteURL: "http://interview.example"}, nil)
		if _, ok := assistant.(*BusinessAssistant); !ok {
			t.Fatalf("transport=%q 应该走访谈主机，实际拿到 %T", transport, assistant)
		}
	}
}

func TestNewUsesTheCommandQueueOnlyWhenAskedExplicitly(t *testing.T) {
	assistant := New(Config{Transport: " Command ", WorkerUserID: " 42 "}, nil)
	command, ok := assistant.(*BusinessCommandAssistant)
	if !ok {
		t.Fatalf("transport=command 应该走命令队列，实际拿到 %T", assistant)
	}
	if command.WorkerUserID != "42" {
		t.Fatalf("Worker 归属未去空白：%q", command.WorkerUserID)
	}
}
