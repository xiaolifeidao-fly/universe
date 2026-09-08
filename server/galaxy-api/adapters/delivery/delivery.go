// Package delivery 是任务宇宙适配器：把交付任务面板的执行阶段以「回合」为单位
// 经共享池执行。
//
// kind 是 delivery.task，原语是 session —— 有状态多回合，硬亲和，节点掉线时
// 显式迁移并交接上下文。它和中转站共用同一套通道、放置、额度与计量，
// 区别只在这个文件里：入参怎么解、路由键从哪来、回合结果怎么记。
package delivery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"contract"
	corepkg "galaxy-api/adapters/core"
	"service/galaxy"
	"service/galaxy/dto"
)

const (
	Kind    = "delivery.task"
	Version = 1

	// DefaultProvider 节点侧执行这个 kind 的模块名。
	DefaultProvider = "delivery-task-planner"

	// DefaultInlineBytes 回合入参走内联；附件走 OSS 引用，不占这个额度。
	DefaultInlineBytes = 256 << 10
)

type Options struct {
	Providers []string
	// Estimate 每个回合的预估。设计文档要的是「该 phase 最近 100 回合的 p90」，
	// 在积累出足够样本之前先用这组保守值：预估只影响预留，终态按实际回补。
	Estimate contract.Metering
}

func (o Options) withDefaults() Options {
	if len(o.Providers) == 0 {
		o.Providers = []string{DefaultProvider}
	}
	if len(o.Estimate) == 0 {
		o.Estimate = contract.Metering{
			contract.UnitInputTokens:  20_000,
			contract.UnitOutputTokens: 8_000,
			contract.UnitCalls:        1,
			contract.UnitTimeSeconds:  600,
		}
	}
	return o
}

type Adapter struct {
	deps    *corepkg.Deps
	options Options
}

func New(deps *corepkg.Deps, options Options) *Adapter {
	return &Adapter{deps: deps, options: options.withDefaults()}
}

func (a *Adapter) Kind() contract.KindSpec {
	spec := contract.KindSpec{
		Kind: Kind, Version: Version, Primitive: contract.PrimitiveSession,
		Providers: a.options.Providers,
	}
	spec.Metering.Units = []contract.MeterUnit{
		contract.UnitInputTokens, contract.UnitOutputTokens, contract.UnitCalls, contract.UnitTimeSeconds,
	}
	// token 由节点自报：回合是 agent 在本机跑出来的，Hub 看不到上游那条流，
	// 解析不了 token。次数与时长仍由 Hub 自己计。
	spec.Metering.Trusted = []contract.MeterUnit{contract.UnitCalls, contract.UnitTimeSeconds}
	spec.Placement.Affinity = contract.AffinityHard
	// 回合不幂等：agent 会写文件、跑命令，重跑一次不等于没跑过。
	spec.Retry.Idempotent = false
	spec.Retry.MaxAttempts = 1
	spec.Lease.RenewSec = 60
	spec.Lease.MaxRunSec = 3600
	spec.Retention.Inputs = "7d"
	spec.Retention.Outputs = "30d"
	spec.Context.Schema = "context-delta.v1.schema.json"
	spec.Context.Resume = "ledger+checkpoint"
	spec.Input.MaxInlineBytes = DefaultInlineBytes
	return spec
}

// Routes 只列会产生工作单元的路径。会话管理与事件回放在 RegisterExtra 里。
func (a *Adapter) Routes() []corepkg.Route {
	return []corepkg.Route{{Method: http.MethodPost, Path: "/delivery/sessions/:sid/turns"}}
}

