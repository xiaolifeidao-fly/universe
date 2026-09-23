package galaxy

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 远程升级 ai-bridge。
//
// 一次升级的全程：控制台点「升级」→ 指令记在机器那一行上（pending）→ 下一次心跳
// 下发（15 秒一次，所以最多等一个心跳）→ 节点验签、下载、安装、重启，每一步回报一次
// → 重启之后 hello 报上来的版本等于目标版本，Hub 判定成功。
//
// Hub 只说「装哪一个包、它的 sha256 与签名是什么」。要不要装、能不能装、装完怎么
// 重启，全在节点自己手里（原则 8：在我的机器上执行什么这条边界不信任 Hub）。
// 所以这里没有任何「强制」的语义 —— 节点拒绝执行是合法结果，控制台照实显示。

const (
	// 节点自报的分发方式。空串是老版本节点（那时候还没有这个字段）。
	distributionCLI  = "cli"
	distributionNova = "nova"

	// upgradePendingTTL 指令发出去之后机器多久没来领就作废。
	//
	// 在线的机器 15 秒内就领到了。十分钟没动静说明它这期间掉线了，作废比留着好：
	// 留着的话，机器几小时后回来会突然重启一次 —— 那时候主人多半已经去机器上
	// 手动处理过了，一次没人预期的重启比没升级更糟。
	upgradePendingTTL = 10 * time.Minute

	// upgradeStaleTTL 领了之后多久没有新进展就按超时显示。
	//
	// 下载三兆的包 + 解包 + 试跑，正常十几秒；给到十五分钟是照顾网络很差的机房。
	// 超时只影响**显示**：节点那边该装还在装，装完的那一次 hello 仍然会把状态
	// 翻成成功。宁可晚一点说成功，也不要让一行「正在下载」永远挂在那里。
	upgradeStaleTTL = 15 * time.Minute
)

// upgradeInProgress 这四个状态表示这一次升级还在路上。
func upgradeInProgress(status string) bool {
	switch status {
	case dto.UpgradePending, dto.UpgradeDownloading, dto.UpgradeInstalling, dto.UpgradeRestarting:
		return true
	}
	return false
}

// RequestNodeUpgrade 控制台点「升级」：挑出这台机器该升到哪一版，记一条待下发的指令。
func (s *service) RequestNodeUpgrade(ctx context.Context, ownerUserID, nodeID string) (dto.NodeUpgradeView, error) {
	node, err := s.repository.FindNode(ctx, bizLine, strings.TrimSpace(nodeID))
	if notFound(err) {
		return dto.NodeUpgradeView{}, errors.New("机器不存在")
	}
	if err != nil {
		return dto.NodeUpgradeView{}, err
	}
	if node.OwnerUserID != ownerUserID {
		// 不区分「不存在」和「不是你的」：区分了，这个接口就能拿来枚举别人的机器。
		return dto.NodeUpgradeView{}, errors.New("机器不存在")
	}
	if err := checkNodeUpgradable(node); err != nil {
		return dto.NodeUpgradeView{}, err
	}
	now := time.Now()
	if view := nodeUpgradeView(node, now); view != nil && upgradeInProgress(view.Status) {
		return dto.NodeUpgradeView{}, errors.New("正在升级，等这一次结束再试")
	}
	latest, err := s.latestBridgeReleases(ctx)
	if err != nil {
		return dto.NodeUpgradeView{}, err
	}
	target, ok := latest[node.BridgePlatform]
	if !ok {
		return dto.NodeUpgradeView{}, fmt.Errorf("还没有适用于 %s 的安装包", node.BridgePlatform)
	}
	if compareBridgeVersions(target.Version, node.BridgeVersion) <= 0 {
		return dto.NodeUpgradeView{}, errors.New("已经是最新版本")
	}

	upgradeID := "ug_" + NewULID(now)
	if err := s.repository.SaveNodeUpgrade(ctx, bizLine, node.NodeID, map[string]any{
		"upgrade_id":           upgradeID,
		"upgrade_version":      target.Version,
		"upgrade_from_version": node.BridgeVersion,
		"upgrade_status":       dto.UpgradePending,
		"upgrade_message":      "",
		"upgrade_requested_at": now,
		"upgrade_updated_at":   now,
	}); err != nil {
		return dto.NodeUpgradeView{}, err
	}
	return dto.NodeUpgradeView{
		ID: upgradeID, Version: target.Version, FromVersion: node.BridgeVersion,
		Status: dto.UpgradePending, RequestedAt: &now, UpdatedAt: &now,
	}, nil
}

