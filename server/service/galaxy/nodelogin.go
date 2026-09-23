package galaxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 远端登录：让机器上的 claude / codex 登录上游订阅，全程不用 ssh 上去。
//
// 一次的全程（claude，有回程的那种）：
//   控制台点「登录」→ 指令记在机器那一行上 → 下一次心跳下发 → 节点拉起
//   `claude auth login`，把它打印的授权地址搭心跳报回来 → 控制台显示地址 →
//   主人在自己浏览器里授权，拿到一串码，粘回控制台 → 码记在同一条指令上 →
//   下一次心跳送到机器 → 节点喂给那个还卡在 stdin 上的进程 → 成败搭心跳报回来。
//
// codex 少后面一半：`codex login --device-auth` 给的是短码和地址，主人在任意设备上
// 输完码，机器自己轮询换 token，不需要任何东西送回去。
//
// 为什么回程也走心跳：poll 接入的机器 Hub 根本连不上它（只有 export 节点有入站面），
// 而机房里的机器多半是 poll。代价是码最多晚一跳才到 —— 节点那边用「会话期间心跳
// 提速到 5 秒」补偿，这和装东西时的做法是同一个。
//
// Hub 只说**登录哪一个工具**。跑什么命令在节点自己那张固定表里
// （pool::login::login_command）—— 让 Hub 送一条命令过去执行，等于把「在我的机器上
// 跑什么」这条边界交出去（原则 8）。

const (
	// loginCommandPendingTTL 指令发出去之后多久没结果就作废。
	//
	// 取 15 分钟是跟着**码的寿命**走的：codex 的设备码自己写着 15 分钟过期，节点那边
	// 的会话超时也是这个数。比它短会在主人正要粘码时把指令收掉，比它长则是留着一条
	// 已经没用的指令继续占着这台机器的登录槽。
	loginCommandPendingTTL = 15 * time.Minute

	// loginStaleTTL 机器领走之后多久没有新进度就按「没回音」显示。
	// 只影响**显示**：节点那边该等还在等，登录成了的那一跳仍然会把状态翻过来。
	loginStaleTTL = 15 * time.Minute

	// loginsJSONMax 节点自报那份 JSON 的上限。超了整份丢掉、不截断 ——
	// 截一半的 JSON 解不动，而且每次心跳都会重写一遍。
	loginsJSONMax = 8192

	// loginCodeMax 授权码的长度上限，和 login_command_code 那一列对齐。
	// 两边的码都在几十个字符以内，这个数只防一个超长输入把 UPDATE 打回来。
	loginCodeMax = 255
)

// loginableTools 能登录的工具。**白名单**，理由同 installableTools：
// 不让这个接口变成「让任意调用方决定在别人机器上跑什么」。
var loginableTools = map[string]bool{"claude": true, "codex": true}

// RequestNodeLogin 控制台点「登录」：记一条待下发的指令。
//
// 只是记下来，指令搭下一次心跳下发。地址和短码要等节点把 CLI 的输出报回来才有 ——
// 所以这个接口返回得很快，返回的那条是 pending，界面上先显示「等机器领取」。
func (s *service) RequestNodeLogin(ctx context.Context, ownerUserID, nodeID, tool string) (dto.NodeLoginView, error) {
	name := strings.TrimSpace(tool)
	if !loginableTools[name] {
		return dto.NodeLoginView{}, fmt.Errorf("不认识的工具：%s", tool)
	}
	node, err := s.ownedNode(ctx, ownerUserID, nodeID)
	if err != nil {
		return dto.NodeLoginView{}, err
	}
	now := time.Now()
	if err := checkNodeLoginReady(node); err != nil {
		return dto.NodeLoginView{}, err
	}
	// 一台机器同时只登录一个：待下发的指令只有一个槽，点第二个会把第一个顶掉 ——
	// 而那时主人手里可能正拿着第一个的短码。
	//
	// 一个例外：同一个工具、而且机器已经把地址给出来了（waiting）。那就是主人在说
	// 「这次不要了，重来」—— 他可能走开太久、码过期了，或者想换个账号。不放行的话
	// 这个工具会被锁满十五分钟，而按钮就在那儿点不动。新指令带着新的 id 下去，
	// 节点收到不同的 id 会先把上一次连进程一起收拾掉。
	if blocked := loginBlockedBy(nodeLoginViews(node, now), name); blocked != "" {
		return dto.NodeLoginView{}, fmt.Errorf("这台机器正在登录 %s，等这一次结束再点", blocked)
	}
	commandID := "lg_" + NewULID(now)
	if err := s.repository.SaveNodeLoginCommand(ctx, bizLine, node.NodeID, map[string]any{
		"login_command_id":   commandID,
		"login_command_name": name,
		"login_command_code": "",
		"login_command_at":   now,
	}); err != nil {
		return dto.NodeLoginView{}, err
	}
	return pendingLoginView(commandID, name), nil
}