// turnInput 是一个回合的全部入参（设计文档 10.4）。
type turnInput struct {
	SID        string `json:"-"`
	Seq        int    `json:"seq"`
	Phase      string `json:"phase"`
	ItemKey    string `json:"itemKey"`
	ProgramRef string `json:"programRef"`
	Space      string `json:"space"`
	Input      struct {
		Text        string                 `json:"text"`
		Attachments []contract.ArtifactRef `json:"attachments"`
	} `json:"input"`
	Executor struct {
		Provider        string `json:"provider"`
		ReasoningEffort string `json:"reasoningEffort"`
		FastMode        bool   `json:"fastMode"`
	} `json:"executor"`

	// plan 由 Route 阶段的 BeginTurn 产出：这次该用什么 op、钉不钉、要不要续接。
	plan dto.TurnPlan
	raw  []byte
}

func (a *Adapter) Parse(ginContext *gin.Context) (corepkg.Input, error) {
	sid := ginContext.Param("sid")
	if sid == "" {
		return nil, contract.NewUnitError(contract.ErrorClassInput, contract.CodeInvalidBody, false, "缺少会话")
	}
	raw, err := io.ReadAll(io.LimitReader(ginContext.Request.Body, DefaultInlineBytes+1))
	if err != nil {
		return nil, contract.NewUnitError(contract.ErrorClassInput, contract.CodeInvalidBody, false, "读取请求体失败")
	}
	if len(raw) > DefaultInlineBytes {
		return nil, contract.NewUnitError(contract.ErrorClassInput, contract.CodeInvalidBody, false,
			"回合入参超过上限；大文件请先用 /v1/artifacts 上传再以引用传入")
	}
	parsed := &turnInput{SID: sid, raw: raw}
	if err := json.Unmarshal(raw, parsed); err != nil {
		return parsed, contract.NewUnitError(contract.ErrorClassInput, contract.CodeInvalidBody, false, "请求体不是合法 JSON")
	}
	if parsed.Input.Text == "" && len(parsed.Input.Attachments) == 0 {
		return parsed, contract.NewUnitError(contract.ErrorClassInput, contract.CodeInvalidBody, false, "回合缺少输入")
	}
	return parsed, nil
}

// Route 顺手把回合占位掉。占位必须发生在放置之前：先派单再占位的话，
// 同一个 seq 并发提交两次会真的跑两遍。
func (a *Adapter) Route(ctx context.Context, raw corepkg.Input) (contract.RouteKey, error) {
	in, ok := raw.(*turnInput)
	if !ok {
		return contract.RouteKey{}, contract.NewUnitError(contract.ErrorClassInput, contract.CodeInvalidBody, false, "入参形状不正确")
	}
	session, err := a.deps.Galaxy.GetSession(ctx, in.SID)
	if err != nil {
		return contract.RouteKey{}, err
	}
	provider := in.Executor.Provider
	if provider == "" {
		provider = session.Provider
	}
	route := contract.RouteKey{
		Kind: Kind, KindVersion: Version, Provider: provider,
		// 会话是硬亲和：亲和键按 sid 而不是密钥，同一个人开的几个会话各钉各的座位。
		AffinityKey: session.SID,
	}

	plan, err := a.deps.Galaxy.BeginTurn(ctx, dto.BeginTurnRequest{
		SID: in.SID, Seq: in.Seq, Input: map[string]any{
			"phase": in.Phase, "itemKey": in.ItemKey, "text": in.Input.Text,
			"attachments": in.Input.Attachments, "executor": in.Executor,
		},
	})
	if err != nil {
		return route, err
	}
	in.plan = plan
	route.HardPin = plan.HardPin
	return route, nil
}

// Intercept 幂等重放：这个 seq 已经跑过了，直接把已有结果还回去，不再派单。
func (a *Adapter) Intercept(ginContext *gin.Context, raw corepkg.Input) bool {
	in, ok := raw.(*turnInput)
	if !ok || in.plan.Existing == nil {
		return false
	}
	ginContext.JSON(http.StatusOK, gin.H{
		"sid": in.plan.SID, "seq": in.plan.Seq, "turn": in.plan.Existing, "replayed": true,
	})
	return true
}

func (a *Adapter) Estimate(corepkg.Input) contract.Metering {
	return a.options.Estimate.Clone()
}

