package routers

import (
	"context"
	"log"
	"strings"
	"time"

	"gorm.io/gorm"

	"common/middleware/httpx"
	"galaxy-common/bootstrap"
	corepkg "galaxy-hub-api/adapters/core"
	"galaxy-hub-api/adapters/delivery"
	"galaxy-hub-api/adapters/relay"
	"galaxy-hub-api/adapters/videofarm"
	"galaxy-hub-api/pkg/agent"
	"galaxy-hub-api/pkg/bridge"
	"galaxy-hub-api/pkg/exportdispatch"
	"galaxy-hub-api/pkg/local"
	"galaxy-hub-api/pkg/native"
	"service/galaxy"
)

type Assembly struct {
	*bootstrap.Assembly
	Registry *corepkg.Registry
	// Deps 是适配器与消费者侧路由共用的那一份依赖。存在这里是为了让 route()
	// 直接复用，而不是重拼一个把 AttachTimeout 之类的配置丢掉。
	Deps     *corepkg.Deps
	Exchange *corepkg.Exchange
	Journal  *corepkg.Journal
	Export   *exportdispatch.Dispatcher
	Agent    *agent.Handler
	Bridge   *bridge.Handler
	Native   *native.Handler
}

func Build(database *gorm.DB, drain *bootstrap.Drain) (*Assembly, error) {
	exchange := corepkg.NewExchange()
	// Drain 传给适配器：session / job 的 SSE 订阅要能在退出时自己收线，
	// 否则一条挂两小时的订阅会把整个优雅退出拖到超时强关。
	deps := &corepkg.Deps{Exchange: exchange, Drain: drain.Begun()}
	journal := corepkg.NewJournal(bootstrap.IntProperty("galaxy.journal_buffer", 512), func(unitID string, event corepkg.JournalEvent) {
		if deps.Galaxy == nil {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := deps.Galaxy.AppendUnitEvent(ctx, unitID, event.Seq, event.Kind, event.Data); err != nil {
			log.Printf("galaxy 事件落库失败 unit=%s seq=%d: %v", unitID, event.Seq, err)
		}
	})
	deps.Journal = journal
	deps.AttachTimeout = bootstrap.DurationProperty("galaxy.attach_timeout_ms", int(corepkg.DefaultAttachTimeout/time.Millisecond))
	deps.NodeProbeInterval = bootstrap.DurationProperty("galaxy.node_probe_interval_ms", int(corepkg.DefaultNodeProbeInterval/time.Millisecond))
	adapters, err := buildRegistry(deps)
	if err != nil {
		return nil, err
	}
	kinds := galaxy.NewKindRegistry()
	for _, spec := range adapters.Kinds() {
		if err := kinds.Register(spec); err != nil {
			return nil, err
		}
	}
	var replayer galaxy.ShadowReplayer
	if shadow := local.NewShadowReplayer(httpx.Property); shadow != nil {
		replayer = shadow
	} else {
		log.Print("galaxy 未配置 Hub 自有账号，抽检已关闭（galaxy.audit.*）")
	}
	base, err := bootstrap.Build(database, kinds, replayer)
	if err != nil {
		return nil, err
	}
	deps.Galaxy = base.Galaxy
	return &Assembly{Assembly: base, Registry: adapters, Deps: deps, Exchange: exchange, Journal: journal,
		Export: exportdispatch.New(base.Galaxy, exchange, base.Metrics),
		Agent: agent.NewHandler(base.Galaxy, exchange, journal,
			bootstrap.DurationProperty("galaxy.stream_idle_timeout_ms", 60000), base.Metrics, drain),
		Bridge: bridge.NewHandler(base.Galaxy), Native: native.NewHandler(base.Galaxy)}, nil
}
func buildRegistry(deps *corepkg.Deps) (*corepkg.Registry, error) {
	enabled := map[string]bool{}
	for _, name := range strings.Split(bootstrap.DefaultString(httpx.Property("galaxy.adapters"), "relay"), ",") {
		if trimmed := strings.TrimSpace(name); trimmed != "" {
			enabled[trimmed] = true
		}
	}
	var adapters []corepkg.Adapter
	if enabled["relay"] {
		adapters = append(adapters, relay.New(deps, relay.Options{
			BodyLimit: int64(bootstrap.IntProperty("galaxy.body_limit_bytes", relay.DefaultBodyLimit)),
			// 对外声明的模型清单。去空白、去重、空清单回落 DefaultModels 都在
			// relay 那边做 —— 那份清单的语义归它管，这里只负责把配置切开。
			Models: strings.Split(httpx.Property("galaxy.models"), ","),
		}))
	}
	if enabled["delivery"] {
		adapters = append(adapters, delivery.New(deps, delivery.Options{}))
	}
	if enabled["videofarm"] {
		adapters = append(adapters, videofarm.New(deps, videofarm.Options{}))
	}
	if len(adapters) == 0 {
		return nil, errNoAdapters
	}
	return corepkg.NewRegistry(adapters...), nil
}
