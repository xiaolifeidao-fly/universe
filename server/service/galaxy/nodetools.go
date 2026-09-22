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

// 远程装 / 升机器上的**外部工具**（claude、codex）。
//
// 一次的全程：控制台点「安装」→ 指令记在机器那一行上 → 下一次心跳下发（15 秒一次）
// → 节点拉起 `npm i -g <包>@latest`，之后每一跳心跳报一次进度 → 装完那一跳报终态，
// 同时把新版本号一起报上来。装东西期间节点会把心跳提速到 5 秒一跳，
// 进度条才看得出在动。
//
// Hub 只说**装哪一个工具**。装什么包、怎么装在节点自己那张固定表里
// （pool::tools::upgrade_command）—— 让 Hub 送一条命令过去执行，等于把
// 「在我的机器上跑什么」这条边界交出去（原则 8）。
//
// 和 nodeupgrade.go 是两件事：那边升的是 ai-bridge 自己（要验签、换文件、重启进程），
// 这边装的是它调用的命令行，失败了也只是这台机器少一种能力，不影响它继续干别的活。

const (
	// toolCommandPendingTTL 指令发出去之后机器多久没来领就作废。
	// 在线的机器 15 秒内就领到了；十分钟没动静说明它这期间掉线了 —— 留着的话，
	// 机器几小时后回来会突然开始装东西，那时候主人多半已经去机器上手动装过了。
	toolCommandPendingTTL = 10 * time.Minute

	// toolJobStaleTTL 机器领走之后多久没有新进度就按「没回音」显示。
	//
	// npm 全局装这两个包正常几十秒，给到十分钟是照顾网络很差的机房。超时只影响
	// **显示**：节点那边该装还在装，装完的那一跳心跳仍然会把状态翻成成功。
	toolJobStaleTTL = 10 * time.Minute

	// toolsJSONMax 节点自报那份 JSON 的上限。超了整份丢掉、不截断 ——
	// 截一半的 JSON 解不动，而且每次心跳都会重写一遍。
	toolsJSONMax = 8192
)

// installableTools 平台认得、也装得了的工具。**白名单**：控制台传什么进来都只能
// 落在这几个之一，否则这个接口就成了「让任意调用方决定在别人机器上装什么」。
//
// 真正的命令在节点那边，这里只是不把一个明显没意义的名字发出去。
var installableTools = map[string]bool{"claude": true, "codex": true}

// RequestNodeTool 控制台点「安装 / 升级」：记一条待下发的指令。
//
// 只是记下来：指令搭在下一次心跳上下发，装不装得成由节点说了算。所以它返回得很快，
// 进度要靠轮询机器列表看（NodeView.Tools 里那条 job）。
func (s *service) RequestNodeTool(ctx context.Context, ownerUserID, nodeID, tool string) (dto.NodeToolView, error) {
	name := strings.TrimSpace(tool)
	if !installableTools[name] {
		return dto.NodeToolView{}, fmt.Errorf("不认识的工具：%s", tool)
	}
	node, err := s.repository.FindNode(ctx, bizLine, strings.TrimSpace(nodeID))
	if notFound(err) {
		return dto.NodeToolView{}, errors.New("机器不存在")
	}
	if err != nil {
		return dto.NodeToolView{}, err
	}
	// 不区分「不存在」和「不是你的」：区分了，这个接口就能拿来枚举别人的机器。
	if node.OwnerUserID != ownerUserID {
		return dto.NodeToolView{}, errors.New("机器不存在")
	}
	now := time.Now()
	if err := checkNodeToolReady(node); err != nil {
		return dto.NodeToolView{}, err
	}
	views := nodeToolViews(node, now)
	// 一台机器同时只装一个 —— 不限的话有两条坏事：待下发的指令只有一个槽，
	// 点第二个会把第一个顶掉（而界面上第一个刚说完「等机器领取」）；就算都下发了，
	// 两个 npm 同时写全局 node_modules，装出来什么样没人说得准。
	for _, view := range views {
		if view.Job != nil && toolJobInProgress(view.Job.State) {
			return dto.NodeToolView{}, fmt.Errorf("这台机器正在装 %s，等这一次结束再点", view.Name)
		}
	}
	current := findToolView(views, name)
	commandID := "tl_" + NewULID(now)
	if err := s.repository.SaveNodeToolCommand(ctx, bizLine, node.NodeID, map[string]any{
		"tool_command_id":   commandID,
		"tool_command_name": name,
		"tool_command_at":   now,
	}); err != nil {
		return dto.NodeToolView{}, err
	}
	view := dto.NodeToolView{Name: name}
	if current != nil {
		view = dto.NodeToolView{
			Name: name, Current: current.Current, Latest: current.Latest,
			Upgradable: current.Upgradable, Installed: current.Installed,
		}
	}
	view.Job = pendingToolJob(commandID, view.Installed)
	return view, nil
}

