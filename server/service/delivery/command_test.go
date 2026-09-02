package delivery

import (
	"encoding/json"
	"testing"
	"time"

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

func TestNarrowCommandCapabilitiesKeepsClaimLanesInsideRegisteredAbilities(t *testing.T) {
	capabilities := []string{"task.execute", "task.session", "git.status"}

	if got := narrowCommandCapabilities(capabilities, nil); len(got) != 3 {
		t.Fatalf("未申请类型时应保留全部能力，实际 %v", got)
	}
	got := narrowCommandCapabilities(capabilities, []string{"task.session", "GIT.STATUS", "task.delete-everything", "非法类型"})
	if len(got) != 2 || got[0] != "task.session" || got[1] != "git.status" {
		t.Fatalf("只读通道不应扩权，实际 %v", got)
	}
	if got := narrowCommandCapabilities(capabilities, []string{"task.planning"}); len(got) != 0 {
		t.Fatalf("未登记的类型不应被领取，实际 %v", got)
	}
}


func TestReadOnlyCommandTypesStayOutOfTheActivityLog(t *testing.T) {
	if !IsReadOnlyCommand(" GIT.STATUS ") || !IsReadOnlyCommand("task.planning-session") {
		t.Fatal("快照命令未被识别为只读")
	}
	if IsReadOnlyCommand("task.planning") || IsReadOnlyCommand("git.push") {
		t.Fatal("执行类命令不能被当成快照")
	}
	excluded := readOnlyCommandTypeList()
	if len(excluded) != len(readOnlyCommandTypes) {
		t.Fatalf("排除清单与词表不一致：%d != %d", len(excluded), len(readOnlyCommandTypes))
	}
	for i := 1; i < len(excluded); i++ {
		if excluded[i-1] >= excluded[i] {
			t.Fatalf("排除清单未按稳定顺序输出：%#v", excluded)
		}
	}
}

func TestCommandWorkerOnlineUsesTheSameWindowAsDispatch(t *testing.T) {
	now := time.Now()
	if !commandWorkerOnline(now.Add(-commandWorkerOnlineWindow+time.Second), now) {
		t.Fatal("窗口内的心跳应判定为在线")
	}
	if commandWorkerOnline(now.Add(-commandWorkerOnlineWindow-time.Second), now) {
		t.Fatal("超出窗口的心跳应判定为离线")
	}
	if commandWorkerOnline(time.Time{}, now) {
		t.Fatal("从未心跳过的 Worker 不能算在线")
	}
}

func TestStaleReadOnlyCommandsAreNotWorthDispatching(t *testing.T) {
	now := time.Now()
	if !staleReadOnlyCommand("git.status", now.Add(-readOnlyCommandStaleWindow-time.Second), now) {
		t.Fatal("过期的界面快照不应再下发")
	}
	if staleReadOnlyCommand("git.status", now.Add(-time.Second), now) {
		t.Fatal("刚提交的快照命令必须照常下发")
	}
	if staleReadOnlyCommand("task.execute", now.Add(-time.Hour), now) {
		t.Fatal("执行类命令等再久也要跑：用户按过的动作不能被静默丢掉")
	}
}
