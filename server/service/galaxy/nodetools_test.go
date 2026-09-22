package galaxy

import (
	"encoding/json"
	"testing"
	"time"

	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

func toolsJSON(t *testing.T, reports ...dto.NodeToolReport) string {
	t.Helper()
	encoded, err := json.Marshal(reports)
	if err != nil {
		t.Fatalf("序列化失败：%v", err)
	}
	return string(encoded)
}

// 指令发出去到机器来领之间（最多一个心跳）界面上必须有东西在动，
// 否则点完按钮什么都不变，看起来就像没点上。
func TestNodeToolViewsShowPendingBeforeTheMachinePicksItUp(t *testing.T) {
	now := time.Date(2026, 9, 22, 10, 0, 0, 0, time.UTC)
	fresh := now.Add(-5 * time.Second)
	node := &repository.GalaxyNode{
		LastBeatAt: &fresh,
		ToolsJSON: toolsJSON(t,
			dto.NodeToolReport{Name: "claude", Current: "2.1.278", Latest: "2.1.280", Upgradable: true, Installed: true},
			dto.NodeToolReport{Name: "codex", Latest: "0.155.1"},
		),
		ToolCommandID: "tl_1", ToolCommandName: "codex", ToolCommandAt: &fresh,
	}
	views := nodeToolViews(node, now)
	if len(views) != 2 {
		t.Fatalf("两个工具都该在，得到 %d 个", len(views))
	}
	claude := findToolView(views, "claude")
	if claude == nil || claude.Job != nil {
		t.Fatalf("没被点的那个不该凭空多出一条进度：%+v", claude)
	}
	codex := findToolView(views, "codex")
	if codex == nil || codex.Job == nil || codex.Job.State != dto.ToolJobPending {
		t.Fatalf("被点的那个该显示「等机器领取」，得到 %+v", codex)
	}
	// 没装过的那个是「安装」不是「升级」—— 界面上是两句话。
	if codex.Job.Action != "install" {
		t.Fatalf("没装过的工具该报 install，得到 %s", codex.Job.Action)
	}
	if codex.Job.CommandID != "tl_1" {
		t.Fatalf("进度要带上指令 id，得到 %q", codex.Job.CommandID)
	}
}

// 机器开工之后，pending 就该让位给机器自己报的真进度。
func TestNodeToolViewsPreferTheMachineReport(t *testing.T) {
	now := time.Date(2026, 9, 22, 10, 0, 0, 0, time.UTC)
	fresh := now.Add(-3 * time.Second)
	node := &repository.GalaxyNode{
		LastBeatAt: &fresh,
		ToolsJSON: toolsJSON(t, dto.NodeToolReport{
			Name: "codex", Latest: "0.155.1",
			Job: &dto.NodeToolJob{
				CommandID: "tl_1", Action: "install", State: dto.ToolJobRunning,
				Phase: "downloading", Percent: 40,
			},
		}),
		ToolCommandID: "tl_1", ToolCommandName: "codex", ToolCommandAt: &fresh,
	}
	job := findToolView(nodeToolViews(node, now), "codex").Job
	if job == nil || job.State != dto.ToolJobRunning || job.Percent != 40 {
		t.Fatalf("该显示机器报的进度，得到 %+v", job)
	}
}

// 机器不说话了，进度条不能永远转下去。
func TestNodeToolViewsFoldSilentMachinesIntoFailure(t *testing.T) {
	now := time.Date(2026, 9, 22, 10, 0, 0, 0, time.UTC)
	silent := now.Add(-time.Hour)
	node := &repository.GalaxyNode{
		LastBeatAt: &silent,
		ToolsJSON: toolsJSON(t, dto.NodeToolReport{
			Name: "claude", Current: "2.1.278", Installed: true,
			Job: &dto.NodeToolJob{CommandID: "tl_9", State: dto.ToolJobRunning, Phase: "downloading", Percent: 40},
		}),
	}
	job := findToolView(nodeToolViews(node, now), "claude").Job
	if job == nil || job.State != dto.ToolJobFailed || job.Detail == "" {
		t.Fatalf("久无回音的进度该折算成失败并说明原因，得到 %+v", job)
	}

	// 已经结束的那些不受影响：一次半小时前的成功仍然是成功。
	done := &repository.GalaxyNode{
		LastBeatAt: &silent,
		ToolsJSON: toolsJSON(t, dto.NodeToolReport{
			Name: "claude", Current: "2.1.280", Installed: true,
			Job: &dto.NodeToolJob{CommandID: "tl_8", State: dto.ToolJobSucceeded, Phase: "done", Percent: 100},
		}),
	}
	if job := findToolView(nodeToolViews(done, now), "claude").Job; job.State != dto.ToolJobSucceeded {
		t.Fatalf("终态不该被超时改写，得到 %+v", job)
	}
}

// 过期的指令不再下发，也不再在界面上挂着 —— 机器几小时后回来突然开始装东西，
// 比没装上更糟。
func TestPendingToolCommandExpires(t *testing.T) {
	now := time.Date(2026, 9, 22, 10, 0, 0, 0, time.UTC)
	stale := now.Add(-toolCommandPendingTTL - time.Minute)
	fresh := now.Add(-time.Second)
	service := &service{}

	if command := service.pendingToolCommand(&repository.GalaxyNode{}, now); command != nil {
		t.Fatal("没点过的机器不该收到指令")
	}
	expired := &repository.GalaxyNode{ToolCommandID: "tl_1", ToolCommandName: "claude", ToolCommandAt: &stale}
	if command := service.pendingToolCommand(expired, now); command != nil {
		t.Fatalf("过期的指令不该再发，得到 %+v", command)
	}
	if views := nodeToolViews(expired, now); len(views) != 0 {
		t.Fatalf("过期的指令不该在界面上挂着，得到 %+v", views)
	}
	live := &repository.GalaxyNode{ToolCommandID: "tl_2", ToolCommandName: "claude", ToolCommandAt: &fresh}
	command := service.pendingToolCommand(live, now)
	if command == nil || command.ID != "tl_2" || command.Tool != "claude" {
		t.Fatalf("刚点下的指令该照发，得到 %+v", command)
	}
}

// 点不动的时候必须说得出为什么。尤其是「机器上那版 ai-bridge 还不认识这个功能」——
// 不说的话，主人只会看着一个「等机器领取」挂满十分钟。
func TestCheckNodeToolReadyExplainsEveryRefusal(t *testing.T) {
	ready := toolsJSON(t, dto.NodeToolReport{Name: "claude"})
	cases := []struct {
		name string
		node *repository.GalaxyNode
	}{
		{"封禁", &repository.GalaxyNode{Banned: true, Status: statusActive, ToolsJSON: ready}},
		{"已解绑", &repository.GalaxyNode{Status: "revoked", ToolsJSON: ready}},
		{"不在线", &repository.GalaxyNode{Status: "offline", ToolsJSON: ready}},
		{"老版本 ai-bridge", &repository.GalaxyNode{Status: statusActive}},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			err := checkNodeToolReady(item.node)
			if err == nil {
				t.Fatal("这种机器不该能收指令")
			}
			if err.Error() == "" {
				t.Fatal("拒绝必须说出原因")
			}
		})
	}
	if err := checkNodeToolReady(&repository.GalaxyNode{Status: statusActive, ToolsJSON: ready}); err != nil {
		t.Fatalf("在线、报过工具的机器该能收指令，得到 %v", err)
	}
}

