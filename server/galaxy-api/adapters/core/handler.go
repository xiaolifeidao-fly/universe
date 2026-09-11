package core

import (
	gocontext "context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"contract"
	"service/galaxy"
)

// 通道层胶水：一次消费者请求的完整生命周期。
// 这段代码对所有 kind 通用 —— 新增业务不改这里（X-01）。

const callerContextKey = "galaxy.caller"

// ConsumerKeyHeader 是算力密钥的专用头。
//
// 为什么不只认 Authorization：已登录的 Claude Code 会把自己的 OAuth token 放进
// Authorization，环境变量里的 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY 都被它盖掉，
// 消费者唯一能稳定带上来的是 ANTHROPIC_CUSTOM_HEADERS 里的自定义头。
// 官方 SDK 则发 x-api-key。三个位置都看，谁像算力密钥就用谁。
const ConsumerKeyHeader = "X-Galaxy-Key"

// consumerKeyPrefix 与 galaxy.IssueKey 签发的前缀一致。
const consumerKeyPrefix = "sk-galaxy-"

// consumerSecret 从请求里找出算力密钥。带前缀的优先；一个都不像就把第一个非空的
// 交给 AuthenticateKey，让它给出「密钥不存在」而不是「缺少密钥」。
func consumerSecret(context *gin.Context) string {
	candidates := []string{
		context.GetHeader(ConsumerKeyHeader),
		strings.TrimPrefix(strings.TrimSpace(context.GetHeader("Authorization")), "Bearer "),
		context.GetHeader("x-api-key"),
	}
	first := ""
	for _, candidate := range candidates {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			continue
		}
		if strings.HasPrefix(candidate, consumerKeyPrefix) {
			return candidate
		}
		if first == "" {
			first = candidate
		}
	}
	return first
}

// RequireConsumerKey 校验 sk- 算力密钥。四种拒绝各有自己的状态码与错误码，
// 客户端据此决定是重试、续期还是换模型。
func RequireConsumerKey(service galaxy.Service) gin.HandlerFunc {
	return func(context *gin.Context) {
		caller, err := service.AuthenticateKey(context.Request.Context(), consumerSecret(context))
		if err != nil {
			var unitError *contract.UnitError
			if errors.As(err, &unitError) {
				context.AbortWithStatusJSON(unitError.HTTPStatus(), gin.H{
					"type":  "error",
					"error": gin.H{"type": unitError.Code, "message": unitError.Message},
				})
				return
			}
			context.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{
				"type": "error", "error": gin.H{"type": "internal_error", "message": err.Error()},
			})
			return
		}
		context.Set(callerContextKey, caller)
		context.Next()
	}
}

// Placed 是写回器的可选能力：放置成功后拿到贡献 id。
type Placed interface{ Placed(cid string) }

func CallerFrom(context *gin.Context) Caller {
	value, ok := context.Get(callerContextKey)
	if !ok {
		return Caller{}
	}
	caller, _ := value.(Caller)
	return caller
}

// Register 把一个适配器的消费者路由挂上去。
func Register(group *gin.RouterGroup, adapter Adapter, deps Deps) {
	handler := makeHandler(adapter, deps)
	for _, route := range adapter.Routes() {
		method := route.Method
		if method == "" {
			method = http.MethodPost
		}
		group.Handle(method, route.Path, handler)
	}
	if extra, ok := adapter.(SelfRegistering); ok {
		extra.RegisterExtra(group, deps)
	}
}

// RequestIDHeader 是消费者拿到的那一次执行的标识。申诉、排障都靠它。
const RequestIDHeader = "X-Galaxy-Request-Id"

