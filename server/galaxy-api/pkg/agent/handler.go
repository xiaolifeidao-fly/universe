// Package agent 是节点通道的传输层：这里的每个端点都由节点主动出站来调。
// export 接入时 Hub 会反过来连节点送活（见 pkg/exportdispatch），但出站这一侧不变。
//
// 这里的响应刻意不走 httpx.JSON 的统一信封。节点通道是机器协议，节点要按 HTTP 状态码
// 分支（409 租约失效、410 已取消、426 契约不匹配），把失败也返成 200 会让这套语义消失。
package agent

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"contract"
	corepkg "galaxy-api/adapters/core"
	"service/galaxy"
	"service/galaxy/dto"
)

const (
	nodeContextKey = "galaxy.node"
	// streamChunkSize 上行对拷的缓冲。SSE 事件通常几百字节，32KB 足够摊薄系统调用。
	streamChunkSize = 32 * 1024
)

type Handler struct {
	service  galaxy.Service
	exchange *corepkg.Exchange
	// journal 是 session / job 的事件日志。进度上报也要进它 ——
	// 一个渲染任务跑几十分钟，消费者该能盯着进度看，而不是每秒轮询一次状态。
	journal *corepkg.Journal
	// streamIdleTimeout 上行多久没有字节就判 node_fault（设计文档 2.5）。
	streamIdleTimeout time.Duration
	// metrics 观测上行的静默分布，用来回答 streamIdleTimeout 该设多少。可以为 nil。
	metrics galaxy.Metrics
}

func NewHandler(service galaxy.Service, exchange *corepkg.Exchange, journal *corepkg.Journal,
	streamIdleTimeout time.Duration, metrics galaxy.Metrics) *Handler {
	if streamIdleTimeout <= 0 {
		streamIdleTimeout = 60 * time.Second
	}
	return &Handler{
		service: service, exchange: exchange, journal: journal,
		streamIdleTimeout: streamIdleTimeout, metrics: metrics,
	}
}

func (h *Handler) RegisterHandler(group *gin.RouterGroup) {
	// 配对与自助注册都不带节点令牌 —— 它们就是用来换令牌的。
	group.POST("/pair", h.pair)
	// register 是配对码之外的第二条接入路径：拿提供者接入密钥换令牌。
	// 给单独部署、无人值守的 rust bridge 用 —— 那种机器上没人能去点「生成配对码」。
	group.POST("/register", h.register)

	authenticated := group.Group("", h.requireNode())
	authenticated.POST("/hello", h.hello)
	authenticated.POST("/heartbeat", h.heartbeat)
	authenticated.POST("/next", h.next)
	authenticated.POST("/units/:unitId/stream", h.stream)
	authenticated.POST("/units/:unitId/progress", h.progress)
	authenticated.POST("/units/:unitId/complete", h.complete)
	authenticated.POST("/units/:unitId/artifacts", h.signArtifact)
	// 升级进度回报。指令是搭在心跳响应上下来的，回报却单独一条路：
	// 节点装完就要立刻重启，等不到下一次心跳（那时候进程已经换人了）。
	authenticated.POST("/upgrade/report", h.upgradeReport)
}

// upgradeReport 节点回报这一次远程升级走到哪了。
//
// 回报不改变任何调度决定，只影响控制台上那一行字。所以它对失败很宽容：
// 指令 id 对不上（上一次升级的迟到回报）回 200 + accepted:false，让节点安心往下走，
// 而不是回一个错误码把节点带进重试。
func (h *Handler) upgradeReport(context *gin.Context) {
	var req dto.NodeUpgradeReport
	if err := context.ShouldBindJSON(&req); err != nil {
		fail(context, http.StatusBadRequest, contract.ErrorClassInput, contract.CodeInvalidBody, err.Error())
		return
	}
	req.NodeID = nodeFrom(context).NodeID
	accepted, err := h.service.ReportNodeUpgrade(context.Request.Context(), req)
	if err != nil {
		fail(context, http.StatusBadRequest, contract.ErrorClassInput, contract.CodeInvalidBody, err.Error())
		return
	}
	context.JSON(http.StatusOK, gin.H{"accepted": accepted})
}

// requireNode 用凭证认定节点身份，并覆盖请求体里的任何节点字段（端侧不可信）。
func (h *Handler) requireNode() gin.HandlerFunc {
	return func(context *gin.Context) {
		identity, err := h.service.AuthenticateNode(context.Request.Context(), context.GetHeader("Authorization"))
		if err != nil {
			fail(context, http.StatusUnauthorized, contract.ErrorClassProtocol, "node_unauthorized", err.Error())
			return
		}
		if version := strings.TrimSpace(context.GetHeader("X-Galaxy-Contract")); version != "" {
			if parsed, err := strconv.Atoi(version); err == nil && parsed != h.service.Config().ContractVersion {
				fail(context, http.StatusUpgradeRequired, contract.ErrorClassProtocol, contract.CodeContractMismatch,
					"节点契约版本与 Hub 不一致，请升级 ai-bridge")
				return
			}
		}
		context.Set(nodeContextKey, identity)
		context.Next()
	}
}

