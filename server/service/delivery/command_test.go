package delivery

import (
	"encoding/json"
	"testing"

	"contract"
)

func TestNormalizeCommandJSONObjectRequiresObject(t *testing.T) {
	value, err := normalizeCommandJSONObject(json.RawMessage(`{"task":"run"}`), maxCommandInputBytes, "命令输入")
	if err != nil || value != `{"task":"run"}` {
		t.Fatalf("有效对象归一化失败：%q, %v", value, err)
	}
	if _, err := normalizeCommandJSONObject(json.RawMessage(`["not-an-object"]`), maxCommandInputBytes, "命令输入"); err == nil {
		t.Fatal("数组不能作为命令输入")
	}
	if _, err := normalizeCommandJSONObject(json.RawMessage(`null`), maxCommandInputBytes, "命令输入"); err == nil {
		t.Fatal("null 不能作为命令输入")
	}
	if _, err := normalizeCommandJSONObject(json.RawMessage(`{"workspace":"/Users/example/project"}`), maxCommandInputBytes, "命令输入"); err == nil {
		t.Fatal("命令不能把本机绝对路径下发给 Worker")
	}
	if _, err := normalizeCommandJSONObject(json.RawMessage(`{"relativePath":"doc/task/文档.md"}`), maxCommandInputBytes, "命令输入"); err != nil {
		t.Fatalf("项目内相对路径应允许：%v", err)
	}
}

func TestNormalizeCapabilitiesAndProgramsRejectUnsafeWorkerRegistration(t *testing.T) {
	capabilities, err := normalizeCapabilities([]string{" task.execute ", "task.execute", "git.status"})
	if err != nil || len(capabilities) != 2 || capabilities[0] != "task.execute" || capabilities[1] != "git.status" {
		t.Fatalf("能力未正确去重归一：%#v, %v", capabilities, err)
	}
	if _, err := normalizeCapabilities(nil); err == nil {
		t.Fatal("Worker 未声明能力时不应能领取命令")
	}
	programs, err := normalizeProgramIDs([]int64{16, 16, 20})
	if err != nil || len(programs) != 2 {
		t.Fatalf("工作目录项目映射未正确去重：%#v, %v", programs, err)
	}
	if _, err := normalizeProgramIDs([]int64{0}); err == nil {
		t.Fatal("无效项目不能登记为本机工作目录映射")
	}
}

func TestValidateLeasedCommandBindsUserWorkerAndToken(t *testing.T) {
	if err := validateLeasedCommand(contract.BizLine("whatsapp"), "42", "worker_1", "cmd-a", "lease"); err != nil {
		t.Fatalf("有效租约被拒绝：%v", err)
	}
	if err := validateLeasedCommand(contract.BizLine(""), "42", "worker_1", "cmd-a", "lease"); err == nil {
		t.Fatal("没有业务线的租约请求必须拒绝")
	}
	if err := validateLeasedCommand(contract.BizLine("whatsapp"), "42", "worker_1", "cmd-a", ""); err == nil {
		t.Fatal("没有租约令牌的回传必须拒绝")
	}
}

func TestCommandCompletionMessagesAreTerminalSpecific(t *testing.T) {
	if got := completionMessage(CommandStateSucceeded, ""); got != "Worker 已完成命令" {
		t.Fatalf("succeeded 提示 = %q", got)
	}
	if got := completionMessage(CommandStateCancelled, ""); got != "Worker 已取消命令" {
		t.Fatalf("cancelled 提示 = %q", got)
	}
	if got := completionMessage(CommandStateFailed, "连接失败"); got != "连接失败" {
		t.Fatalf("显式错误应原样保留，实际 %q", got)
	}
}

func TestWithCommandProgressKeepsSSEActivitySelfContained(t *testing.T) {
	progress := 47
	data := withCommandProgress(`{"step":"build"}`, &progress)
	if data != `{"progress":47,"step":"build"}` && data != `{"step":"build","progress":47}` {
		t.Fatalf("活动事件未携带进度：%s", data)
	}
}
