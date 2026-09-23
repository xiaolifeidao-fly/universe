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
	// 点开「AI 回复已完成」要落在那段回复上，不是一张命令列表。
	if payload.Data.ItemKey != "mobile-docs" || payload.Data.RequirementKey != "req-mobile" || payload.Data.URL != "/workbench/tasks/mobile-docs/chat?programId=7" {
		t.Fatalf("AI 回复通知目标不正确：%#v", payload.Data)
	}
}

func TestCommandNotificationsLandOnTheScreenTheUserWants(t *testing.T) {
	planningInput, _ := json.Marshal(map[string]string{"requirementKey": "req-mobile"})
	planning, ok := commandPayload(dto.CommandView{
		CommandID: "cmd-planning", ProgramID: 7, CommandType: "task.planning", State: "succeeded", Input: planningInput,
	})
	if !ok || planning.Data.URL != "/workbench/requirements/req-mobile/chat?programId=7" {
		t.Fatalf("拆解通知未落在需求会话上：%#v", planning.Data)
	}
	// 落不到具体会话的命令仍然回运行记录：那里有进度、活动和结果。
	batch, ok := commandPayload(dto.CommandView{
		CommandID: "cmd-batch", ProgramID: 7, CommandType: "task.execute-batch", State: "succeeded",
	})
	if !ok || batch.Data.URL != "/commands?commandId=cmd-batch&programId=7" {
		t.Fatalf("批量执行通知目标不正确：%#v", batch.Data)
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

func TestCommandPayloadStaysSilentForSnapshotStopAndServerRaisedCommands(t *testing.T) {
	// 一轮拆解跑着的时候，会话页每几秒读一次快照：这些命令成功也不能点亮手机。
	for _, commandType := range []string{"task.planning-session", "task.session", "git.status", "requirement.usage"} {
		if _, ok := commandPayload(dto.CommandView{CommandID: "cmd-read", ProgramID: 7, CommandType: commandType, State: "succeeded"}); ok {
			t.Fatalf("快照命令不应推送通知：%s", commandType)
		}
		if _, ok := commandPayload(dto.CommandView{CommandID: "cmd-read", ProgramID: 7, CommandType: commandType, State: "failed", ErrorMessage: "Worker 离线"}); ok {
			t.Fatalf("快照命令失败也不应推送通知：%s", commandType)
		}
	}
	for _, commandType := range []string{
		"task.stop", "task.stop-all", "task.planning-stop", "business.conversation",
		// 新加的辅助会话各自带一条停止命令：靠后缀一次收敛，不用逐条补名单。
		"requirement.review-stop", "requirement.testing-stop", "task.fine-tuning-stop",
	} {
		if _, ok := commandPayload(dto.CommandView{CommandID: "cmd-quiet", ProgramID: 7, CommandType: commandType, State: "succeeded"}); ok {
			t.Fatalf("该命令不应推送通知：%s", commandType)
		}
	}
	if _, ok := commandPayload(dto.CommandView{CommandID: "cmd-run", ProgramID: 7, CommandType: "task.execute", State: "succeeded"}); !ok {
		t.Fatal("执行类命令仍然要推送通知")
	}
}