func nodeFrom(context *gin.Context) galaxy.NodeIdentity {
	value, _ := context.Get(nodeContextKey)
	identity, _ := value.(galaxy.NodeIdentity)
	return identity
}

func (h *Handler) pair(context *gin.Context) {
	var req dto.PairRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		fail(context, http.StatusBadRequest, contract.ErrorClassInput, contract.CodeInvalidBody, err.Error())
		return
	}
	result, err := h.service.Pair(context.Request.Context(), req)
	if err != nil {
		if errors.Is(err, contract.ErrConsentRequired) {
			fail(context, http.StatusForbidden, contract.ErrorClassProtocol, contract.CodeConsentRequired, err.Error())
			return
		}
		fail(context, http.StatusBadRequest, contract.ErrorClassInput, contract.CodeInvalidBody, err.Error())
		return
	}
	context.JSON(http.StatusOK, result)
}

// register 用提供者接入密钥自助注册一台机器（poll 或 export）。
//
// 失败一律说人话：这个接口的调用方是一台服务器上的 CLI，报错会原样打进它的日志，
// 而看那份日志的人手边没有源码。「接入密钥已吊销，请在控制台重新签发一把」
// 比一个 401 有用得多。
func (h *Handler) register(context *gin.Context) {
	var req dto.RegisterRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		fail(context, http.StatusBadRequest, contract.ErrorClassInput, contract.CodeInvalidBody, err.Error())
		return
	}
	result, err := h.service.RegisterNodeByKey(context.Request.Context(), req)
	if err != nil {
		var unitError *contract.UnitError
		if errors.As(err, &unitError) {
			fail(context, unitError.HTTPStatus(), unitError.Class, unitError.Code, unitError.Message)
			return
		}
		if errors.Is(err, contract.ErrConsentRequired) {
			fail(context, http.StatusForbidden, contract.ErrorClassProtocol, contract.CodeConsentRequired, err.Error())
			return
		}
		// 密钥不对是 401 而不是 400：CLI 要靠状态码分辨「重试没用，去换一把密钥」
		// 和「参数填错了，改一下再试」。
		fail(context, http.StatusUnauthorized, contract.ErrorClassProtocol, "provider_key_rejected", err.Error())
		return
	}
	context.JSON(http.StatusOK, result)
}

func (h *Handler) hello(context *gin.Context) {
	var req dto.HelloRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		fail(context, http.StatusBadRequest, contract.ErrorClassInput, contract.CodeInvalidBody, err.Error())
		return
	}
	identity := nodeFrom(context)
	req.NodeID = identity.NodeID
	req.OwnerUserID = identity.OwnerUserID
	result, err := h.service.Hello(context.Request.Context(), req)
	if err != nil {
		var unitError *contract.UnitError
		if errors.As(err, &unitError) {
			fail(context, unitError.HTTPStatus(), unitError.Class, unitError.Code, unitError.Message)
			return
		}
		if errors.Is(err, contract.ErrConsentRequired) {
			fail(context, http.StatusForbidden, contract.ErrorClassProtocol, contract.CodeConsentRequired, err.Error())
			return
		}
		if errors.Is(err, contract.ErrNodeBanned) {
			// 和 requireNode 拦下封禁节点回的是同一个：新配出来的记录要到 hello 才认得出被封，
			// 不能因为拦在这一层就落到下面的 400「请求体不合法」。
			fail(context, http.StatusUnauthorized, contract.ErrorClassProtocol, "node_unauthorized", err.Error())
			return
		}
		fail(context, http.StatusBadRequest, contract.ErrorClassInput, contract.CodeInvalidBody, err.Error())
		return
	}
	context.JSON(http.StatusOK, result)
}

func (h *Handler) heartbeat(context *gin.Context) {
	var req dto.HeartbeatRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		fail(context, http.StatusBadRequest, contract.ErrorClassInput, contract.CodeInvalidBody, err.Error())
		return
	}
	req.NodeID = nodeFrom(context).NodeID
	result, err := h.service.Heartbeat(context.Request.Context(), req)
	if err != nil {
		fail(context, http.StatusInternalServerError, contract.ErrorClassHub, "internal_error", err.Error())
		return
	}
	context.JSON(http.StatusOK, result)
}

