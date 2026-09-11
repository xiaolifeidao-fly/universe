package galaxy

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 接入方式：poll 与 export。
//
// poll   节点长轮询领活，Hub 永不主动连它。可视化客户端只有这一种 ——
//        笔记本没有稳定可达的入口，也不该要求主人去路由器上开端口。
// export 节点把自己暴露在公网上，Hub 拿 endpoint + secret 主动回连。
//        代价是主人要自己保证那个地址通；收益是省掉一整条长轮询链路，
//        派单不再受轮询间隔约束，一台机器也能同时被多个 Hub 实例直接驱动。
//
// 两种方式**只在「活是怎么到节点手上的」这一步不同**。hello / 心跳 / 进度 /
// 终态回报全部原样复用节点主动出站那条路 —— export 节点当然也能出站。
// 把差异收窄到这一步，是这套设计里最重要的一条：否则每加一种接入方式，
// 计量、结算、失败语义都要再实现一遍。

// exportNodeHeader 节点在每一次回连响应里出示的自证头。
//
// 它是 SSRF 的那道闸，不是装饰。endpoint 是提供者自己填的，不加这道校验，
// 任何人都能把它指向 http://169.254.169.254/ 这类内网地址，再以消费者身份
// 发一次请求，把 Hub 读到的东西原样取走。云元数据服务不会回这个头，
// 于是那种响应一个字节都到不了消费者手上。
const exportNodeHeader = "X-Galaxy-Node"

// exportProbePath 回连健康探测。注册与 hello 时各探一次，
// 让「端口没映射对」在主人还站在机器前面的时候就报出来，
// 而不是等到第一个消费者的请求超时。
const exportProbePath = "/node/v1/health"

// ExportExecutePath Hub 把单元推给节点的路径。
const ExportExecutePath = "/node/v1/execute"

// ExportCancelPath Hub 让节点中止一个在跑单元的路径。
const ExportCancelPath = "/node/v1/cancel"

// ExportTarget 回连一台 export 机器要的全部东西。
type ExportTarget struct {
	NodeID string
	// BaseURL 已规范化：去掉尾斜杠，只保留 scheme://host[:port][/prefix]。
	BaseURL string
	Secret  string
}

func (t ExportTarget) ExecuteURL() string { return t.BaseURL + ExportExecutePath }
func (t ExportTarget) CancelURL() string  { return t.BaseURL + ExportCancelPath }
func (t ExportTarget) ProbeURL() string   { return t.BaseURL + exportProbePath }

// normalizeEndpointURL 把节点声明的公网地址收成一个规范形状，顺手拦掉几种
// 一看就不该放行的写法。
//
// 拒绝的理由分别是：
//
//	非 http(s)      —— Hub 只会用 HTTP 回连，别的 scheme 一定是填错了
//	带用户名密码    —— 那等于把一份凭据写进节点表，而且它会跟着日志到处跑
//	带 query/片段   —— Hub 要在这个地址后面接路径，带了参数拼出来就是错的
//	链路本地地址    —— 169.254/16 与 fe80::/10 没有任何合法用途，
//	                   而 169.254.169.254 正是各家云的元数据服务
//
// 私网地址（10/8、192.168/16）**放行**：自建部署里 Hub 和节点同在一个内网是常态。
// 真正兜住 SSRF 的是每次响应都要校验的 exportNodeHeader，不是这张地址表。
func normalizeEndpointURL(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", fmt.Errorf("缺少回连地址")
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "", fmt.Errorf("回连地址不是合法 URL")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("回连地址必须是 http 或 https")
	}
	if parsed.User != nil {
		return "", fmt.Errorf("回连地址不能带用户名密码")
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("回连地址不能带查询参数或片段")
	}
	host := parsed.Hostname()
	if host == "" {
		return "", fmt.Errorf("回连地址缺少主机名")
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLinkLocalUnicast() {
		return "", fmt.Errorf("回连地址不能是链路本地地址")
	}
	parsed.Path = strings.TrimSuffix(parsed.Path, "/")
	return parsed.String(), nil
}

