package remote

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
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
		if got := request.Header.Get("token"); got != "" {
			t.Fatalf("business interview must not send a token header: %q", got)
		}
		switch request.Method {
		case http.MethodPost:
			postSeen = true
			var payload kodesConversationRequest
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
				t.Fatalf("decode payload: %v", err)
			}
			if payload.ProgramID != 42 || payload.ItemKey != "business-requirement-7" || payload.ThreadID != "thread-previous" || !payload.BusinessIntake || payload.Provider != "codex" || payload.Workspace != "alice/业务空间/业务项目" {
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
			if query.Get("programId") != "42" || query.Get("itemKey") != "business-requirement-7" || query.Get("provider") != "codex" || query.Get("threadId") != "thread-1" || query.Get("workspace") != "alice/业务空间/业务项目" || query.Get("businessIntake") != "true" {
				t.Fatalf("unexpected conversation query: %q", request.URL.RawQuery)
			}
			if getCount == 1 {
				_, _ = writer.Write([]byte(`{"threadId":"thread-1","active":true,"turns":[{"id":"turn-1","status":"running","items":[{"type":"agentMessage","text":"正在整理业务背景"}]}]}`))
				return
			}
			_, _ = writer.Write([]byte(`{"threadId":"thread-1","active":false,"turns":[{"id":"turn-1","status":"completed","items":[{"type":"agentMessage","text":"已整理业务诉求","phase":"final_answer"}]}]}`))
		default:
			t.Fatalf("unexpected method: %s", request.Method)
		}
	}))
	defer server.Close()

	assistant := NewBusinessAssistant(server.URL, "kodes-model", "medium", 2*time.Second)
	action, err := assistant.Start(context.Background(), dto.ProgramContext{
		ProgramID: 42, ProgramCode: "biz-42", Name: "业务项目", Summary: "供业务方提交诉求",
	}, 7, []dto.MessageView{{Role: "user", Content: "希望简化登录"}}, "thread-previous", "alice/业务空间/业务项目", nil)
	if err != nil {
		t.Fatalf("Start returned error: %v", err)
	}
	if !action.Active || action.ThreadID != "thread-1" || action.TurnID != "turn-1" || !postSeen || getCount != 0 {
		t.Fatalf("unexpected action: %#v postSeen=%t getCount=%d", action, postSeen, getCount)
	}
	state, err := assistant.Poll(context.Background(), 42, 7, action.ThreadID, action.TurnID, "alice/业务空间/业务项目")
	if err != nil {
		t.Fatalf("first Poll returned error: %v", err)
	}
	if !state.Active || state.Finished || state.Reply != "正在整理业务背景" {
		t.Fatalf("unexpected running state: %#v", state)
	}
	state, err = assistant.Poll(context.Background(), 42, 7, action.ThreadID, action.TurnID, "alice/业务空间/业务项目")
	if err != nil {
		t.Fatalf("second Poll returned error: %v", err)
	}
	if state.Active || !state.Finished || state.Failed || state.Reply != "已整理业务诉求" || getCount != 2 {
		t.Fatalf("unexpected completed state: %#v getCount=%d", state, getCount)
	}
}

func TestBusinessAssistantRequiresBusinessWorkspace(t *testing.T) {
	assistant := NewBusinessAssistant("https://kodes.example", "", "", time.Second)
	_, err := assistant.Start(context.Background(), dto.ProgramContext{ProgramID: 1}, 1, []dto.MessageView{{Role: "user", Content: "测试"}}, "", "", nil)
	if err == nil || !strings.Contains(err.Error(), "业务工作目录") {
		t.Fatalf("expected workspace error, got %v", err)
	}
}

func TestBusinessAssistantDefaultsToMediumReasoningEffort(t *testing.T) {
	if effort := NewBusinessAssistant("https://kodes.example", "", "  ", time.Second).reasoningEffort; effort != "medium" {
		t.Fatalf("expected the medium default, got %q", effort)
	}
	if effort := NewBusinessAssistant("https://kodes.example", "", "high", time.Second).reasoningEffort; effort != "high" {
		t.Fatalf("expected the configured effort to win, got %q", effort)
	}
}