// 一台机器同时只装一个：待下发的指令只有一个槽，点第二个会把第一个顶掉 ——
// 而那时界面上第一个刚说完「等机器领取」。RequestNodeTool 就是照着这个判断拒第二次的，
// 这里验的是那个判断本身（它要跨所有工具看，不只看被点的那一个）。
func TestBusyToolIsDetectedAcrossEveryToolOnTheMachine(t *testing.T) {
	now := time.Now()
	fresh := now.Add(-2 * time.Second)
	node := &repository.GalaxyNode{
		Status: statusActive, LastBeatAt: &fresh,
		ToolsJSON: toolsJSON(t,
			dto.NodeToolReport{Name: "claude", Current: "2.1.278", Installed: true, Job: &dto.NodeToolJob{
				CommandID: "tl_1", Action: "upgrade", State: dto.ToolJobRunning, Phase: "downloading", Percent: 40,
			}},
			dto.NodeToolReport{Name: "codex", Latest: "0.155.1"},
		),
	}
	views := nodeToolViews(node, now)
	busy := ""
	for _, view := range views {
		if view.Job != nil && toolJobInProgress(view.Job.State) {
			busy = view.Name
		}
	}
	if busy != "claude" {
		t.Fatalf("正在装的那个该被认出来，得到 %q", busy)
	}
}