func (a *Adapter) ToUnit(raw corepkg.Input, caller corepkg.Caller) contract.WorkUnit {
	in, ok := raw.(*turnInput)
	if !ok {
		return contract.WorkUnit{}
	}
	unit := contract.WorkUnit{
		Kind: Kind, KindVersion: Version, Primitive: contract.PrimitiveSession,
		ConsumerKey: caller.KeyID, Space: in.Space,
		SID: in.plan.SID, Op: in.plan.Op, Seq: in.plan.Seq,
		Inputs: []contract.Payload{{Name: "turn", Inline: in.raw, ContentType: "application/json"}},
	}
	// 续接要交给新节点的东西：工作区 sha、checkpoint、账本摘要。
	// 只有跨节点那一次才带，同节点续跑不需要 —— 它手里还有 thread。
	if in.plan.Resume != nil {
		if encoded, err := json.Marshal(in.plan.Resume); err == nil {
			unit.Inputs = append(unit.Inputs, contract.Payload{
				Name: "resume", Inline: encoded, ContentType: "application/json",
			})
		}
	}
	return unit
}

// Writer session 的写回器是事件日志：一个回合可能跑几分钟，
// 消费者中途断开重连是常态，事件不能只存在那条连接里。
func (a *Adapter) Writer(_ *gin.Context, _ corepkg.Input, unit contract.WorkUnit) corepkg.EventWriter {
	return corepkg.NewJournalWriter(a.deps.Journal, unit.ID)
}

// Accepted 受理回执。提交是异步的：消费者拿着 eventsUrl 去订阅这一回合的事件流，
// 中间断开重连都不影响回合本身继续跑。
func (a *Adapter) Accepted(ginContext *gin.Context, raw corepkg.Input, unit contract.WorkUnit, placement galaxy.Placement) {
	in, _ := raw.(*turnInput)
	sid, seq := unit.SID, unit.Seq
	if in != nil {
		sid, seq = in.plan.SID, in.plan.Seq
	}
	ginContext.JSON(http.StatusAccepted, gin.H{
		"sid": sid, "seq": seq, "unitId": unit.ID, "op": unit.Op,
		"state":     string(contract.UnitPlaced),
		"eventsUrl": fmt.Sprintf("/v1/delivery/sessions/%s/turns/%d/events", sid, seq),
		"migrated":  unit.Op == contract.OpResume,
		"attempt":   placement.Attempt,
	})
}

func (a *Adapter) ToError(_ corepkg.Input, status int, code, message string) any {
	return gin.H{"success": false, "code": -1, "error": gin.H{"type": code, "message": message, "status": status}}
}

// ---------- 辅助路由：会话管理与事件回放 ----------

func (a *Adapter) RegisterExtra(group *gin.RouterGroup, deps corepkg.Deps) {
	sessions := group.Group("/delivery/sessions")
	sessions.POST("", a.openSession)
	sessions.GET("", a.listSessions)
	sessions.GET("/:sid", a.getSession)
	sessions.POST("/:sid/close", a.closeSession)
	sessions.GET("/:sid/context", a.sessionContext)
	sessions.GET("/:sid/turns/:seq", a.getTurn)
	sessions.GET("/:sid/turns/:seq/events", a.turnEvents)
}

func (a *Adapter) openSession(ginContext *gin.Context) {
	var req dto.OpenSessionRequest
	if err := ginContext.ShouldBindJSON(&req); err != nil {
		ginContext.JSON(http.StatusBadRequest, a.ToError(nil, http.StatusBadRequest, contract.CodeInvalidBody, err.Error()))
		return
	}
	req.ConsumerKey = corepkg.CallerFrom(ginContext).KeyID
	req.Kind = Kind
	req.KindVersion = Version
	if req.Provider == "" {
		req.Provider = a.options.Providers[0]
	}
	view, err := a.deps.Galaxy.OpenSession(ginContext.Request.Context(), req)
	a.respond(ginContext, view, err)
}