// SubmitNodeLoginCode 主人把浏览器里拿到的授权码粘回来。
//
// 只有 claude 这条路用得上。码不存长期的东西：它是一次性的、几分钟就过期的授权码，
// 送到机器上就被清掉；真正换来的 token 只落在那台机器上，Hub 这边从头到尾看不到。
func (s *service) SubmitNodeLoginCode(ctx context.Context, ownerUserID, nodeID, tool, code string) (dto.NodeLoginView, error) {
	name := strings.TrimSpace(tool)
	trimmed := strings.TrimSpace(code)
	if trimmed == "" {
		return dto.NodeLoginView{}, errors.New("授权码是空的")
	}
	if len(trimmed) > loginCodeMax {
		return dto.NodeLoginView{}, errors.New("这串授权码太长了，确认一下是不是整段复制多了")
	}
	node, err := s.ownedNode(ctx, ownerUserID, nodeID)
	if err != nil {
		return dto.NodeLoginView{}, err
	}
	now := time.Now()
	// 码要发给**哪一次会话**，得由机器自己说了算 —— 它报回来的 commandID 就是那一次。
	// 不能用「最近一条指令的 id」：主人粘码的那一刻，上一条起登录的指令早就被收掉了。
	current := findLoginView(nodeLoginViews(node, now), name)
	if current == nil || !loginInProgress(current.State) {
		return dto.NodeLoginView{}, errors.New("这台机器上没有正在进行的登录，重新点一次登录")
	}
	if !current.NeedsCode {
		return dto.NodeLoginView{}, fmt.Errorf("%s 的登录不需要粘码，在浏览器里输完短码就好", name)
	}
	if current.CommandID == "" {
		return dto.NodeLoginView{}, errors.New("这台机器还没报出这次登录，等一下再粘")
	}
	if err := s.repository.SaveNodeLoginCommand(ctx, bizLine, node.NodeID, map[string]any{
		"login_command_id":   current.CommandID,
		"login_command_name": name,
		"login_command_code": trimmed,
		"login_command_at":   now,
	}); err != nil {
		return dto.NodeLoginView{}, err
	}
	// 界面立刻翻成「正在验证」：从粘完到机器真的收到还有最多一跳心跳，
	// 那几秒里按钮不该看起来像没点上。
	view := *current
	view.Phase = dto.LoginPhaseVerifying
	view.Detail = ""
	return view, nil
}

// ownedNode 取一台属于这个主人的机器。
//
// 不区分「不存在」和「不是你的」：区分了，这个接口就能拿来枚举别人的机器。
func (s *service) ownedNode(ctx context.Context, ownerUserID, nodeID string) (*repository.GalaxyNode, error) {
	node, err := s.repository.FindNode(ctx, bizLine, strings.TrimSpace(nodeID))
	if notFound(err) {
		return nil, errors.New("机器不存在")
	}
	if err != nil {
		return nil, err
	}
	if node.OwnerUserID != ownerUserID {
		return nil, errors.New("机器不存在")
	}
	return node, nil
}