// minEndpointSecret 回连密钥的最短长度。
//
// 这串东西是公网上唯一拦住「随便谁都能让你的机器替他跑活」的东西，
// 短密钥在这里不是不方便，是危险。24 个字符对自动生成的密钥毫无成本 ——
// 它本来就没人需要背下来。
const minEndpointSecret = 24

func validateEndpoint(input *dto.ExportEndpointInput) (string, string, error) {
	if input == nil {
		return "", "", fmt.Errorf("export 接入必须声明回连地址与密钥")
	}
	normalized, err := normalizeEndpointURL(input.URL)
	if err != nil {
		return "", "", err
	}
	secret := strings.TrimSpace(input.Secret)
	if len(secret) < minEndpointSecret {
		return "", "", fmt.Errorf("回连密钥至少 %d 个字符", minEndpointSecret)
	}
	if len(secret) > 128 {
		return "", "", fmt.Errorf("回连密钥不能超过 128 个字符")
	}
	return normalized, secret, nil
}

// RegisterNodeByKey 用提供者接入密钥自助注册一台机器（poll 或 export）。
//
// 与 Pair 的三处关键差别，每一处都是为无人值守的机器让路：
//
//  1. **不看同一台机器在不在线**。配对码那边的闸是「这台电脑上一次配出来的节点还在线
//     就不许再配」（见 assertMachineNotPaired），防的是同一台电脑配出两条节点。
//     接入密钥自带延续性（下面第 2 条）：同一台机器重注册复用同一条记录、只换令牌，
//     本来就不会多出一条，也就不需要那道闸。
//  2. **带 nodeId 就复用同一条记录**，只换一把新令牌。一台服务器一天重启几次，
//     每次新建一条节点记录，控制台一周就变成一片僵尸。
//  3. **不要求「刚刚有人点过同意」**，但仍然要求这个账号同意过当前条款版本 ——
//     密钥是长期的，条款很可能在它签发之后升过版。
func (s *service) RegisterNodeByKey(ctx context.Context, req dto.RegisterRequest) (dto.RegisterResult, error) {
	key, err := s.authenticateProviderKey(ctx, req.Key)
	if err != nil {
		return dto.RegisterResult{}, err
	}
	if req.Contract > 0 && req.Contract != s.config.ContractVersion {
		return dto.RegisterResult{}, contract.NewUnitError(contract.ErrorClassProtocol, contract.CodeContractMismatch, false,
			fmt.Sprintf("节点契约版本 %d 与 Hub 的 %d 不一致，请升级 ai-bridge", req.Contract, s.config.ContractVersion))
	}
	agreed, err := s.HasConsent(ctx, subjectProvider, key.OwnerUserID, s.config.ProviderTermsVersion)
	if err != nil {
		return dto.RegisterResult{}, err
	}
	if !agreed {
		return dto.RegisterResult{}, contract.ErrConsentRequired
	}

	mode := dto.NormalizeAccessMode(req.AccessMode)
	notice := ""
	endpointURL, endpointSecret := "", ""
	if mode == dto.AccessModeExport {
		endpointURL, endpointSecret, err = validateEndpoint(req.Endpoint)
		if err != nil {
			// 回落而不是拒绝：一台声明错了 export 的机器仍然能靠长轮询干活。
			// 直接拒掉，主人看到的是「机器连不上」，而真正的原因是一行填错的地址。
			mode = dto.AccessModePoll
			notice = fmt.Sprintf("回连信息不可用（%s），已按 poll 方式接入", err.Error())
			endpointURL, endpointSecret = "", ""
		}
	}

	now := time.Now()
	secret := "gnt_" + randomToken(32)
	nodeID := strings.TrimSpace(req.NodeID)
	if nodeID != "" {
		row, findErr := s.repository.FindNode(ctx, bizLine, nodeID)
		switch {
		case findErr != nil || row == nil || row.OwnerUserID != key.OwnerUserID:
			// 复用要先证明这条记录确实是这个主人的。不校验的话，任何持有**自己**
			// 密钥的人都能把别人的 nodeId 填进来，换一把令牌接管那台机器。
			nodeID = ""
		case row.Banned:
			// 封禁是平台对**这台机器**的决定。换一把令牌把它拉回来，等于用一次重启
			// 绕过封禁；静默新建一条也不对 —— 主人会以为一切正常。说清楚，停下来。
			return dto.RegisterResult{}, fmt.Errorf("这台机器（%s）已被平台停用，不能再注册", nodeID)
		case row.Status == "revoked":
			// 撤销是终态（见 repository.MarkNodeOffline 的注释），而且这里**不能**悄悄新建一行：
			// 独立部署的机器每次启动都会带着接入密钥自动注册，主人刚在控制台解绑的机器，
			// 下一次重启就会换一个 nodeId 自己回来 —— 那等于解绑按钮不管用。
			// 真要让它重新接入，得是那台机器上的一个明确动作：register --fresh 不带旧 nodeId。
			return dto.RegisterResult{}, fmt.Errorf("这台机器（%s）已在控制台解绑，不会再自动接入；确实要重新接入，请在那台机器上执行 ai-bridge register --fresh", nodeID)
		}
	}
	if nodeID == "" {
		nodeID = "n_" + NewULID(now)
	}

	node := &repository.GalaxyNode{
		BizLine:         bizLine,
		NodeID:          nodeID,
		OwnerUserID:     key.OwnerUserID,
		DisplayName:     truncate(defaultString(req.DisplayName, nodeID), 128),
		TokenHash:       HashSecret(secret),
		BridgeVersion:   truncate(req.BridgeVersion, 32),
		ContractVersion: s.config.ContractVersion,
		AccessMode:      mode,
		EndpointURL:     endpointURL,
		EndpointSecret:  endpointSecret,
		Status:          statusActive,
		LastBeatAt:      &now,
	}
	if err := s.repository.SaveNode(ctx, node); err != nil {
		return dto.RegisterResult{}, err
	}
	// SaveNode 的 DoUpdates 白名单里没有令牌、名字与接入方式（见那边的注释：
	// hello 会拿零值把它们抹掉）。复用同一条记录时那条 upsert 走的是 UPDATE 分支，
	// 于是新令牌根本没写进去 —— 节点拿着一把 Hub 不认的令牌，下一个请求就是 401。
	// 所以这里显式补一次。
	if err := s.repository.RotateNodeToken(ctx, bizLine, nodeID, node.TokenHash, node.DisplayName); err != nil {
		return dto.RegisterResult{}, err
	}
	if err := s.repository.SaveNodeAccess(ctx, bizLine, nodeID, mode, endpointURL, endpointSecret); err != nil {
		return dto.RegisterResult{}, err
	}
	_ = s.repository.TouchProviderKey(ctx, bizLine, key.KeyID, nodeID, now)

	return dto.RegisterResult{
		NodeID: nodeID, Token: secret, AccessMode: mode,
		HubURL: s.config.ProviderHubURL, Notice: notice,
	}, nil
}

