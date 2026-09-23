// Package exportdispatch 是 export 接入方式的派单器：Hub 主动把工作单元推到
// 节点的公网地址上，并把节点在同一条响应里回传的字节对拷给消费者。
//
// 它和长轮询那条路的关系，是本设计里最该记住的一点：**只有「活是怎么到节点手上的」
// 这一步不同**。放置、租约、计量、失败语义、终态回报全部原样复用 ——
// 这个包里的循环干的就是节点在 poll 模式下自己干的那件事（领活），
// 只不过领完之后是它把活送上门，而不是等对方来拿。
//
// 为什么值得这么做：poll 那条路要求节点常驻一条出站长连接，派单延迟受轮询
// 间隔约束。放在机房里、有稳定公网入口的机器不需要忍受这些 —— 让 Hub 直接敲门更快。
//
// 已知边界：**只支持单实例 Hub**（与 service.Submit 里「P0 单实例」同一前提）。
// 回流的字节只能交给持有消费者连接的那个进程，而队列是跨实例共享的 ——
// 多实例下本实例可能领到一个消费者连在别处的单元。那种单元这里判可改派的失败，
// 交还给通道层，而不是让节点把自己的令牌发往一个由网络请求指定的地址。
package exportdispatch

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"contract"
	corepkg "galaxy-hub-api/adapters/core"
	"service/galaxy"
	"service/galaxy/dto"
)

const (
	// refreshInterval 多久重扫一遍「有哪些 export 机器」。
	//
	// 不做成 hello 里的回调，而是定期重扫：hello 只是这份清单变化的**一个**来源，
	// 撤销机器、平台封禁、主人改了公网地址、Hub 自己重启，都会让它变。
	// 靠回调就得在每一处都记得通知一声，漏一处的表现是「一台机器在控制台上好好的，
	// 就是永远收不到活」—— 那种 bug 极难查。一条简单 SQL，10 秒一次不值得优化。
	refreshInterval = 10 * time.Second

	// claimWait 每一轮领活在队列上阻塞多久。与节点长轮询的默认值一致。
	claimWait = 25

	// idleWait 这台机器一条空闲通道都没有时歇多久。
	// 不能不歇：那会变成一个对着 Redis 空转的忙循环。
	idleWait = 2 * time.Second

	// probeInterval 回连健康探测的间隔。
	//
	// 它的用途不是判活（判活看心跳），而是回答主人「我的端口到底映射对没有」。
	// 那是个几乎不变的事实，探得再密也不会更准，只会给节点添无谓的请求。
	probeInterval = 60 * time.Second

	// headerTimeout 从发起回连到拿到响应头的时限。
	//
	// 盖住「节点收到单元 → 打上游 → 上游给响应头」这一整段：上游冷启动、
	// 长 prompt 的 prefill 都在里面。压太紧会把正常的慢请求误杀成节点故障。
	// 与通道层判「节点未认领上行」的 DefaultAttachTimeout 同源。
	headerTimeout = 30 * time.Second

	// streamIdleTimeout 拿到响应头之后，多久没有新字节就判节点故障。
	streamIdleTimeout = 60 * time.Second

	// chunkSize 对拷缓冲。SSE 事件通常几百字节，32KB 足够摊薄系统调用。
	chunkSize = 32 * 1024

	// identityRetryDelay 回连落到另一节点、且对方在执行前明确拒绝时，隔多久
	// 用一条全新的 TCP 连接再试一次。
	//
	// 公网入口前面常有 NAT / 反代。它们切后端时，Hub 连接池里可能短暂留着一条
	// 指向旧后端的 keep-alive；直接把这一次派单判死，会让带 previous_response_id
	// 的会话在客户端连续五次重连里得到同一个 502。只有 401/403 这种能证明对方
	// 尚未执行单元的响应才允许重试，避免重复碰上游。
	identityRetryDelay = 150 * time.Millisecond
)

// nodeLoop 一台机器的领活循环，连同它是按哪份回连信息起的。
// 留着 target 是为了发现「地址或密钥变了」—— 那时候必须重启循环，
// 否则它会一直往旧地址推，而节点那边一切正常。
type nodeLoop struct {
	cancel context.CancelFunc
	target galaxy.ExportTarget
}