// next 长轮询领活。请求体列出有空位的通道；没活可领时返 204，节点立刻再来一轮。
func (h *Handler) next(context *gin.Context) {
	var req dto.NextRequest
	// 用 POST 而不是 GET。
	//
	// 通道列表每次都不一样，塞进 query 会很长且难读，所以它在请求体里；而 fetch
	// 规范明令 GET / HEAD **不能带请求体** —— Node 的 undici 直接拒："Request with
	// GET/HEAD method cannot have body."，加 duplex: "half" 也绕不过去。
	// 结果是节点连一次活都领不到，长轮询循环空转重试。
	// 领活本身也不是只读的：它会占住租约、扣并发，POST 反而更贴切。
	//
	// 空 body 表示这一轮没有可领的通道，不能当成「所有通道都有空位」。
	if context.Request.Body != nil {
		_ = json.NewDecoder(context.Request.Body).Decode(&req)
	}
	req.NodeID = nodeFrom(context).NodeID
	req.WaitSeconds, _ = strconv.Atoi(context.DefaultQuery("waitSeconds", "25"))

	result, err := h.service.Next(context.Request.Context(), req)
	if err != nil {
		fail(context, http.StatusInternalServerError, contract.ErrorClassHub, "internal_error", err.Error())
		return
	}
	if result == nil {
		context.Status(http.StatusNoContent)
		return
	}
	context.JSON(http.StatusOK, result)
}

// stream 上行推流。节点边收上游边推，Hub 把字节直接对拷给持有消费者连接的那条响应，
// 中间不落 Redis、不落盘（架构 5.3）。背压天然从消费者顶回节点、再顶回上游 fetch。
func (h *Handler) stream(context *gin.Context) {
	unitID := context.Param("unitId")
	// 先确认这个单元确实派给了这个节点：交汇点只按 unitId 索引，
	// 少了这一关，任何在线节点都能往别人的消费者连接里灌字节。
	if err := h.service.AuthorizeUnit(context.Request.Context(), unitID, nodeFrom(context).NodeID); err != nil {
		writeUnitError(context, err)
		return
	}
	session, err := h.exchange.Attach(unitID)
	if err != nil {
		if errors.Is(err, corepkg.ErrConsumerGone) {
			fail(context, http.StatusGone, contract.ErrorClassProtocol, contract.CodeUnitCancelled, "消费者已断开")
			return
		}
		fail(context, http.StatusConflict, contract.ErrorClassProtocol, contract.CodeLeaseInvalid, err.Error())
		return
	}

	status := http.StatusOK
	if raw := context.GetHeader("X-Galaxy-Upstream-Status"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed >= 100 && parsed < 600 {
			status = parsed
		}
	}
	headers := decodeHeaders(context.GetHeader("X-Galaxy-Upstream-Headers"))

	body := context.Request.Body
	// 空闲看门狗：上游卡住时节点也会卡住，这条上行连接不能无限期挂着。
	// 关掉 body 让阻塞中的 Read 立刻返回错误，是唯一能可靠打断它的手段。
	idle := time.AfterFunc(h.streamIdleTimeout, func() { _ = body.Close() })
	defer idle.Stop()

	buffer := make([]byte, streamChunkSize)
	var received int64
	headSent := false
	// 这一次上行里最长的一段静默。看门狗的阈值必须盖住它，
	// 所以要量的正是它的分布，而不是平均值 —— 平均值永远好看。
	var longestGap time.Duration
	lastChunkAt := time.Now()
	defer func() {
		// 一个字节都没等到的那种是故障，不该混进正常分布里把 p99 拉平。
		if h.metrics != nil && headSent {
			h.metrics.Observe(galaxy.MetricStreamGap, nil, float64(longestGap.Milliseconds()))
		}
	}()
	for {
		count, readErr := body.Read(buffer)
		if count > 0 {
			now := time.Now()
			// 第一段算的是「上游给了响应头之后，隔多久才吐出第一个字节」。
			// 它同样受看门狗约束（计时从认领上行就开始），所以要一起量。
			if gap := now.Sub(lastChunkAt); gap > longestGap {
				longestGap = gap
			}
			lastChunkAt = now
			idle.Reset(h.streamIdleTimeout)
			if !headSent {
				// 首个 chunk 到达即视为首字节：状态码与白名单头这时才写给消费者。
				session.Head(status, headers)
				headSent = true
			}
			if writeErr := session.Write(buffer[:count]); writeErr != nil {
				// 消费者走了：410 让节点立刻 abort 上游，不再烧提供者额度。
				_ = h.service.Abandon(context.Request.Context(), unitID, "consumer_disconnected")
				fail(context, http.StatusGone, contract.ErrorClassProtocol, contract.CodeUnitCancelled, "消费者已断开")
				return
			}
			received += int64(count)
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			cause := contract.NewUnitError(contract.ErrorClassNode, contract.CodeStreamIdleTimeout, !headSent, "上行连接中断")
			session.Finish(cause)
			_ = h.service.FailUnit(context.Request.Context(), unitID, cause)
			fail(context, http.StatusBadGateway, cause.Class, cause.Code, cause.Message)
			return
		}
	}
	if !headSent {
		// 上游返回了空响应体：头还是要发出去，否则消费者永远等不到状态码。
		session.Head(status, headers)
	}
	session.Finish(nil)
	_ = h.service.RecordHubResult(context.Request.Context(), unitID, session.Usage(), session.Signature())
	context.JSON(http.StatusOK, gin.H{"received": received})
}