// applyNodeAccess 把 hello 带上来的接入方式对齐到库里，并返回最终生效的那个。
//
// 每次 hello 都对齐，不是只在注册时记一次：公网地址会变（家宽的 IP 每天换，
// 容器换一次宿主端口就换）。只记一次的话，Hub 会拿着一个早就失效的地址一直
// 回连不上，而节点那边一切正常、日志里一个字都没有 —— 两边都觉得自己没错，
// 这是最难查的一种状态。
//
// 空 accessMode 表示「这一版节点不声明」：维持库里现状，不动。
func (s *service) applyNodeAccess(ctx context.Context, nodeID, accessMode string, endpoint *dto.ExportEndpointInput) (string, error) {
	declared := strings.TrimSpace(accessMode)
	if declared == "" {
		row, err := s.repository.FindNode(ctx, bizLine, nodeID)
		if err != nil || row == nil {
			return dto.AccessModePoll, nil
		}
		return dto.NormalizeAccessMode(row.AccessMode), nil
	}
	mode := dto.NormalizeAccessMode(declared)
	endpointURL, endpointSecret := "", ""
	if mode == dto.AccessModeExport {
		resolved, secret, err := validateEndpoint(endpoint)
		if err != nil {
			// 同 RegisterNodeByKey：回落到 poll，让机器继续干活。
			mode = dto.AccessModePoll
		} else {
			endpointURL, endpointSecret = resolved, secret
		}
	}
	if err := s.repository.SaveNodeAccess(ctx, bizLine, nodeID, mode, endpointURL, endpointSecret); err != nil {
		return mode, err
	}
	return mode, nil
}