// Dispatcher 管着「每台 export 机器一个领活循环」这件事。
type Dispatcher struct {
	galaxy   galaxy.Service
	exchange *corepkg.Exchange
	client   *http.Client
	// freshClient 禁用 keep-alive，只用于身份错位后的安全重试。正常流式响应仍走
	// client；否则每一次长对话都新建连接，白白损失连接复用。
	freshClient *http.Client
	metrics     galaxy.Metrics

	mu      sync.Mutex
	loops   map[string]nodeLoop
	started bool

	// health 每台机器最近一次写进库里的回连结论，用来去重（见 recordHealth）。
	healthMu sync.Mutex
	health   map[string]string
}

func New(service galaxy.Service, exchange *corepkg.Exchange, metrics galaxy.Metrics) *Dispatcher {
	return &Dispatcher{
		galaxy:      service,
		exchange:    exchange,
		metrics:     metrics,
		loops:       map[string]nodeLoop{},
		health:      map[string]string{},
		client:      exportHTTPClient(false),
		freshClient: exportHTTPClient(true),
	}
}

func exportHTTPClient(disableKeepAlives bool) *http.Client {
	return &http.Client{
		// 不设总超时：回连拿到的是一条流式响应，一次对话跑十分钟是正常的。
		// 时限由 ResponseHeaderTimeout（等响应头）和读循环里的空闲看门狗
		// （等字节）分别兜 —— 一个总超时会把长对话在中途掐断。
		Timeout: 0,
		Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			ResponseHeaderTimeout: headerTimeout,
			MaxIdleConnsPerHost:   32,
			IdleConnTimeout:       90 * time.Second,
			DisableKeepAlives:     disableKeepAlives,
		},
		// 不跟随重定向：回连的目标是主人自己填的地址，跟着 302 走等于把
		// 「Hub 会去访问哪台机器」的决定权交给了那台机器。
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// Start 起总循环。幂等：装配层可能在多处调它。
func (d *Dispatcher) Start(ctx context.Context) {
	d.mu.Lock()
	if d.started {
		d.mu.Unlock()
		return
	}
	d.started = true
	d.mu.Unlock()
	go d.refreshLoop(ctx)
}

// refreshLoop 把「在跑的循环」对齐到「库里的 export 机器」。
func (d *Dispatcher) refreshLoop(ctx context.Context) {
	ticker := time.NewTicker(refreshInterval)
	defer ticker.Stop()
	d.refresh(ctx)
	for {
		select {
		case <-ctx.Done():
			d.stopAll()
			return
		case <-ticker.C:
			d.refresh(ctx)
		}
	}
}

func (d *Dispatcher) refresh(ctx context.Context) {
	targets, err := d.galaxy.ListExportTargets(ctx)
	if err != nil {
		log.Printf("galaxy export 派单器读机器清单失败：%v", err)
		return
	}
	wanted := make(map[string]galaxy.ExportTarget, len(targets))
	for _, target := range targets {
		wanted[target.NodeID] = target
	}

	d.mu.Lock()
	defer d.mu.Unlock()
	for nodeID, loop := range d.loops {
		target, ok := wanted[nodeID]
		if ok && target == loop.target {
			continue
		}
		loop.cancel()
		delete(d.loops, nodeID)
		if ok {
			log.Printf("galaxy export 派单器重启 %s：回连地址或密钥变了", nodeID)
		} else {
			log.Printf("galaxy export 派单器停掉 %s：这台机器已不再回连接入", nodeID)
		}
	}
	for nodeID, target := range wanted {
		if _, ok := d.loops[nodeID]; ok {
			continue
		}
		loopCtx, cancel := context.WithCancel(ctx)
		d.loops[nodeID] = nodeLoop{cancel: cancel, target: target}
		go d.nodeLoop(loopCtx, target)
		log.Printf("galaxy export 派单器接管 %s（%s）", nodeID, target.BaseURL)
	}
}

func (d *Dispatcher) stopAll() {
	d.mu.Lock()
	defer d.mu.Unlock()
	for nodeID, loop := range d.loops {
		loop.cancel()
		delete(d.loops, nodeID)
	}
}

// nodeLoop 一台机器的领活循环。它做的正是节点在 poll 模式下自己做的事。
func (d *Dispatcher) nodeLoop(ctx context.Context, target galaxy.ExportTarget) {
	go d.probeLoop(ctx, target)
	for ctx.Err() == nil {
		lanes, err := d.galaxy.NodeLanes(ctx, target.NodeID)
		if err != nil {
			log.Printf("galaxy export 派单器读通道失败 node=%s：%v", target.NodeID, err)
			sleep(ctx, idleWait)
			continue
		}
		if len(lanes) == 0 {
			// 一条有空位的通道都没有：机器还没 hello，或者全满、全排空。
			// 这时候去 BLPOP 只是白占一条 Redis 连接。
			sleep(ctx, idleWait)
			continue
		}
		claimed, err := d.galaxy.Next(ctx, dto.NextRequest{
			NodeID: target.NodeID, Lanes: lanes, WaitSeconds: claimWait,
		})
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Printf("galaxy export 派单器领活失败 node=%s：%v", target.NodeID, err)
			sleep(ctx, idleWait)
			continue
		}
		if claimed == nil {
			continue
		}
		go d.push(ctx, target, claimed)
	}
}

