package push

import (
	"encoding/json"
	"testing"

	"service/delivery/dto"
)

func TestCommandPayloadSeparatesBlockedFromFailure(t *testing.T) {
	blockedResult, _ := json.Marshal(map[string]string{"status": "blocked"})
	blocked, ok := commandPayload(dto.CommandView{CommandID: "cmd-1", ProgramID: 7, State: "failed", Result: blockedResult, ErrorMessage: "等待人工确认"})
	if !ok || blocked.Title != "任务被阻塞" || blocked.Data.Kind != "command_blocked" || blocked.Data.URL != "/commands?commandId=cmd-1&programId=7" {
		t.Fatalf("阻塞通知不正确：%#v ok=%v", blocked, ok)
	}
	failed, ok := commandPayload(dto.CommandView{CommandID: "cmd-2", ProgramID: 7, State: "failed", ErrorMessage: "执行退出"})
	if !ok || failed.Title != "任务失败" || failed.Data.Kind != "command_failed" {
		t.Fatalf("失败通知不正确：%#v ok=%v", failed, ok)
	}
	completed, ok := commandPayload(dto.CommandView{CommandID: "cmd-3", ProgramID: 7, State: "succeeded"})
	if !ok || completed.Title != "任务已完成" || completed.Data.Kind != "command_completed" {
		t.Fatalf("完成通知不正确：%#v ok=%v", completed, ok)
	}
}

func TestCommandPayloadRoutesAIRepliesToTheirConversationCommand(t *testing.T) {
	input, _ := json.Marshal(map[string]string{"itemKey": "mobile-docs", "requirementKey": "req-mobile"})
	payload, ok := commandPayload(dto.CommandView{
		CommandID: "cmd-reply", ProgramID: 7, CommandType: "task.conversation", State: "succeeded", Input: input,
	})
	if !ok || payload.Title != "AI 回复已完成" || payload.Data.Kind != "ai_reply_completed" {
		t.Fatalf("AI 回复通知不正确：%#v ok=%v", payload, ok)
	}
	if payload.Data.ItemKey != "mobile-docs" || payload.Data.RequirementKey != "req-mobile" || payload.Data.URL != "/commands?commandId=cmd-reply&itemKey=mobile-docs&programId=7&requirementKey=req-mobile" {
		t.Fatalf("AI 回复通知目标不正确：%#v", payload.Data)
	}
}

func TestNormalizeSubscriptionRejectsNonHTTPSAndMissingKeys(t *testing.T) {
	var req SubscriptionRequest
	req.Endpoint = "http://push.example/subscription"
	req.Keys.P256DH = "key"
	req.Keys.Auth = "auth"
	if _, _, _, err := normalizeSubscription(req); err == nil {
		t.Fatal("非 HTTPS endpoint 必须拒绝")
	}
	req.Endpoint = "https://push.example/subscription"
	req.Keys.Auth = ""
	if _, _, _, err := normalizeSubscription(req); err == nil {
		t.Fatal("缺少订阅密钥必须拒绝")
	}
}
