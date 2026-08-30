package remote

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"service/business/dto"
)

func TestBusinessAssistantUsesRemoteKodesConversationProtocol(t *testing.T) {
	postSeen := false
	getCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != kodesConversationPath {
			t.Fatalf("unexpected path: %s", request.URL.Path)
		}
		if got := request.Header.Get("token"); got != "remote-token" {
			t.Fatalf("unexpected token header: %q", got)
		}
		switch request.Method {
		case http.MethodPost:
			postSeen = true
			var payload kodesConversationRequest
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
				t.Fatalf("decode payload: %v", err)
			}
			if payload.ProgramID != 42 || payload.ItemKey != "business-requirement-7" || payload.Provider != "codex" || payload.Workspace != "remote-business" {
				t.Fatalf("unexpected payload: %#v", payload)
			}
			if payload.Model != "kodes-model" || payload.ReasoningEffort != "medium" || !strings.Contains(payload.Message, "当前项目：业务项目（biz-42）") || !strings.Contains(payload.Message, "业务方本轮输入：\n希望简化登录") {
				t.Fatalf("unexpected conversation message: %#v", payload)
			}
			writer.WriteHeader(http.StatusAccepted)
			_, _ = writer.Write([]byte(`{"accepted":true,"programId":42,"itemKey":"business-requirement-7","threadId":"thread-1","turnId":"turn-1","active":true}`))
		case http.MethodGet:
			getCount++
			query := request.URL.Query()
			if query.Get("programId") != "42" || query.Get("itemKey") != "business-requirement-7" || query.Get("provider") != "codex" || query.Get("threadId") != "thread-1" || query.Get("workspace") != "remote-business" {
				t.Fatalf("unexpected conversation query: %q", request.URL.RawQuery)
			}
			if getCount == 1 {
				_, _ = writer.Write([]byte(`{"threadId":"thread-1","active":true,"turns":[{"id":"turn-1","status":"running","items":[]}]}`))
				return
			}
			_, _ = writer.Write([]byte(`{"threadId":"thread-1","active":false,"turns":[{"id":"turn-1","status":"completed","items":[{"type":"agentMessage","text":"已整理业务诉求","phase":"final_answer"}]}]}`))
		default:
			t.Fatalf("unexpected method: %s", request.Method)
		}
	}))
	defer server.Close()

	assistant := NewBusinessAssistant(server.URL, "remote-token", "remote-business", "kodes-model", "medium", 2*time.Second)
	reply, err := assistant.Reply(context.Background(), dto.ProgramContext{
		ProgramID: 42, ProgramCode: "biz-42", Name: "业务项目", Summary: "供业务方提交诉求",
	}, 7, []dto.MessageView{{Role: "user", Content: "希望简化登录"}})
	if err != nil {
		t.Fatalf("Reply returned error: %v", err)
	}
	if reply != "已整理业务诉求" || !postSeen || getCount != 2 {
		t.Fatalf("unexpected result: reply=%q postSeen=%t getCount=%d", reply, postSeen, getCount)
	}
}

func TestBusinessAssistantRequiresRemoteWorkspace(t *testing.T) {
	assistant := NewBusinessAssistant("https://kodes.example", "", "", "", "", time.Second)
	_, err := assistant.Reply(context.Background(), dto.ProgramContext{ProgramID: 1}, 1, []dto.MessageView{{Role: "user", Content: "测试"}})
	if err == nil || !strings.Contains(err.Error(), "工作区标识") {
		t.Fatalf("expected workspace error, got %v", err)
	}
}