// probeLoop 定期回连一次健康接口，把结果记到机器上。
//
// 它回答的是「你的公网入口通不通」，和心跳是两件事：心跳是节点主动出站的，
// 端口一个都没映射照样心跳正常。不分开显示，主人看到的是一台「在线但永远没活」
// 的机器，而真正的原因是防火墙。
func (d *Dispatcher) probeLoop(ctx context.Context, target galaxy.ExportTarget) {
	ticker := time.NewTicker(probeInterval)
	defer ticker.Stop()
	d.probe(ctx, target)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.probe(ctx, target)
		}
	}
}

func (d *Dispatcher) probe(ctx context.Context, target galaxy.ExportTarget) {
	probeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(probeCtx, http.MethodGet, target.ProbeURL(), nil)
	if err != nil {
		return
	}
	request.Header.Set("authorization", "Bearer "+target.Secret)
	response, err := d.client.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		d.recordHealth(ctx, target.NodeID, "unreachable",
			fmt.Sprintf("连不上 %s：%s", target.BaseURL, transportReason(err)), true)
		return
	}
	defer func() { _, _ = io.Copy(io.Discard, response.Body); _ = response.Body.Close() }()
	// 自证头放在状态码之前看：地址后面不是这台节点时，它回的 401 也不是节点的 401。
	// 这一条同时是 SSRF 的闸 —— 内网里那些「随便什么都回 200」的地址过不了它。
	if got := response.Header.Get(galaxy.ExportNodeHeader()); got != target.NodeID {
		d.recordHealth(ctx, target.NodeID, "unreachable",
			"这个地址后面不是本机节点，请核对公网地址与端口映射", true)
		return
	}
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		d.recordHealth(ctx, target.NodeID, "unreachable",
			"回连密钥被节点拒绝，请在那台机器上重新注册一次", true)
		return
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		d.recordHealth(ctx, target.NodeID, "unreachable",
			fmt.Sprintf("节点回了 %d", response.StatusCode), true)
		return
	}
	d.recordHealth(ctx, target.NodeID, "ok", "", true)
}

// recordHealth 记回连结论。force 为假时，结论没变就不写库。
//
// 派单成功每次都会得出「ok」，照写的话就是每个请求一条 UPDATE 打在节点表上 ——
// 高峰期那一行会成为全库最热的一行，而状态不变时重复写没有任何信息量。
// 探测走 force：它一分钟一次，要负责把「最近一次探测时刻」刷新给主人看。
func (d *Dispatcher) recordHealth(ctx context.Context, nodeID, status, detail string, force bool) {
	key := status + "\x00" + detail
	d.healthMu.Lock()
	unchanged := d.health[nodeID] == key
	d.healthMu.Unlock()
	if unchanged && !force {
		return
	}
	if err := d.galaxy.RecordEndpointHealth(ctx, nodeID, status, detail); err != nil {
		return
	}
	d.healthMu.Lock()
	d.health[nodeID] = key
	d.healthMu.Unlock()
}

