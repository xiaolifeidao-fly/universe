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
	action, err := assistant.Start(context.Background(), dto.ConversationStartRequest{
		Program: dto.ProgramContext{
			ProgramID: 42, ProgramCode: "biz-42", Name: "业务项目", Summary: "供业务方提交诉求",
		},
		RequirementID: 7,
		History:       []dto.MessageView{{Role: "user", Content: "希望简化登录"}},
		ThreadID:      "thread-previous",
		Workspace:     "alice/业务空间/业务项目",
	})
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
	_, err := assistant.Start(context.Background(), dto.ConversationStartRequest{
		Program:       dto.ProgramContext{ProgramID: 1},
		RequirementID: 1,
		History:       []dto.MessageView{{Role: "user", Content: "测试"}},
	})
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

// @ 引用必须以「既有资料」的身份进提示词，而不是混进本轮诉求：
// 混进去的话，助手会把旧访谈的结论当成业务方这次新提的要求。
func TestBusinessConversationMessageLabelsReferences(t *testing.T) {
	message := businessConversationMessage(
		dto.ProgramContext{ProgramID: 1, Name: "业务项目", ProgramCode: "biz-1"},
		[]dto.MessageView{{Role: "user", Content: "这次想做直播"}},
		[]dto.DocumentReference{{RequirementTitle: "上次访谈", Title: "AI 访谈整理", Version: 3, Content: "结论：先做选品"}},
	)
	if !strings.Contains(message, "业务方引用的既有资料") {
		t.Fatalf("reference block missing: %s", message)
	}
	if !strings.Contains(message, "【上次访谈 · AI 访谈整理（第 3 版）】") || !strings.Contains(message, "结论：先做选品") {
		t.Fatalf("reference body missing: %s", message)
	}
	if strings.Index(message, "业务方引用的既有资料") > strings.Index(message, "业务方本轮输入") {
		t.Fatalf("reference block must precede this turn's input: %s", message)
	}
}

// 空内容的引用不该在提示词里留下一个只有标题的空壳。
func TestBusinessConversationMessageSkipsEmptyReference(t *testing.T) {
	message := businessConversationMessage(
		dto.ProgramContext{ProgramID: 1},
		[]dto.MessageView{{Role: "user", Content: "继续"}},
		[]dto.DocumentReference{{RequirementTitle: "空访谈", Title: "空文档", Version: 1, Content: "   "}},
	)
	if strings.Contains(message, "空文档") {
		t.Fatalf("empty reference should be dropped: %s", message)
	}
}