// checkNodeUpgradable 这台机器现在能不能被远程升级。每一条都直接说给主人听 ——
// 一个点不动的按钮旁边必须写着为什么。
func checkNodeUpgradable(node *repository.GalaxyNode) error {
	switch {
	case node.Banned:
		return errors.New("这台机器已被平台停用")
	case node.Status == "revoked":
		return errors.New("这台机器已经解绑了")
	case node.Status != statusActive:
		return errors.New("机器不在线，上线之后才能升级")
	}
	switch node.BridgeDistribution {
	case distributionCLI:
	case distributionNova:
		return errors.New("这台机器的 ai-bridge 随 Nova 应用更新，请更新 Nova")
	default:
		return errors.New("这台机器的 ai-bridge 版本太旧，不支持远程升级：先按「安装 ai-bridge」手动装一次新版")
	}
	if node.UpgradeBlocker != "" {
		// 节点自己算出来的原因（目录不可写、没有内置发布公钥……），比这里能猜的准。
		return errors.New(node.UpgradeBlocker)
	}
	if node.BridgePlatform == "" {
		return errors.New("还不知道这台机器是什么平台，等它下一次上报（最多一分钟）再试")
	}
	return nil
}

// pendingUpgradeCommand 心跳时取一条要下发的指令；没有就返回 nil。
//
// 节点报了 downloading 之后状态就不再是 pending，指令自然停止重发；在那之前
// 每个心跳都发一次，丢一次响应不至于让这次升级卡死（节点按 id 去重）。
func (s *service) pendingUpgradeCommand(ctx context.Context, node *repository.GalaxyNode, now time.Time) *dto.NodeUpgradeCommand {
	if node == nil || node.UpgradeStatus != dto.UpgradePending || node.UpgradeID == "" {
		return nil
	}
	if node.UpgradeRequestedAt != nil && now.Sub(*node.UpgradeRequestedAt) > upgradePendingTTL {
		s.failUpgrade(ctx, node, "机器一直没来领这次升级，已取消；需要的话重新点一次")
		return nil
	}
	row, err := s.repository.FindBridgeReleaseTarget(ctx, bizLine, node.UpgradeVersion, node.BridgePlatform)
	if notFound(err) || (err == nil && row.Status != bridgePublished) {
		// 目标版本被运营下架了（多半是发现它有问题），这一次就别装了。
		s.failUpgrade(ctx, node, fmt.Sprintf("%s 已下架，这次升级取消", node.UpgradeVersion))
		return nil
	}
	if err != nil {
		// 查库出错是暂时的，下一个心跳再试；不改状态。
		return nil
	}
	url, err := s.BridgeDownloadURL(ctx, node.BridgePlatform, node.UpgradeVersion)
	if err != nil {
		// 签不出地址是部署问题（没配 OSS），重试多少次都一样，直接说清楚。
		s.failUpgrade(ctx, node, "平台签不出安装包地址："+err.Error())
		return nil
	}
	return &dto.NodeUpgradeCommand{
		ID: node.UpgradeID, Version: row.Version, Platform: row.Platform,
		URL: url, SHA256: row.SHA256, Size: row.Size, Signature: row.Signature,
	}
}

// ReportNodeUpgrade 节点回报进度。返回 false 表示这条回报对应的已经不是当前这一次升级。
func (s *service) ReportNodeUpgrade(ctx context.Context, req dto.NodeUpgradeReport) (bool, error) {
	state := strings.TrimSpace(req.State)
	switch state {
	case dto.UpgradeDownloading, dto.UpgradeInstalling, dto.UpgradeRestarting, dto.UpgradeFailed, dto.UpgradeSucceeded:
	default:
		return false, fmt.Errorf("不认识的升级状态：%s", state)
	}
	upgradeID := strings.TrimSpace(req.ID)
	if upgradeID == "" {
		return false, errors.New("缺少升级指令 id")
	}
	message := truncate(strings.TrimSpace(req.Message), 255)
	if message == "" && state == dto.UpgradeSucceeded {
		message = "节点报告已经是目标版本"
	}
	return s.repository.UpdateNodeUpgrade(ctx, bizLine, req.NodeID, upgradeID, map[string]any{
		"upgrade_status":     state,
		"upgrade_message":    message,
		"upgrade_updated_at": time.Now(),
	})
}