func (a *Adapter) listSessions(ginContext *gin.Context) {
	limit, _ := strconv.Atoi(ginContext.DefaultQuery("limit", "50"))
	views, err := a.deps.Galaxy.ListSessions(ginContext.Request.Context(), corepkg.CallerFrom(ginContext).KeyID, limit)
	a.respond(ginContext, views, err)
}

func (a *Adapter) getSession(ginContext *gin.Context) {
	if !a.owns(ginContext) {
		return
	}
	view, err := a.deps.Galaxy.GetSession(ginContext.Request.Context(), ginContext.Param("sid"))
	a.respond(ginContext, view, err)
}

func (a *Adapter) closeSession(ginContext *gin.Context) {
	var body struct {
		Reason string `json:"reason"`
	}
	_ = ginContext.ShouldBindJSON(&body)
	err := a.deps.Galaxy.CloseSession(ginContext.Request.Context(), dto.CloseSessionRequest{
		SID: ginContext.Param("sid"), ConsumerKey: corepkg.CallerFrom(ginContext).KeyID, Reason: body.Reason,
	})
	a.respond(ginContext, gin.H{"sid": ginContext.Param("sid")}, err)
}

// sessionContext 业务层上下文的全部：会话元数据 + 每个回合的结构化摘要。
// 节点不在了这份东西仍然完整（T-08）。
func (a *Adapter) sessionContext(ginContext *gin.Context) {
	if !a.owns(ginContext) {
		return
	}
	fromSeq, _ := strconv.Atoi(ginContext.DefaultQuery("fromSeq", "0"))
	view, err := a.deps.Galaxy.SessionContext(ginContext.Request.Context(), ginContext.Param("sid"), fromSeq)
	a.respond(ginContext, view, err)
}

func (a *Adapter) getTurn(ginContext *gin.Context) {
	if !a.owns(ginContext) {
		return
	}
	seq, err := strconv.Atoi(ginContext.Param("seq"))
	if err != nil {
		ginContext.JSON(http.StatusBadRequest, a.ToError(nil, http.StatusBadRequest, contract.CodeInvalidBody, "回合序号非法"))
		return
	}
	view, findErr := a.deps.Galaxy.GetTurn(ginContext.Request.Context(), ginContext.Param("sid"), seq)
	a.respond(ginContext, view, findErr)
}