// executeRequest 是 Hub 推给节点的那一份。字段刻意与长轮询的 NextResult 同名 ——
// 节点两条路上收到的是同一个东西，执行代码只有一份。
//
// 刻意**不带** streamURL：长轮询那边节点靠它反连回来推流，而这条路上字节就在
// 响应里回来。把它发出去只会诱使将来有人让节点「按请求里给的地址推流」——
// 那等于让任何拿到回连密钥的人指挥节点把自己的令牌发往任意地址。
type executeRequest struct {
	Unit  map[string]any `json:"unit"`
	Lease dto.LeaseView  `json:"lease"`
	// Cancel 搭车下发的取消清单，与长轮询一致。
	Cancel []string `json:"cancel"`
}

// push 把一个单元推给节点，并把响应流对拷给消费者。
func (d *Dispatcher) push(ctx context.Context, target galaxy.ExportTarget, claimed *dto.NextResult) {
	unitID := unitIDOf(claimed.Unit)
	if unitID == "" {
		return
	}
	// 交汇点不在本实例上，回流的字节就交不出去（见包注释里的「已知边界」）。
	// 判可改派的失败交还通道层 —— 这个单元会重新排队，由持有消费者连接的实例
	// 或长轮询的机器接走。
	if !d.exchange.Has(unitID) {
		d.observe(target.NodeID, "not_local", time.Now())
		d.abort(ctx, unitID, contract.CodeNodeUnavailable, true, "消费者连接不在本 Hub 实例上，export 回连只支持单实例部署")
		return
	}

	started := time.Now()
	payload, err := json.Marshal(executeRequest{Unit: claimed.Unit, Lease: claimed.Lease, Cancel: claimed.Cancel})
	if err != nil {
		d.abort(ctx, unitID, contract.CodeInvalidBody, false, "单元序列化失败")
		return
	}

	// 请求的生命周期跟着这次推送走，不跟着 nodeLoop：循环重启（改了地址）
	// 不该把正在流的对话掐断。
	requestCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	defer cancel()
	response, err := d.execute(requestCtx, target, unitID, payload)
	if err != nil {
		d.observe(target.NodeID, "unreachable", started)
		d.recordHealth(ctx, target.NodeID, "unreachable",
			fmt.Sprintf("连不上 %s：%s", target.BaseURL, transportReason(err)), false)
		// retryable：首字节还没发出去，通道层可以把它改派给别的机器。
		d.abort(ctx, unitID, contract.CodeNodeUnavailable, true, "回连节点失败，无法把这次请求送到那台机器上")
		return
	}
	defer func() { _ = response.Body.Close() }()

	// 自证头。放在读任何字节之前 —— 它不成立时，这条响应里的东西一个字节都
	// 不该到消费者手上（见 galaxy.ExportNodeHeader 的注释）。
	if got := response.Header.Get(galaxy.ExportNodeHeader()); got != target.NodeID {
		d.observe(target.NodeID, "rejected", started)
		log.Printf("galaxy export 回连身份不一致 node=%s got=%s status=%d url=%s unit=%s",
			target.NodeID, got, response.StatusCode, target.BaseURL, unitID)
		d.recordHealth(ctx, target.NodeID, "unreachable",
			"这个地址后面不是本机节点，请核对公网地址与端口映射", false)
		message := "回连到的不是这台节点，已放弃这次派单"
		if cid := hardPinOf(claimed.Unit); cid != "" {
			if err := d.galaxy.EnableHardPinFallback(ctx, cid); err == nil {
				message = "原节点回连身份错位，已解除旧会话节点绑定并自动改派"
			}
		}
		d.abort(ctx, unitID, contract.CodeNodeUnavailable, true, message)
		return
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		d.observe(target.NodeID, "rejected", started)
		message, retryable := rejection(response)
		d.abort(ctx, unitID, contract.CodeNodeUnavailable, retryable, message)
		return
	}
	d.recordHealth(ctx, target.NodeID, "ok", "", false)
	d.observe(target.NodeID, "ok", started)
	d.relay(ctx, unitID, response)
}