// settleNodeUpgrade 在 hello 里结掉一次升级：重启之后报上来的版本说明装没装成。
//
// 判定放在 hello 而不是让节点自己报成功：节点报的「我装好了」只说明文件换了，
// **跑起来的是哪一版**只有重启之后的这一次 hello 能证明。
func (s *service) settleNodeUpgrade(ctx context.Context, node *repository.GalaxyNode, reportedVersion string, now time.Time) {
	if node == nil || node.UpgradeID == "" || !upgradeInProgress(node.UpgradeStatus) {
		return
	}
	version := strings.TrimSpace(reportedVersion)
	switch {
	case version != "" && version == node.UpgradeVersion:
		_, _ = s.repository.UpdateNodeUpgrade(ctx, bizLine, node.NodeID, node.UpgradeID, map[string]any{
			"upgrade_status":     dto.UpgradeSucceeded,
			"upgrade_message":    fmt.Sprintf("已从 %s 升级到 %s", defaultString(node.UpgradeFromVersion, "旧版本"), version),
			"upgrade_updated_at": now,
		})
	case node.UpgradeStatus == dto.UpgradeRestarting && version != "":
		// 节点说它重启了，回来的却还是旧版本：多半是服务管理器启动的是另一个路径上的
		// 可执行文件（比如 /usr/local/bin 下还留着一份旧的）。这种情况不会自己好。
		_, _ = s.repository.UpdateNodeUpgrade(ctx, bizLine, node.NodeID, node.UpgradeID, map[string]any{
			"upgrade_status":     dto.UpgradeFailed,
			"upgrade_message":    fmt.Sprintf("重启之后版本还是 %s，升级没有生效：确认服务启动的是刚替换的那个可执行文件", version),
			"upgrade_updated_at": now,
		})
	}
}

// failUpgrade Hub 侧判定的失败（超时、目标版本下架、签不出地址）。
func (s *service) failUpgrade(ctx context.Context, node *repository.GalaxyNode, message string) {
	_, _ = s.repository.UpdateNodeUpgrade(ctx, bizLine, node.NodeID, node.UpgradeID, map[string]any{
		"upgrade_status":     dto.UpgradeFailed,
		"upgrade_message":    truncate(message, 255),
		"upgrade_updated_at": time.Now(),
	})
	node.UpgradeStatus, node.UpgradeMessage = dto.UpgradeFailed, truncate(message, 255)
}

// nodeUpgradeView 控制台上的那一行。从没升级过返回 nil。
//
// 卡住太久的进行中状态在这里折算成失败：超时算在服务端算一次就够，
// 前端再算一遍迟早会出现两边说法不一致。
func nodeUpgradeView(node *repository.GalaxyNode, now time.Time) *dto.NodeUpgradeView {
	if node == nil || node.UpgradeID == "" {
		return nil
	}
	view := dto.NodeUpgradeView{
		ID: node.UpgradeID, Version: node.UpgradeVersion, FromVersion: node.UpgradeFromVersion,
		Status: node.UpgradeStatus, Message: node.UpgradeMessage,
		RequestedAt: node.UpgradeRequestedAt, UpdatedAt: node.UpgradeUpdatedAt,
	}
	if !upgradeInProgress(view.Status) || node.UpgradeUpdatedAt == nil {
		return &view
	}
	deadline := upgradeStaleTTL
	message := "机器一直没有回音，这次升级按超时处理；可以重新点一次"
	if view.Status == dto.UpgradePending {
		deadline = upgradePendingTTL
		message = "机器一直没来领这次升级，已取消；上线之后重新点一次"
	}
	if now.Sub(*node.UpgradeUpdatedAt) > deadline {
		view.Status, view.Message = dto.UpgradeFailed, message
	}
	return &view
}