// turnEvents 回合事件的 SSE。先回放已经落库的，再接上实时流。
//
// 断线重连靠 Last-Event-ID / fromSeq：客户端说「我读到第几条了」，
// 这里从那之后接着发，不重不漏。
func (a *Adapter) turnEvents(ginContext *gin.Context) {
	if !a.owns(ginContext) {
		return
	}
	seq, err := strconv.Atoi(ginContext.Param("seq"))
	if err != nil {
		ginContext.JSON(http.StatusBadRequest, a.ToError(nil, http.StatusBadRequest, contract.CodeInvalidBody, "回合序号非法"))
		return
	}
	turn, err := a.deps.Galaxy.GetTurn(ginContext.Request.Context(), ginContext.Param("sid"), seq)
	if err != nil {
		a.respond(ginContext, nil, err)
		return
	}
	if turn.UnitID == "" {
		a.respond(ginContext, nil, contract.NewUnitError(contract.ErrorClassInput, contract.CodeInvalidBody, false, "该回合还没有派发出去"))
		return
	}

	fromSeq := 0
	if raw := ginContext.GetHeader("Last-Event-ID"); raw != "" {
		fromSeq, _ = strconv.Atoi(raw)
	}
	if raw := ginContext.Query("fromSeq"); raw != "" {
		fromSeq, _ = strconv.Atoi(raw)
	}

	ginContext.Header("Content-Type", "text/event-stream")
	ginContext.Header("Cache-Control", "no-cache, no-transform")
	ginContext.Header("X-Accel-Buffering", "no")
	ginContext.Status(http.StatusOK)
	ginContext.Writer.Flush()

	// 先回放库里的。库是权威：内存日志只保留最近一段，进程重启后也只剩它。
	persisted, err := a.deps.Galaxy.ListUnitEvents(ginContext.Request.Context(), turn.UnitID, fromSeq)
	if err == nil {
		for _, event := range persisted {
			if !writeSSE(ginContext, event.Seq, event.Kind, event.Data) {
				return
			}
			if event.Seq > fromSeq {
				fromSeq = event.Seq
			}
		}
	}

	// 再接上实时流。日志是先落库后广播的，所以这里按 fromSeq 续订不会漏。
	replay, live, cancel := a.deps.Journal.Subscribe(turn.UnitID, fromSeq)
	defer cancel()
	for _, event := range replay {
		if !writeSSE(ginContext, event.Seq, event.Kind, event.Data) {
			return
		}
		if event.Terminal {
			return
		}
	}
	// 兜底轮询：单元可能根本没被节点领走就失败了（排队超时、贡献被摘），
	// 那条路径不经过事件日志，订阅者收不到终态事件。定期回看一次单元状态，
	// 到终态就收线，别让消费者的连接永远挂着。
	guard := time.NewTicker(15 * time.Second)
	defer guard.Stop()
	for {
		select {
		case <-ginContext.Request.Context().Done():
			return
		case <-guard.C:
			if a.terminal(ginContext, turn.UnitID) {
				_ = writeSSE(ginContext, 0, "end", []byte(`{"reason":"unit_terminated"}`))
				return
			}
		case event, ok := <-live:
			if !ok {
				return
			}
			if !writeSSE(ginContext, event.Seq, event.Kind, event.Data) {
				return
			}
			if event.Terminal {
				return
			}
		}
	}
}

// terminal 回看这个单元有没有到终态。事件日志只覆盖「节点跑起来之后」的部分，
// 之前就失败的单元不会在日志里留下终态事件。
func (a *Adapter) terminal(ginContext *gin.Context, unitID string) bool {
	state, err := a.deps.Galaxy.UnitState(ginContext.Request.Context(), unitID)
	if err != nil {
		return false
	}
	return state.Terminal()
}

func writeSSE(ginContext *gin.Context, seq int, kind string, data []byte) bool {
	if len(data) == 0 {
		data = []byte("{}")
	}
	if _, err := fmt.Fprintf(ginContext.Writer, "id: %d\nevent: %s\ndata: %s\n\n", seq, kind, data); err != nil {
		return false
	}
	ginContext.Writer.Flush()
	return true
}

// owns 会话归属校验。校验失败时响应已经写好，调用方直接 return。
func (a *Adapter) owns(ginContext *gin.Context) bool {
	err := a.deps.Galaxy.AuthorizeSession(ginContext.Request.Context(),
		ginContext.Param("sid"), corepkg.CallerFrom(ginContext).KeyID)
	if err != nil {
		a.respond(ginContext, nil, err)
		return false
	}
	return true
}

func (a *Adapter) respond(ginContext *gin.Context, data any, err error) {
	if err != nil {
		var unitError *contract.UnitError
		status := http.StatusBadRequest
		code := contract.CodeInvalidBody
		if errors.As(err, &unitError) {
			status = unitError.HTTPStatus()
			code = unitError.Code
		} else if errors.Is(err, contract.ErrNotFound) {
			status = http.StatusNotFound
			code = "not_found"
		}
		ginContext.JSON(status, a.ToError(nil, status, code, err.Error()))
		return
	}
	ginContext.JSON(http.StatusOK, gin.H{"success": true, "code": 0, "data": data, "error": nil})
}

var _ corepkg.Adapter = (*Adapter)(nil)
var _ corepkg.Intercepting = (*Adapter)(nil)
var _ corepkg.Accepting = (*Adapter)(nil)
var _ corepkg.SelfRegistering = (*Adapter)(nil)