func makeHandler(adapter Adapter, deps Deps) gin.HandlerFunc {
	return func(context *gin.Context) {
		caller := CallerFrom(context)

		in, err := adapter.Parse(context)
		if err != nil {
			writeError(context, adapter, in, err)
			return
		}
		route, err := adapter.Route(context.Request.Context(), in)
		if err != nil {
			writeError(context, adapter, in, err)
			return
		}
		if err := galaxy.AuthorizeRoute(caller, route); err != nil {
			writeError(context, adapter, in, err)
			return
		}
		// 幂等重放这类「不用派单就能答」的情况在这里收口。
		if intercepting, ok := adapter.(Intercepting); ok && intercepting.Intercept(context, in) {
			return
		}

		unit := adapter.ToUnit(in, caller)
		unit.Metering.Estimate = adapter.Estimate(in)
		unit.Kind = route.Kind
		unit.KindVersion = route.KindVersion
		unit.Provider = route.Provider
		unit.Model = route.Model
		unit.Family = route.Family
		unit.AffinityKey = route.AffinityKey
		unit.HardPin = route.HardPin
		unit.ConsumerKey = caller.KeyID
		unit.ID = "u_" + galaxy.NewULID(time.Now())
		// requestId 三段同值（设计文档 13 节的日志字段）：消费者、Hub、节点看到的是
		// 同一个串。消费者手里没有它就没法申诉，也没法拿着它来问「那次到底怎么了」。
		// 必须在 Writer 之前设好 —— 流式响应一旦开始，响应头就发出去了。
		context.Header(RequestIDHeader, unit.ID)

		writer := adapter.Writer(context, in, unit)
		spec := adapter.Kind()
		if spec.Primitive != contract.PrimitiveRelay {
			// session / job：提交即返回。一个回合或一个任务可能跑几分钟到几小时，
			// 把它绑在一条消费者连接上，用户切个网络就等于把活弄丢了。
			// 事件进日志，消费者按 seq 随时订阅、随时重连。
			submitDetached(context, adapter, deps, in, unit, writer)
			return
		}
		maxAttempts := spec.Retry.MaxAttempts
		if maxAttempts <= 0 {
			maxAttempts = 1
		}
		// 总时限只算一次。改派是 Hub 自己的补救动作，
		// 不该让消费者为每一次补救各等一个 maxRunSec。
		deadline := relayDeadline(spec)

		for attempt := 1; attempt <= maxAttempts; attempt++ {
			unit.Attempt = attempt
			session := deps.Exchange.Open(unit.ID, writer, func() {
				_ = deps.Galaxy.FirstByte(context.Request.Context(), unit.ID)
			})

			// Submit 之后节点随时可能领走这个单元，所以交汇点必须先开好。
			placement, err := deps.Galaxy.Submit(context.Request.Context(), unit)
			if err != nil {
				deps.Exchange.Close(unit.ID)
				writeError(context, adapter, in, err)
				return
			}
			// 回填贡献 id：适配器可能要用它记住「这次落在哪」（如 Responses 的链式硬钉）。
			if placed, ok := writer.(Placed); ok {
				placed.Placed(placement.CID)
			}

			// 等待带时限。放置成功只说明「有台在线机器接下了」，不说明它还活着 ——
			// 节点被 kill、断网、Nova 重启都不会有 stream 的 EOF，也不会有 complete，
			// 没有这几道限，消费者的 SDK 会一直转下去。
			waitErr := session.Wait(context.Request.Context(), WaitOptions{
				AttachTimeout: attachTimeout(deps),
				Deadline:      deadline,
				Alive:         func() bool { return deps.Galaxy.ContributionAlive(context.Request.Context(), placement.CID) },
				AliveInterval: nodeProbeInterval(deps),
			})
			deps.Exchange.Close(unit.ID)

			if waitErr == nil {
				_ = deps.Galaxy.RecordHubResult(context.Request.Context(), unit.ID, session.Usage(), signatureOf(writer))
				return
			}
			// 消费者自己断开：按已产出计费，并让节点尽快 abort 上游。
			// 收尾用 Background：请求上下文已经取消，拿它去写 Redis 会立刻失败。
			if context.Request.Context().Err() != nil {
				detached := gocontext.Background()
				_ = deps.Galaxy.RecordHubResult(detached, unit.ID, session.Usage(), signatureOf(writer))
				_ = deps.Galaxy.Abandon(detached, unit.ID, "consumer_disconnected")
				return
			}
			// Hub 自己判定的失败要在这里收口。节点报上来的那些（上行中断、complete
			// 报错）在节点通道那边已经 FailUnit 过了，这一类不会有人来 ——
			// 不还预留，那台机器的并发位就永久少一个；不改派前先还，理由同 requeue。
			if HubJudged(waitErr) {
				var cause *contract.UnitError
				errors.As(waitErr, &cause)
				_ = deps.Galaxy.FailUnit(context.Request.Context(), unit.ID, cause)
				// 节点也可能只是慢而不是死了。cancel 搭在续租的响应里回去，
				// 它还活着就能立刻停手，不再烧主人的上游额度。
				_ = deps.Galaxy.Abandon(context.Request.Context(), unit.ID, "node_unresponsive")
			}
			// 首字节之后不改派：已经流出去的字节没法收回，直接 502。
			if session.Started() || attempt >= maxAttempts || !deps.Galaxy.Reassignable(context.Request.Context(), unit.ID) {
				writeError(context, adapter, in, waitErr)
				return
			}
			if deps.Log != nil {
				deps.Log.Info("galaxy_reassign", "unitId", unit.ID, "attempt", attempt+1, "reason", waitErr.Error())
			}
		}
	}
}