// checkNodeLoginReady 这台机器现在能不能收这条指令。每一条都直接说给主人听 ——
// 一个点不动的按钮旁边必须写着为什么。
func checkNodeLoginReady(node *repository.GalaxyNode) error {
	switch {
	case node.Banned:
		return errors.New("这台机器已被平台停用")
	case node.Status == "revoked":
		return errors.New("这台机器已经解绑了")
	case node.Status != statusActive:
		return errors.New("机器不在线，上线之后才能登录")
	}
	// 一条工具都没报过的机器，多半是 ai-bridge 还不认识这个功能。
	if strings.TrimSpace(node.ToolsJSON) == "" {
		return errors.New("这台机器的 ai-bridge 还不认识这个功能：先把它升到最新版")
	}
	return nil
}

// saveNodeLogins 把节点这一跳心跳自报的登录会话记下来，顺带收掉已经送达的指令。
//
// 「送达」怎么判见 loginCommandDelivered。在判定送达之前每一跳都重发同一条指令 ——
// 节点按「id 加码本身」去重，重发不会被喂第二次，而丢一次心跳响应不至于让主人白粘一遍。
func (s *service) saveNodeLogins(ctx context.Context, node *repository.GalaxyNode, reports []dto.NodeLoginReport, now time.Time) {
	if node == nil || reports == nil {
		// nil 是「这个节点不报」（老版本），和「报了个空数组」不是一回事：
		// 后者表示这台机器这会儿没有人在登录，那是要写下去的。
		return
	}
	encoded, err := json.Marshal(reports)
	if err != nil || len(encoded) > loginsJSONMax {
		return
	}
	if string(encoded) != node.LoginsJSON {
		if err := s.repository.SaveNodeLogins(ctx, bizLine, node.NodeID, string(encoded)); err == nil {
			node.LoginsJSON = string(encoded)
		}
	}
	if loginCommandDelivered(node, reports, now) {
		s.clearLoginCommand(ctx, node)
	}
}

// loginCommandDelivered 这条待下发的指令算不算已经到位、可以收掉了。
//
// 单拎出来是因为两种指令的判据不一样，而照搬另一种会静静地坏掉：
//
//   - 「起一次登录」：机器报出带着这个 id 的会话，就说明它开工了，不用再重发。
//   - 「这是码」：**没有单独的回执**，而且整次会话里机器报的都是同一个 id ——
//     主人粘的码正是挂在那条会话的 id 上发回去的。照搬上面那条规矩的话，码会在
//     下发之前就被判成「已送达」而清掉，主人粘完之后那台机器上什么都不会发生，
//     界面上也没有任何报错。所以要看会话自己的反应：节点一把码喂进 stdin 就把
//     phase 翻成 verifying，那是回程唯一的回执。
//
// 两种都还没到位时只剩超时兜底：机器可能这期间掉线了，留着一条过期的指令只会
// 占着这台机器的登录槽，而那串码早就失效了。
func loginCommandDelivered(node *repository.GalaxyNode, reports []dto.NodeLoginReport, now time.Time) bool {
	if node == nil || node.LoginCommandID == "" {
		return false
	}
	for _, report := range reports {
		if report.CommandID != node.LoginCommandID {
			continue
		}
		if node.LoginCommandCode == "" {
			return true
		}
		if report.Phase == dto.LoginPhaseVerifying || loginFinished(report.State) {
			return true
		}
	}
	return node.LoginCommandAt != nil && now.Sub(*node.LoginCommandAt) > loginCommandPendingTTL
}

func (s *service) clearLoginCommand(ctx context.Context, node *repository.GalaxyNode) {
	_ = s.repository.SaveNodeLoginCommand(ctx, bizLine, node.NodeID, map[string]any{
		"login_command_id":   "",
		"login_command_name": "",
		"login_command_code": "",
		"login_command_at":   nil,
	})
	node.LoginCommandID, node.LoginCommandName, node.LoginCommandCode, node.LoginCommandAt = "", "", "", nil
}

// pendingLoginCommand 心跳时取一条要下发的登录指令；没有就返回 nil。
func (s *service) pendingLoginCommand(node *repository.GalaxyNode, now time.Time) *dto.NodeLoginCommand {
	if node == nil || node.LoginCommandID == "" || node.LoginCommandName == "" {
		return nil
	}
	if node.LoginCommandAt != nil && now.Sub(*node.LoginCommandAt) > loginCommandPendingTTL {
		return nil
	}
	return &dto.NodeLoginCommand{
		ID:   node.LoginCommandID,
		Tool: node.LoginCommandName,
		Code: node.LoginCommandCode,
	}
}

