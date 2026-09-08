package core

import (
	gocontext "context"
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"contract"
	"service/galaxy"
)

// 通道层胶水：一次消费者请求的完整生命周期。
// 这段代码对所有 kind 通用 —— 新增业务不改这里（X-01）。

const callerContextKey = "galaxy.caller"

// RequireConsumerKey 校验 sk- 算力密钥。四种拒绝各有自己的状态码与错误码，
// 客户端据此决定是重试、续期还是换模型。
func RequireConsumerKey(service galaxy.Service) gin.HandlerFunc {
	return func(context *gin.Context) {
		caller, err := service.AuthenticateKey(context.Request.Context(), context.GetHeader("Authorization"))
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

			waitErr := session.Wait(context.Request.Context())
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