func TestConversationStateCarriesRunningTurnActivities(t *testing.T) {
	var conversation kodesConversation
	if err := json.Unmarshal([]byte(`{"threadId":"thread-1","active":true,"turns":[{"id":"turn-1","status":"running","items":[
		{"id":"i0","type":"userMessage","text":"怎么搞直播呢"},
		{"id":"i1","type":"reasoning","text":"先弄清品类和客单价"},
		{"id":"i2","type":"commandExecution","text":"ls doc","status":"completed"},
		{"id":"i3","type":"mcpToolCall","action":"read","target":"doc/背景.md"},
		{"id":"i4","type":"agentMessage","text":"正在整理业务背景"}
	]}]}`), &conversation); err != nil {
		t.Fatalf("decode conversation: %v", err)
	}
	state := conversation.stateFor("turn-1")
	if state.Reply != "正在整理业务背景" || !state.Active || state.Finished {
		t.Fatalf("unexpected state: %#v", state)
	}
	want := []dto.ConversationActivity{
		{ID: "i1", Type: "reasoning", Text: "先弄清品类和客单价"},
		{ID: "i2", Type: "commandExecution", Text: "ls doc", Status: "completed"},
		{ID: "i3", Type: "mcpToolCall", Action: "read", Target: "doc/背景.md"},
	}
	if !reflect.DeepEqual(want, state.Activities) {
		t.Fatalf("unexpected activities: %#v", state.Activities)
	}
}

func TestConversationStateReportsNoActivitiesForAFailedTurn(t *testing.T) {
	var conversation kodesConversation
	if err := json.Unmarshal([]byte(`{"threadId":"thread-1","active":false,"turns":[{"id":"turn-1","status":"failed","items":[
		{"id":"i0","type":"userMessage","text":"怎么搞直播呢"},
		{"id":"i1","type":"reasoning","text":"想了一半"}
	]}]}`), &conversation); err != nil {
		t.Fatalf("decode conversation: %v", err)
	}
	state := conversation.stateFor("turn-1")
	if !state.Failed || !state.Finished || state.Activities != nil {
		t.Fatalf("unexpected failed state: %#v", state)
	}
}

func TestBusinessAssistantUploadsAndReadsBackAttachments(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case kodesAttachmentsPath:
			if err := request.ParseMultipartForm(1 << 20); err != nil {
				t.Fatalf("parse multipart: %v", err)
			}
			if request.FormValue("programId") != "42" || request.FormValue("itemKey") != "business-requirement-7" || request.FormValue("workspace") != "alice/业务空间/业务项目" {
				t.Fatalf("unexpected upload fields: %#v", request.MultipartForm.Value)
			}
			files := request.MultipartForm.File["files"]
			if len(files) != 1 || files[0].Filename != "背景.png" {
				t.Fatalf("unexpected upload files: %#v", files)
			}
			writer.WriteHeader(http.StatusCreated)
			_, _ = writer.Write([]byte(`{"attachments":[{"id":"att-1","name":"背景.png","contentType":"image/png","size":12,"isImage":true}]}`))
		case kodesAttachmentPath:
			query := request.URL.Query()
			if query.Get("attachmentId") != "att-1" || query.Get("itemKey") != "business-requirement-7" || query.Get("workspace") != "alice/业务空间/业务项目" {
				t.Fatalf("unexpected download query: %q", request.URL.RawQuery)
			}
			writer.Header().Set("Content-Type", "image/png")
			_, _ = writer.Write([]byte("png-bytes"))
		default:
			t.Fatalf("unexpected path: %s", request.URL.Path)
		}
	}))
	defer server.Close()

	assistant := NewBusinessAssistant(server.URL, "", "", 2*time.Second)
	uploaded, err := assistant.UploadAttachments(context.Background(), 42, 7, "alice/业务空间/业务项目", []dto.AttachmentUpload{
		{Name: "背景.png", ContentType: "image/png", Data: []byte("png-bytes")},
	})
	if err != nil {
		t.Fatalf("UploadAttachments returned error: %v", err)
	}
	want := []dto.AttachmentView{{ID: "att-1", Name: "背景.png", ContentType: "image/png", Size: 12, IsImage: true}}
	if !reflect.DeepEqual(want, uploaded) {
		t.Fatalf("unexpected uploaded attachments: %#v", uploaded)
	}
	content, err := assistant.DownloadAttachment(context.Background(), 42, 7, "alice/业务空间/业务项目", "att-1")
	if err != nil {
		t.Fatalf("DownloadAttachment returned error: %v", err)
	}
	if string(content.Data) != "png-bytes" || content.ContentType != "image/png" {
		t.Fatalf("unexpected attachment content: %#v", content)
	}
}