// nodeLoginViews 控制台上机器详情里的登录。折算规则同 nodeToolViews。
func nodeLoginViews(node *repository.GalaxyNode, now time.Time) []dto.NodeLoginView {
	views := make([]dto.NodeLoginView, 0, 2)
	if node == nil {
		return views
	}
	var reports []dto.NodeLoginReport
	if raw := strings.TrimSpace(node.LoginsJSON); raw != "" {
		if err := json.Unmarshal([]byte(raw), &reports); err != nil {
			// 存进去的时候是我们自己序列化的，解不动只可能是手改过库。
			return views
		}
	}
	// 「起一次登录」还没被领走的那十几秒，要补一条 pending —— 否则点完按钮到下一个
	// 心跳之间界面上什么都不会动。已经带着码的那条不补：那时界面上早有东西在显示了。
	pending := ""
	if node.LoginCommandID != "" && node.LoginCommandCode == "" && node.LoginCommandAt != nil &&
		now.Sub(*node.LoginCommandAt) <= loginCommandPendingTTL {
		pending = node.LoginCommandName
	}
	seen := false
	for _, report := range reports {
		view := dto.NodeLoginView(report)
		if loginInProgress(view.State) && staleLoginBeat(node, now) {
			view.State, view.Phase = dto.LoginFailed, dto.LoginFailed
			view.Detail = "机器一直没有回音，这一次按超时处理；可以重新点一次登录"
		}
		if view.Tool == pending {
			seen = true
			// 指令还没被领走：机器报的那条要么没有，要么是上一次的。
			if view.CommandID != node.LoginCommandID {
				view = pendingLoginView(node.LoginCommandID, pending)
			}
		}
		views = append(views, view)
	}
	// 这台机器从没登录过这个工具，连一条旧记录都没有。
	if pending != "" && !seen {
		views = append(views, pendingLoginView(node.LoginCommandID, pending))
	}
	return views
}

// staleLoginBeat 这台机器是不是已经很久没说话了。用心跳而不是会话自己的时刻：
// 进度是搭着心跳回来的，心跳停了，进度自然也停了 —— 是同一件事。
func staleLoginBeat(node *repository.GalaxyNode, now time.Time) bool {
	if node.LastBeatAt == nil {
		return true
	}
	return now.Sub(*node.LastBeatAt) > loginStaleTTL
}

func pendingLoginView(commandID, tool string) dto.NodeLoginView {
	return dto.NodeLoginView{
		Tool: tool, State: dto.LoginPending, Phase: dto.LoginPending,
		CommandID: commandID, Detail: "等机器领取",
		// 要不要粘码是这条流程本身的性质，不用等机器告诉我们 —— 界面在 pending
		// 阶段就能把「一会儿要粘码」这件事先说出来。
		NeedsCode: tool == "claude",
	}
}

// loginBlockedBy 这会儿有没有别的登录挡着。返回挡着的那个工具名，没有就是空串。
//
// 规矩见 RequestNodeLogin 上面那段注释：同一个工具、且机器已经把地址给出来了，
// 那是主人在要求重来，放行。
func loginBlockedBy(views []dto.NodeLoginView, tool string) string {
	for _, view := range views {
		if !loginInProgress(view.State) {
			continue
		}
		if view.Tool == tool && view.State == dto.LoginWaiting {
			continue
		}
		return view.Tool
	}
	return ""
}

func loginInProgress(state string) bool {
	return state == dto.LoginPending || state == dto.LoginRunning || state == dto.LoginWaiting
}

func loginFinished(state string) bool {
	return state == dto.LoginSucceeded || state == dto.LoginFailed
}

func findLoginView(views []dto.NodeLoginView, tool string) *dto.NodeLoginView {
	for index := range views {
		if views[index].Tool == tool {
			return &views[index]
		}
	}
	return nil
}