// ExportTargetOf 取一台机器的回连信息。第二个返回值为假表示它不是 export 接入，
// 或者回连信息不完整（那种机器要走长轮询，派单器不该去推它）。
func (s *service) ExportTargetOf(ctx context.Context, nodeID string) (ExportTarget, bool) {
	row, err := s.repository.FindNode(ctx, bizLine, nodeID)
	if err != nil || row == nil {
		return ExportTarget{}, false
	}
	return exportTargetOfRow(row)
}

func exportTargetOfRow(row *repository.GalaxyNode) (ExportTarget, bool) {
	if row == nil || row.AccessMode != dto.AccessModeExport {
		return ExportTarget{}, false
	}
	if row.EndpointURL == "" || row.EndpointSecret == "" {
		return ExportTarget{}, false
	}
	if row.Banned || row.Status == "revoked" || row.TokenHash == "" {
		return ExportTarget{}, false
	}
	return ExportTarget{NodeID: row.NodeID, BaseURL: row.EndpointURL, Secret: row.EndpointSecret}, true
}

// ListExportTargets 全部还在用的 export 机器。Hub 的派单器启动时靠它把已有的
// 机器恢复回来 —— 只等 hello 是不够的，Hub 重启那一刻在线的机器可能一分钟内
// 都不会再 hello 一次，那一分钟里它们收不到任何活。
func (s *service) ListExportTargets(ctx context.Context) ([]ExportTarget, error) {
	rows, err := s.repository.ListExportNodes(ctx, bizLine)
	if err != nil {
		return nil, err
	}
	targets := make([]ExportTarget, 0, len(rows))
	for _, row := range rows {
		if target, ok := exportTargetOfRow(row); ok {
			targets = append(targets, target)
		}
	}
	return targets, nil
}

// NodeLanes 一台机器此刻还有空位的通道，形状与节点长轮询时自报的那份一致。
//
// export 模式下这份清单由 Hub 自己算 —— 节点不再来告诉它「我哪条通道还有位置」。
// 数据源是控制面里的快照，和放置算法看的是同一份，所以不会出现
// 「放置认为满了、派单器还在推」这种两套账。
//
// 算 free 而不是无脑推全部：推给一台满员的机器，它只能拒，而那一拒会让单元
// 白白走一趟失败与改派。少推一次比多失败一次便宜得多。
func (s *service) NodeLanes(ctx context.Context, nodeID string) ([]dto.NextLane, error) {
	snapshots, err := s.control.ListNodeContributions(ctx, nodeID)
	if err != nil {
		return nil, err
	}
	lanes := make([]dto.NextLane, 0, len(snapshots))
	for _, snapshot := range snapshots {
		if snapshot.Draining || snapshot.Paused || !snapshot.UpstreamOK {
			continue
		}
		free := snapshot.Concurrency() - snapshot.Inflight
		if free <= 0 {
			continue
		}
		lanes = append(lanes, dto.NextLane{CID: snapshot.CID, Free: free})
	}
	return lanes, nil
}

// RecordEndpointHealth 记一次回连探测的结果。
//
// detail 是给人看的：主人在控制台上看到的就是这句话，所以它必须说清楚
// 「是连不上，还是连上了但对面不是你的节点」。
func (s *service) RecordEndpointHealth(ctx context.Context, nodeID, status, detail string) error {
	return s.repository.SaveEndpointHealth(ctx, bizLine, nodeID, status, truncate(detail, 255), time.Now())
}

// ExportNodeHeader / ExportProbePath 暴露给装配层的回连客户端用。
// 常量定义留在领域包里 —— 它们是协议的一部分，不是传输实现的细节。
func ExportNodeHeader() string { return exportNodeHeader }