// signArtifact 给节点签一个上传产物的地址。job 的输出是 GB 级文件，
// 节点直传 OSS，Hub 不经手字节（约束 3）。
func (h *Handler) signArtifact(context *gin.Context) {
	unitID := context.Param("unitId")
	if err := h.service.AuthorizeUnit(context.Request.Context(), unitID, nodeFrom(context).NodeID); err != nil {
		writeUnitError(context, err)
		return
	}
	var req struct {
		Name        string `json:"name" binding:"required"`
		ContentType string `json:"contentType"`
		Size        int64  `json:"size" binding:"required"`
	}
	if err := context.ShouldBindJSON(&req); err != nil {
		fail(context, http.StatusBadRequest, contract.ErrorClassInput, contract.CodeInvalidBody, err.Error())
		return
	}
	ref, err := h.service.SignNodeUpload(context.Request.Context(), unitID, req.Name, req.ContentType, req.Size)
	if err != nil {
		writeUnitError(context, err)
		return
	}
	context.JSON(http.StatusOK, ref)
}

func (h *Handler) progress(context *gin.Context) {
	var req dto.ProgressRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		fail(context, http.StatusBadRequest, contract.ErrorClassInput, contract.CodeInvalidBody, err.Error())
		return
	}
	req.NodeID = nodeFrom(context).NodeID
	req.UnitID = context.Param("unitId")
	result, err := h.service.Progress(context.Request.Context(), req)
	if err != nil {
		writeUnitError(context, err)
		return
	}
	if h.journal != nil && len(req.Progress) > 0 {
		if encoded, err := json.Marshal(req.Progress); err == nil {
			h.journal.Append(req.UnitID, corepkg.JournalEvent{Kind: "progress", Data: encoded})
		}
	}
	context.JSON(http.StatusOK, result)
}

func (h *Handler) complete(context *gin.Context) {
	var req dto.CompleteRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		fail(context, http.StatusBadRequest, contract.ErrorClassInput, contract.CodeInvalidBody, err.Error())
		return
	}
	req.NodeID = nodeFrom(context).NodeID
	req.UnitID = context.Param("unitId")

	// 收尾交汇点。这里不能只处理失败：节点完全不推流就直接报完成也是合法的
	// （一个没有任何输出的回合），那种情况下事件日志永远等不到终态事件，
	// 订阅它的 SSE 会一直挂着。Attach 成功就说明确实没人收过尾。
	//
	// 正常推完流的那条早就 Finish 过了，Attach 会失败，不会重复收尾。
	if session, attachErr := h.exchange.Attach(req.UnitID); attachErr == nil {
		if req.State == string(contract.UnitCompleted) {
			session.Finish(nil)
		} else {
			session.Finish(unitCause(req.Error))
		}
	}
	result, err := h.service.Complete(context.Request.Context(), req)
	if err != nil {
		writeUnitError(context, err)
		return
	}
	// session / job 的交汇点不跟着消费者连接走，得在这里收尾。
	// relay 的那条早就被消费者侧摘掉了，这里是空操作。
	h.exchange.Release(req.UnitID)
	context.JSON(http.StatusOK, result)
}

func unitCause(cause *contract.UnitError) error {
	if cause == nil {
		return contract.NewUnitError(contract.ErrorClassNode, contract.CodeNodeOffline, true, "节点未给出原因")
	}
	return cause
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

func writeUnitError(context *gin.Context, err error) {
	var unitError *contract.UnitError
	if errors.As(err, &unitError) {
		fail(context, unitError.HTTPStatus(), unitError.Class, unitError.Code, unitError.Message)
		return
	}
	fail(context, http.StatusInternalServerError, contract.ErrorClassHub, "internal_error", err.Error())
}

func fail(context *gin.Context, status int, class contract.ErrorClass, code, message string) {
	context.AbortWithStatusJSON(status, gin.H{"class": class, "code": code, "message": message})
}
