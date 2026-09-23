package galaxy

import (
	"encoding/json"
	"testing"
	"time"

	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

func loginsJSON(t *testing.T, reports ...dto.NodeLoginReport) string {
	t.Helper()
	encoded, err := json.Marshal(reports)
	if err != nil {
		t.Fatalf("序列化失败：%v", err)
	}
	return string(encoded)
}

// 指令发出去到机器来领之间（最多一个心跳）界面上必须有东西在动，
// 而且那时就该知道这条路一会儿要不要粘码 —— 那是流程本身的性质，不用等机器说。
func TestNodeLoginViewsShowPendingBeforeTheMachinePicksItUp(t *testing.T) {
	now := time.Date(2026, 9, 23, 10, 0, 0, 0, time.UTC)
	fresh := now.Add(-5 * time.Second)
	node := &repository.GalaxyNode{
		LastBeatAt:       &fresh,
		LoginCommandID:   "lg_1",
		LoginCommandName: "claude",
		LoginCommandAt:   &fresh,
	}
	view := findLoginView(nodeLoginViews(node, now), "claude")
	if view == nil || view.State != dto.LoginPending {
		t.Fatalf("该显示「等机器领取」，得到 %+v", view)
	}
	if !view.NeedsCode {
		t.Fatal("claude 这条路要粘码，pending 阶段就该说出来")
	}
}

// 回程最容易错的一步：码还没送到，不能因为「机器报回了同一个 commandID」就把它收掉。
//
// 机器在整次会话里报的都是同一个 id —— 起登录那条指令被领走后，主人粘的码是挂在
// **同一个 id** 上发回去的。要是照搬工具那边「见到 id 就收」的规矩，码会在下发之前
// 一跳就被清掉，主人粘完之后那台机器上什么都不会发生。
func TestAPastedCodeIsNotClearedUntilTheMachineActuallyTakesIt(t *testing.T) {
	now := time.Date(2026, 9, 23, 10, 0, 0, 0, time.UTC)
	fresh := now.Add(-5 * time.Second)
	node := &repository.GalaxyNode{
		NodeID:           "n1",
		LastBeatAt:       &fresh,
		LoginCommandID:   "lg_1",
		LoginCommandName: "claude",
		LoginCommandCode: "the-pasted-code",
		LoginCommandAt:   &fresh,
	}
	// 机器还在等码：报的是同一个 id，phase 仍然是 authorize。
	waiting := []dto.NodeLoginReport{{
		Tool: "claude", State: dto.LoginWaiting, Phase: dto.LoginPhaseAuthorize,
		CommandID: "lg_1", NeedsCode: true, VerificationURI: "https://claude.com/cai/oauth/authorize?x=1",
	}}
	if loginCommandDelivered(node, waiting, now) {
		t.Fatal("码还没送到就被判成已送达：清掉之后主人粘完那台机器上什么都不会发生")
	}
	svc := &service{}
	if command := svc.pendingLoginCommand(node, now); command == nil || command.Code != "the-pasted-code" {
		t.Fatalf("这一跳该把码发下去，得到 %+v", command)
	}
	// 机器收下了：节点一把码喂进 stdin 就把 phase 翻成 verifying，这是回程唯一的回执。
	took := []dto.NodeLoginReport{{
		Tool: "claude", State: dto.LoginWaiting, Phase: dto.LoginPhaseVerifying, CommandID: "lg_1", NeedsCode: true,
	}}
	if !loginCommandDelivered(node, took, now) {
		t.Fatal("机器已经收下了，指令该收掉，不然同一串码会一直重发")
	}
}

// 「起一次登录」那条则相反：机器一报出这次会话就说明它开工了，不用再重发。
func TestAStartCommandIsClearedAsSoonAsTheMachineReportsTheSession(t *testing.T) {
	now := time.Date(2026, 9, 23, 10, 0, 0, 0, time.UTC)
	fresh := now.Add(-5 * time.Second)
	node := &repository.GalaxyNode{
		NodeID: "n1", LastBeatAt: &fresh,
		LoginCommandID: "lg_2", LoginCommandName: "codex", LoginCommandAt: &fresh,
	}
	reports := []dto.NodeLoginReport{{
		Tool: "codex", State: dto.LoginWaiting, Phase: dto.LoginPhaseAuthorize, CommandID: "lg_2",
		VerificationURI: "https://auth.openai.com/codex/device", UserCode: "RWEQ-34W3X",
	}}
	if !loginCommandDelivered(node, reports, now) {
		t.Fatal("机器已经领走了，指令该收掉")
	}
}

// 机器不吭声了就别让那个「正在登录」永远转下去 —— 但只改显示，
// 机器那边该等还在等，真登上了的那一跳仍然会把状态翻过来。
func TestASilentMachineStopsTheSpinner(t *testing.T) {
	now := time.Date(2026, 9, 23, 10, 0, 0, 0, time.UTC)
	stale := now.Add(-loginStaleTTL - time.Minute)
	node := &repository.GalaxyNode{
		LastBeatAt: &stale,
		LoginsJSON: loginsJSON(t, dto.NodeLoginReport{
			Tool: "claude", State: dto.LoginWaiting, Phase: dto.LoginPhaseAuthorize, CommandID: "lg_3",
		}),
	}
	view := findLoginView(nodeLoginViews(node, now), "claude")
	if view == nil || view.State != dto.LoginFailed {
		t.Fatalf("该按超时折算成失败，得到 %+v", view)
	}
}

// 过期的指令不下发。码是有寿命的，晚到的那一串只会换来一句「Invalid code」。
func TestAnExpiredCommandIsNotSent(t *testing.T) {
	now := time.Date(2026, 9, 23, 10, 0, 0, 0, time.UTC)
	old := now.Add(-loginCommandPendingTTL - time.Minute)
	node := &repository.GalaxyNode{
		LoginCommandID: "lg_4", LoginCommandName: "claude", LoginCommandAt: &old,
	}
	svc := &service{}
	if command := svc.pendingLoginCommand(node, now); command != nil {
		t.Fatalf("过期了就不该再发，得到 %+v", command)
	}
}

// 卡在「等主人」的那一次必须能重来：主人可能走开太久、码过期了，或者想换个账号。
// 不放行的话这个工具会被锁满十五分钟，而按钮就在那儿点不动。
func TestAWaitingLoginCanBeRestartedButOthersStillBlock(t *testing.T) {
	now := time.Date(2026, 9, 23, 10, 0, 0, 0, time.UTC)
	fresh := now.Add(-5 * time.Second)
	node := &repository.GalaxyNode{
		LastBeatAt: &fresh,
		LoginsJSON: loginsJSON(t, dto.NodeLoginReport{
			Tool: "claude", State: dto.LoginWaiting, Phase: dto.LoginPhaseAuthorize, CommandID: "lg_old",
		}),
	}
	views := nodeLoginViews(node, now)
	claude := findLoginView(views, "claude")
	if claude == nil || claude.State != dto.LoginWaiting {
		t.Fatalf("前提不成立：%+v", claude)
	}
	// 同一个工具、已经在等主人 —— 放行。
	if blocked := loginBlockedBy(views, "claude"); blocked != "" {
		t.Fatalf("同一个工具的重来该放行，却被 %q 挡了", blocked)
	}
	// 换一个工具 —— 还是要挡：一台机器同时只有一个登录槽。
	if blocked := loginBlockedBy(views, "codex"); blocked != "claude" {
		t.Fatalf("另一个工具该被挡住，得到 %q", blocked)
	}
	// 指令还没被机器领走时，连同一个工具也不放行：重发一条没有意义。
	pendingNode := &repository.GalaxyNode{
		LastBeatAt:     &fresh,
		LoginCommandID: "lg_new", LoginCommandName: "claude", LoginCommandAt: &fresh,
	}
	if blocked := loginBlockedBy(nodeLoginViews(pendingNode, now), "claude"); blocked != "claude" {
		t.Fatalf("还没领走的那条该挡住，得到 %q", blocked)
	}
}