const (
	// DefaultAttachTimeout 节点认领上行的默认时限。
	//
	// 取值要盖住「领活 → 打上游 → 首字节」这一段：上游冷启动、长 prompt 的
	// prefill 都在里面，压到十几秒会把正常的慢请求误杀成节点故障。
	// 30 秒之后仍然没有任何人来认领，那台机器基本可以判定是没了。
	DefaultAttachTimeout = 30 * time.Second
	// DefaultNodeProbeInterval 首字节之前探节点心跳的间隔。
	//
	// 心跳本身 15 秒一次、45 秒判离线，探得比这更密没有额外信息，
	// 只是把每个在途请求都变成一条定时 Redis 查询。
	DefaultNodeProbeInterval = 10 * time.Second
)

func attachTimeout(deps Deps) time.Duration {
	if deps.AttachTimeout > 0 {
		return deps.AttachTimeout
	}
	return DefaultAttachTimeout
}

func nodeProbeInterval(deps Deps) time.Duration {
	if deps.NodeProbeInterval > 0 {
		return deps.NodeProbeInterval
	}
	return DefaultNodeProbeInterval
}

// relayDeadline 一次 relay 请求的总时限，与 Submit 写进单元发给节点的那个同源
// （kind 的 lease.maxRunSec），否则「这活最多跑 600 秒」就成了一句只对节点生效的话。
//
// 为什么在这里自己算，而不是读 unit.Deadline：Submit 收的是值，它在自己那份
// 拷贝上补的字段回不到通道层 —— 读出来恒为 0，这道限会静默失效。
func relayDeadline(spec contract.KindSpec) time.Time {
	if spec.Lease.MaxRunSec <= 0 {
		return time.Time{}
	}
	return time.Now().Add(time.Duration(spec.Lease.MaxRunSec) * time.Second)
}

// submitDetached 是 session / job 的提交路径：开好交汇点、放置，然后立刻回执。
// 交汇点由节点的 complete 负责摘除，不跟着消费者连接走。
func submitDetached(context *gin.Context, adapter Adapter, deps Deps, in Input, unit contract.WorkUnit, writer EventWriter) {
	unit.Attempt = 1
	deps.Exchange.Open(unit.ID, writer, func() {
		_ = deps.Galaxy.FirstByte(gocontext.Background(), unit.ID)
	})
	placement, err := deps.Galaxy.Submit(context.Request.Context(), unit)
	if err != nil {
		deps.Exchange.Release(unit.ID)
		if deps.Journal != nil {
			deps.Journal.Release(unit.ID)
		}
		writeError(context, adapter, in, err)
		return
	}
	if placed, ok := writer.(Placed); ok {
		placed.Placed(placement.CID)
	}
	if accepting, ok := adapter.(Accepting); ok {
		accepting.Accepted(context, in, unit, placement)
		return
	}
	context.JSON(http.StatusAccepted, gin.H{"unitId": unit.ID, "state": string(contract.UnitPlaced)})
}

// signatureOf 取写回器的结构签名。不实现 Signing 的适配器返回空串，
// 抽检对它们自动跳过。
func signatureOf(writer EventWriter) string {
	if signing, ok := writer.(Signing); ok {
		return signing.Signature()
	}
	return ""
}

// writeError 渲染错误。响应已经开始流了就只能把连接结束掉 ——
// SSE 中途改不了状态码，硬塞一个错误体会污染客户端的解析。
func writeError(context *gin.Context, adapter Adapter, in Input, err error) {
	status, code, message := describe(err)
	if context.Writer.Written() {
		context.Abort()
		return
	}
	if status == http.StatusServiceUnavailable {
		context.Header("retry-after", "2")
	}
	context.AbortWithStatusJSON(status, adapter.ToError(in, status, code, message))
}

func describe(err error) (int, string, string) {
	var unitError *contract.UnitError
	if errors.As(err, &unitError) {
		return unitError.HTTPStatus(), unitError.Code, unitError.Message
	}
	if errors.Is(err, ErrConsumerGone) {
		return 499, "client_closed", err.Error()
	}
	if errors.Is(err, contract.ErrNoCapacity) {
		return http.StatusServiceUnavailable, contract.CodeNoCapacity, err.Error()
	}
	return http.StatusInternalServerError, "internal_error", err.Error()
}