// execute 把单元送到节点。第一次走正常连接池；若回到另一节点，且那台节点用
// 401/403 明确证明「密钥不对、单元尚未执行」，就丢掉旧 keep-alive，用全新连接
// 再试一次。身份不一致但返回 2xx 时绝不重试：那台节点可能已经碰了上游，重放
// 会造成重复执行。
func (d *Dispatcher) execute(ctx context.Context, target galaxy.ExportTarget, unitID string, payload []byte) (*http.Response, error) {
	for attempt := 0; attempt < 2; attempt++ {
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, target.ExecuteURL(), strings.NewReader(string(payload)))
		if err != nil {
			return nil, err
		}
		request.Header.Set("content-type", "application/json")
		request.Header.Set("authorization", "Bearer "+target.Secret)
		request.Header.Set("x-galaxy-contract", strconv.Itoa(d.galaxy.Config().ContractVersion))
		request.Header.Set("x-galaxy-unit", unitID)

		client := d.client
		if attempt > 0 {
			client = d.freshClient
		}
		response, err := client.Do(request)
		if err != nil {
			return nil, err
		}
		got := response.Header.Get(galaxy.ExportNodeHeader())
		identityMismatch := got != target.NodeID
		rejectedBeforeExecution := response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden
		if attempt == 0 && identityMismatch && rejectedBeforeExecution {
			log.Printf("galaxy export 回连暂时落到另一节点，换新连接重试 node=%s got=%s status=%d url=%s unit=%s",
				target.NodeID, got, response.StatusCode, target.BaseURL, unitID)
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			sleep(ctx, identityRetryDelay)
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			continue
		}
		return response, nil
	}
	return nil, errors.New("回连重试未返回结果")
}

func hardPinOf(unit map[string]any) string {
	value, _ := unit["hardPin"].(string)
	return strings.TrimSpace(value)
}