// checkNodeToolReady 这台机器现在能不能收这条指令。每一条都直接说给主人听 ——
// 一个点不动的按钮旁边必须写着为什么。
func checkNodeToolReady(node *repository.GalaxyNode) error {
	switch {
	case node.Banned:
		return errors.New("这台机器已被平台停用")
	case node.Status == "revoked":
		return errors.New("这台机器已经解绑了")
	case node.Status != statusActive:
		return errors.New("机器不在线，上线之后才能装")
	}
	// 一条工具都没报过的机器，多半是 ai-bridge 还不认识这个功能。指令发过去它不会理，
	// 主人只会看着一个「等机器领取」挂十分钟 —— 不如现在就说清楚。
	if strings.TrimSpace(node.ToolsJSON) == "" {
		return errors.New("这台机器的 ai-bridge 还不认识这个功能：先把它升到最新版")
	}
	return nil
}

// saveNodeTools 把节点这一跳心跳自报的工具状态记下来。
//
// 只在**内容真的变了**的时候才写：心跳 15 秒一次，不比就写是每台机器每天四千多次
// 空 UPDATE。装东西那几十秒里它每跳都在变，那是应该写的。
//
// 顺带收掉已经被领走的指令：节点把指令 id 原样报回在 job 里，看到了就说明它开工了，
// 不用再重发 —— 从这一刻起，进度由 job 自己说。
func (s *service) saveNodeTools(ctx context.Context, node *repository.GalaxyNode, reports []dto.NodeToolReport, now time.Time) {
	if node == nil || reports == nil {
		// nil 是「这个节点不报」（老版本），和「报了个空数组」不是一回事：
		// 后者表示这台机器一个工具都没有，那是要写下去的。
		return
	}
	encoded, err := json.Marshal(reports)
	if err != nil || len(encoded) > toolsJSONMax {
		return
	}
	if string(encoded) != node.ToolsJSON {
		if err := s.repository.SaveNodeTools(ctx, bizLine, node.NodeID, string(encoded)); err == nil {
			node.ToolsJSON = string(encoded)
		}
	}
	if node.ToolCommandID == "" {
		return
	}
	for _, report := range reports {
		if report.Job != nil && report.Job.CommandID == node.ToolCommandID {
			s.clearToolCommand(ctx, node)
			return
		}
	}
	if node.ToolCommandAt != nil && now.Sub(*node.ToolCommandAt) > toolCommandPendingTTL {
		s.clearToolCommand(ctx, node)
	}
}

func (s *service) clearToolCommand(ctx context.Context, node *repository.GalaxyNode) {
	_ = s.repository.SaveNodeToolCommand(ctx, bizLine, node.NodeID, map[string]any{
		"tool_command_id":   "",
		"tool_command_name": "",
		"tool_command_at":   nil,
	})
	node.ToolCommandID, node.ToolCommandName, node.ToolCommandAt = "", "", nil
}

