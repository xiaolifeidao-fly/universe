// Package videofarm 是视频剪辑适配器：把一条时间线交给共享池里某台有算力的机器渲染。
//
// kind 是 video.edit.render，原语是 job —— 异步长任务、输入输出全部 OSS 引用、
// 无亲和但有数据引力：优先落在已经缓存了输入素材的机器上，省掉一次 GB 级下载。
//
// 它证明了一件事：新增业务只要写契约、适配器与节点 provider，
// 通道层、放置、额度、计量、传输一行都不用改（X-01）。
package videofarm

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"contract"
	"galaxy-common/kinds"
	corepkg "galaxy-hub-api/adapters/core"
	"service/galaxy"
)

const (
	Kind    = "video.edit.render"
	Version = 1

	DefaultProvider = "ffmpeg-local"

	// DefaultInlineBytes 时间线本身是一份 JSON，素材全走 OSS 引用。
	DefaultInlineBytes = 256 << 10
)

type Options struct {
	Providers []string
	// RequireDiskGB / RequireNetMbps 是放置的硬过滤条件：
	// 一台只剩 2GB 空间的机器接下渲染任务等于确定失败一次。
	RequireDiskGB  float64
	RequireNetMbps float64
}

func (o Options) withDefaults() Options {
	if len(o.Providers) == 0 {
		o.Providers = []string{DefaultProvider}
	}
	if o.RequireDiskGB <= 0 {
		o.RequireDiskGB = 20
	}
	if o.RequireNetMbps <= 0 {
		o.RequireNetMbps = 50
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
	return kinds.VideoFarm(a.options.Providers, a.options.RequireDiskGB, a.options.RequireNetMbps)
}

func (a *Adapter) Routes() []corepkg.Route {
	return []corepkg.Route{{Method: http.MethodPost, Path: "/videofarm/jobs"}}
}

// clip 一段素材。src 是 OSS 引用 —— job 的输入全部走引用，Hub 不经手字节。
type clip struct {
	Src     contract.ArtifactRef `json:"src"`
	In      float64              `json:"in"`
	Out     float64              `json:"out"`
	Effects []map[string]any     `json:"effects"`
}

type renderInput struct {
	Timeline struct {
		Tracks []map[string]any `json:"tracks"`
		Clips  []clip           `json:"clips"`
	} `json:"timeline"`
	Output struct {
		Codec      string  `json:"codec"`
		Resolution string  `json:"resolution"`
		FPS        float64 `json:"fps"`
	} `json:"output"`
	Subtitles *contract.ArtifactRef `json:"subtitles"`
	Space     string                `json:"space"`

	raw []byte
	// durationSec 时间线总时长，预估按它算。
	durationSec float64
}

func (a *Adapter) Parse(ginContext *gin.Context) (corepkg.Input, error) {
	raw, err := io.ReadAll(io.LimitReader(ginContext.Request.Body, DefaultInlineBytes+1))
	if err != nil {
		return nil, contract.NewUnitError(contract.ErrorClassInput, contract.CodeInvalidBody, false, "读取请求体失败")
	}
	if len(raw) > DefaultInlineBytes {
		return nil, contract.NewUnitError(contract.ErrorClassInput, contract.CodeInvalidBody, false, "时间线过大；素材请走 /v1/artifacts 上传后以引用传入")
	}
	parsed := &renderInput{raw: raw}
	if err := json.Unmarshal(raw, parsed); err != nil {
		return parsed, contract.NewUnitError(contract.ErrorClassInput, contract.CodeInvalidBody, false, "请求体不是合法 JSON")
	}
	if len(parsed.Timeline.Clips) == 0 {
		return parsed, contract.NewUnitError(contract.ErrorClassInput, contract.CodeInvalidBody, false, "时间线里没有任何片段")
	}
	for index, item := range parsed.Timeline.Clips {
		if item.Src.Key == "" {
			return parsed, contract.NewUnitError(contract.ErrorClassInput, contract.CodeArtifactMissing, false,
				"第 "+strconv.Itoa(index+1)+" 段缺少素材引用")
		}
		if item.Out > item.In {
			parsed.durationSec += item.Out - item.In
		}
	}
	if parsed.durationSec <= 0 {
		return parsed, contract.NewUnitError(contract.ErrorClassInput, contract.CodeInvalidBody, false, "时间线总时长为 0")
	}
	return parsed, nil
}

func (a *Adapter) Route(_ context.Context, raw corepkg.Input) (contract.RouteKey, error) {
	if _, ok := raw.(*renderInput); !ok {
		return contract.RouteKey{}, contract.NewUnitError(contract.ErrorClassInput, contract.CodeInvalidBody, false, "入参形状不正确")
	}
	// job 无亲和：不带 AffinityKey，每次都重新放置，让数据引力与空闲度说话。
	return contract.RouteKey{Kind: Kind, KindVersion: Version, Provider: a.options.Providers[0]}, nil
}

// Estimate 预估（设计文档 5.5）：输出时长按时间线算，CPU 秒按时长 × 分辨率系数。
func (a *Adapter) Estimate(raw corepkg.Input) contract.Metering {
	in, ok := raw.(*renderInput)
	if !ok {
		return contract.Metering{}
	}
	duration := int64(math.Ceil(in.durationSec))
	factor := resolutionFactor(in.Output.Resolution)
	return contract.Metering{
		contract.UnitVideoOutputSeconds: duration,
		contract.UnitCPUSeconds:         int64(math.Ceil(in.durationSec * factor)),
		// 渲染比实时慢：给两倍时长再加一个固定的启动开销做租约预估。
		contract.UnitTimeSeconds: duration*2 + 60,
	}
}

// resolutionFactor 分辨率越高每秒画面越贵。数值是量级估计，
// 只影响预留 —— 终态按节点自报的实际 CPU 秒回补。
func resolutionFactor(resolution string) float64 {
	switch resolution {
	case "3840x2160", "2160p", "4k":
		return 8
	case "2560x1440", "1440p":
		return 4
	case "1920x1080", "1080p", "":
		return 2
	case "1280x720", "720p":
		return 1
	}
	return 2
}

func (a *Adapter) ToUnit(raw corepkg.Input, caller corepkg.Caller) contract.WorkUnit {
	in, ok := raw.(*renderInput)
	if !ok {
		return contract.WorkUnit{}
	}
	unit := contract.WorkUnit{
		Kind: Kind, KindVersion: Version, Primitive: contract.PrimitiveJob,
		ConsumerKey: caller.KeyID, Space: in.Space,
		Inputs: []contract.Payload{{Name: "timeline", Inline: in.raw, ContentType: "application/json"}},
	}
	// 素材以引用进信封：放置时按它算数据引力，节点拿到 presigned 地址直取 OSS。
	for _, item := range in.Timeline.Clips {
		ref := item.Src
		unit.Inputs = append(unit.Inputs, contract.Payload{Name: "clip", Ref: &ref})
	}
	if in.Subtitles != nil && in.Subtitles.Key != "" {
		subtitles := *in.Subtitles
		unit.Inputs = append(unit.Inputs, contract.Payload{Name: "subtitles", Ref: &subtitles})
	}
	return unit
}

func (a *Adapter) Writer(_ *gin.Context, _ corepkg.Input, unit contract.WorkUnit) corepkg.EventWriter {
	return corepkg.NewJournalWriter(a.deps.Journal, unit.ID)
}

func (a *Adapter) Accepted(ginContext *gin.Context, _ corepkg.Input, unit contract.WorkUnit, placement galaxy.Placement) {
	ginContext.JSON(http.StatusAccepted, gin.H{
		"jobId": unit.ID, "state": string(contract.UnitPlaced), "attempt": placement.Attempt,
		"estimate":  placement.Estimate,
		"eventsUrl": "/v1/videofarm/jobs/" + unit.ID + "/events",
	})
}

func (a *Adapter) ToError(_ corepkg.Input, status int, code, message string) any {
	return gin.H{"success": false, "code": -1, "error": gin.H{"type": code, "message": message, "status": status}}
}

func (a *Adapter) RegisterExtra(group *gin.RouterGroup, _ corepkg.Deps) {
	jobs := group.Group("/videofarm/jobs")
	jobs.GET("", a.listJobs)
	jobs.GET("/:jobId", a.getJob)
	jobs.POST("/:jobId/cancel", a.cancelJob)
	jobs.GET("/:jobId/events", a.jobEvents)
}

func (a *Adapter) listJobs(ginContext *gin.Context) {
	limit, _ := strconv.Atoi(ginContext.DefaultQuery("limit", "50"))
	views, err := a.deps.Galaxy.ListJobs(ginContext.Request.Context(), corepkg.CallerFrom(ginContext).KeyID, Kind, limit)
	a.respond(ginContext, views, err)
}

func (a *Adapter) getJob(ginContext *gin.Context) {
	view, err := a.deps.Galaxy.GetJob(ginContext.Request.Context(),
		ginContext.Param("jobId"), corepkg.CallerFrom(ginContext).KeyID)
	a.respond(ginContext, view, err)
}

func (a *Adapter) cancelJob(ginContext *gin.Context) {
	err := a.deps.Galaxy.CancelJob(ginContext.Request.Context(),
		ginContext.Param("jobId"), corepkg.CallerFrom(ginContext).KeyID)
	a.respond(ginContext, gin.H{"jobId": ginContext.Param("jobId")}, err)
}

// jobEvents 进度与预览的 SSE。渲染要跑几十分钟，轮询查状态既费又慢。
func (a *Adapter) jobEvents(ginContext *gin.Context) {
	jobID := ginContext.Param("jobId")
	if _, err := a.deps.Galaxy.GetJob(ginContext.Request.Context(), jobID, corepkg.CallerFrom(ginContext).KeyID); err != nil {
		a.respond(ginContext, nil, err)
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

	persisted, err := a.deps.Galaxy.ListUnitEvents(ginContext.Request.Context(), jobID, fromSeq)
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
	replay, live, cancel := a.deps.Journal.Subscribe(jobID, fromSeq)
	defer cancel()
	for _, event := range replay {
		if !writeSSE(ginContext, event.Seq, event.Kind, event.Data) || event.Terminal {
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
		case <-a.deps.Drain:
			// 这台在优雅退出。订阅是可以中断的：事件先落库后广播，客户端拿着
			// 最后一个 seq 重连就能补齐，而挂着不放会把整个退出拖到超时强关。
			// 明确发一个 end 出去，别让客户端把干净的收线当成网络抖动。
			_ = writeSSE(ginContext, 0, "end", []byte(`{"reason":"hub_draining"}`))
			return
		case <-guard.C:
			if a.terminal(ginContext, jobID) {
				_ = writeSSE(ginContext, 0, "end", []byte(`{"reason":"unit_terminated"}`))
				return
			}
		case event, ok := <-live:
			if !ok {
				return
			}
			if !writeSSE(ginContext, event.Seq, event.Kind, event.Data) || event.Terminal {
				return
			}
		}
	}
}

// terminal 回看这个任务有没有到终态。事件日志只覆盖「节点跑起来之后」的部分，
// 排队超时这类在派单之前就失败的任务不会在日志里留下终态事件。
func (a *Adapter) terminal(ginContext *gin.Context, jobID string) bool {
	state, err := a.deps.Galaxy.UnitState(ginContext.Request.Context(), jobID)
	if err != nil {
		return false
	}
	return state.Terminal()
}

func writeSSE(ginContext *gin.Context, seq int, kind string, data []byte) bool {
	if len(data) == 0 {
		data = []byte("{}")
	}
	if _, err := ginContext.Writer.WriteString("id: " + strconv.Itoa(seq) + "\nevent: " + kind + "\ndata: " + string(data) + "\n\n"); err != nil {
		return false
	}
	ginContext.Writer.Flush()
	return true
}

func (a *Adapter) respond(ginContext *gin.Context, data any, err error) {
	if err != nil {
		var unitError *contract.UnitError
		status, code := http.StatusBadRequest, contract.CodeInvalidBody
		if errors.As(err, &unitError) {
			status, code = unitError.HTTPStatus(), unitError.Code
		} else if errors.Is(err, contract.ErrNotFound) {
			status, code = http.StatusNotFound, "not_found"
		}
		ginContext.JSON(status, a.ToError(nil, status, code, err.Error()))
		return
	}
	ginContext.JSON(http.StatusOK, gin.H{"success": true, "code": 0, "data": data, "error": nil})
}

var _ corepkg.Adapter = (*Adapter)(nil)
var _ corepkg.Accepting = (*Adapter)(nil)
var _ corepkg.SelfRegistering = (*Adapter)(nil)