// relay 把节点回来的字节对拷给消费者。这段与长轮询上行那边（agent.stream）
// 是同一套语义：先 Head、再对拷、最后 Finish，中间不落 Redis、不落盘。
func (d *Dispatcher) relay(ctx context.Context, unitID string, response *http.Response) {
	session, err := d.exchange.Attach(unitID)
	if err != nil {
		// 推送途中消费者走了（Has 与 Attach 之间）：让节点尽快 abort 上游。
		// 关掉这条连接，节点写响应时会立刻失败。
		if errors.Is(err, corepkg.ErrConsumerGone) {
			_ = d.galaxy.Abandon(ctx, unitID, "consumer_disconnected")
		}
		return
	}

	// 闸门要在读第一个字节之前就架好。节点写完最后一个字节就会去报 complete，
	// 而那条 complete 是另一条连接上的请求 —— 中间没有任何先后保证，
	// 它必须等到本函数把解析出的用量交出去为止，否则结算读到的是空。
	releaseUsage := d.exchange.Usage().Arm(unitID)
	defer releaseUsage()

	status := http.StatusOK
	if raw := response.Header.Get("X-Galaxy-Upstream-Status"); raw != "" {
		if parsed, convErr := strconv.Atoi(raw); convErr == nil && parsed >= 100 && parsed < 600 {
			status = parsed
		}
	}
	headers := decodeHeaders(response.Header.Get("X-Galaxy-Upstream-Headers"))

	// 空闲看门狗。上游卡住时节点也会卡住，这条连接不能无限期挂着。
	// 关掉 body 让阻塞中的 Read 立刻返回错误，是唯一能可靠打断它的手段。
	body := response.Body
	idle := time.AfterFunc(streamIdleTimeout, func() { _ = body.Close() })
	defer idle.Stop()

	buffer := make([]byte, chunkSize)
	headSent := false
	for {
		count, readErr := body.Read(buffer)
		if count > 0 {
			idle.Reset(streamIdleTimeout)
			if !headSent {
				session.Head(status, headers)
				headSent = true
			}
			if writeErr := session.Write(buffer[:count]); writeErr != nil {
				// 消费者走了：关掉这条连接，节点写响应时立刻失败、abort 上游 ——
				// 比等一个心跳周期的 cancel 快得多。
				_ = body.Close()
				_ = d.galaxy.Abandon(ctx, unitID, "consumer_disconnected")
				return
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			cause := contract.NewUnitError(contract.ErrorClassNode, contract.CodeStreamIdleTimeout, !headSent,
				"节点回传中断")
			session.Finish(cause)
			_ = d.galaxy.FailUnit(ctx, unitID, cause)
			return
		}
	}
	if !headSent {
		// 上游返回了空响应体：头还是要发出去，否则消费者永远等不到状态码。
		session.Head(status, headers)
	}
	session.Finish(nil)
	_ = d.galaxy.RecordHubResult(ctx, unitID, session.Usage(), session.Signature())
}

// abort 收掉一次没派成的单元。
//
// 先判失败、再收交汇点，顺序与通道层自己判定失败时一致（core.makeHandler 里
// HubJudged 那一段：先 FailUnit，再问 Reassignable）。反过来的话，消费者那边的
// Wait 会在失败落账之前就醒来去问「还能不能改派」，读到的是一份半截的状态。
//
// 收交汇点这一步不能省：不收，消费者要干等满 attach 时限（30 秒）
// 才知道活根本没送到。
func (d *Dispatcher) abort(ctx context.Context, unitID, code string, retryable bool, message string) {
	cause := contract.NewUnitError(contract.ErrorClassNode, code, retryable, message)
	_ = d.galaxy.FailUnit(ctx, unitID, cause)
	if session, err := d.exchange.Attach(unitID); err == nil {
		session.Finish(cause)
	}
}

func (d *Dispatcher) observe(nodeID, outcome string, started time.Time) {
	if d.metrics == nil {
		return
	}
	d.metrics.Count(galaxy.MetricExportDispatch, map[string]string{"node": nodeID, "outcome": outcome}, 1)
	d.metrics.Observe(galaxy.MetricExportDispatchLatency, map[string]string{"node": nodeID},
		float64(time.Since(started).Milliseconds()))
}

func unitIDOf(unit map[string]any) string {
	id, _ := unit["id"].(string)
	return id
}

// rejection 把节点回的错误翻成「要不要改派」。
//
// 409 与 5xx 是「这台机器现在接不了，换一台」；4xx 的其余是「这个单元本身有问题」，
// 换台机器也一样会失败，改派只是把同一个错误再跑一遍。
func rejection(response *http.Response) (string, bool) {
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
	message := strings.TrimSpace(string(raw))
	var payload struct {
		Message string `json:"message"`
		Error   struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &payload); err == nil {
		switch {
		case payload.Error.Message != "":
			message = payload.Error.Message
		case payload.Message != "":
			message = payload.Message
		}
	}
	if message == "" {
		message = fmt.Sprintf("节点回了 %d", response.StatusCode)
	}
	retryable := response.StatusCode == http.StatusConflict || response.StatusCode >= 500
	return message, retryable
}

// decodeHeaders 解 base64(json) 的上游响应头。解不开就当没有 ——
// 头是可选的，不该因为一个畸形头把整条响应废掉。
func decodeHeaders(raw string) map[string]string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	decoded, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return nil
	}
	var headers map[string]string
	if err := json.Unmarshal(decoded, &headers); err != nil {
		return nil
	}
	return headers
}

// transportReason 不带 URL：回连地址可能含自建部署的内网信息，
// 而这句话会一路显示到控制台上。
func transportReason(err error) string {
	var urlErr *url.Error
	if errors.As(err, &urlErr) && urlErr.Err != nil {
		return urlErr.Err.Error()
	}
	return err.Error()
}

func sleep(ctx context.Context, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}