// pendingToolCommand 心跳时取一条要下发的指令；没有就返回 nil。
//
// 节点开工之后（心跳里报回同一个 id）指令就被收掉，自然停止重发；在那之前每个心跳
// 都发一次，丢一次响应不至于让这次安装卡死（节点按 id 去重）。
func (s *service) pendingToolCommand(node *repository.GalaxyNode, now time.Time) *dto.NodeToolCommand {
	if node == nil || node.ToolCommandID == "" || node.ToolCommandName == "" {
		return nil
	}
	if node.ToolCommandAt != nil && now.Sub(*node.ToolCommandAt) > toolCommandPendingTTL {
		return nil
	}
	return &dto.NodeToolCommand{ID: node.ToolCommandID, Tool: node.ToolCommandName}
}

// nodeToolViews 控制台上机器详情里那几行工具。
//
// 两处折算在这里做完，前端不用自己算（算两遍迟早两边说法不一样）：
//   - 指令已发、机器还没开工 → 补一条 pending 的进度，否则点完按钮到下一个心跳之间
//     界面上什么都不会动，看起来像没点上；
//   - 进行中的进度太久没更新 → 按「没回音」折算成失败，不让一个进度条永远转下去。
func nodeToolViews(node *repository.GalaxyNode, now time.Time) []dto.NodeToolView {
	views := make([]dto.NodeToolView, 0, 2)
	if node == nil {
		return views
	}
	var reports []dto.NodeToolReport
	if raw := strings.TrimSpace(node.ToolsJSON); raw != "" {
		if err := json.Unmarshal([]byte(raw), &reports); err != nil {
			// 存进去的时候是我们自己序列化的，解不动只可能是手改过库。
			// 当成「这台机器没报过」——比让整个机器列表失败强。
			return views
		}
	}
	pending := ""
	if node.ToolCommandID != "" && node.ToolCommandAt != nil &&
		now.Sub(*node.ToolCommandAt) <= toolCommandPendingTTL {
		pending = node.ToolCommandName
	}
	for _, report := range reports {
		view := dto.NodeToolView{
			Name: report.Name, Current: report.Current, Latest: report.Latest,
			Upgradable: report.Upgradable, Installed: report.Installed, Job: report.Job,
		}
		if view.Job != nil && toolJobInProgress(view.Job.State) && staleBeat(node, now) {
			job := *view.Job
			job.State, job.Phase = dto.ToolJobFailed, dto.ToolJobFailed
			job.Detail = "机器一直没有回音，这一次按超时处理；可以重新点一次"
			view.Job = &job
		}
		// 指令还没被领走：机器报的那条 job 要么没有，要么是上一次的。
		if report.Name == pending && (view.Job == nil || view.Job.CommandID != node.ToolCommandID) {
			view.Job = pendingToolJob(node.ToolCommandID, view.Installed)
		}
		views = append(views, view)
	}
	return views
}

// staleBeat 这台机器是不是已经很久没说话了。用心跳而不是 job 自己的时刻：
// 进度是搭着心跳回来的，心跳停了，进度自然也停了 —— 是同一件事。
func staleBeat(node *repository.GalaxyNode, now time.Time) bool {
	if node.LastBeatAt == nil {
		return true
	}
	return now.Sub(*node.LastBeatAt) > toolJobStaleTTL
}

func pendingToolJob(commandID string, installed bool) *dto.NodeToolJob {
	action := "install"
	if installed {
		action = "upgrade"
	}
	return &dto.NodeToolJob{
		CommandID: commandID, Action: action, State: dto.ToolJobPending,
		Phase: dto.ToolJobPending, Detail: "等机器领取",
	}
}

func toolJobInProgress(state string) bool {
	return state == dto.ToolJobPending || state == dto.ToolJobRunning
}

func findToolView(views []dto.NodeToolView, name string) *dto.NodeToolView {
	for index := range views {
		if views[index].Name == name {
			return &views[index]
		}
	}
	return nil
}
