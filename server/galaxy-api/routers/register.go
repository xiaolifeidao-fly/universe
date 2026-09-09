package routers

import (
	"context"
	"log"
	"strconv"
	"strings"
	"time"

	"gorm.io/gorm"

	"common/middleware/httpx"
	"common/objectstore"

	corepkg "galaxy-api/adapters/core"
	"galaxy-api/adapters/delivery"
	"galaxy-api/adapters/relay"
	"galaxy-api/adapters/videofarm"
	"galaxy-api/pkg/admin"
	"galaxy-api/pkg/agent"
	authpkg "galaxy-api/pkg/auth"
	"galaxy-api/pkg/consumers"
	"galaxy-api/pkg/local"
	"galaxy-api/pkg/metrics"
	"galaxy-api/pkg/payments"
	"galaxy-api/pkg/providers"
	"service/galaxy/redisctl"

	"contract"
	"service/galaxy"
	"service/identity"
)

// Assembly 是 Hub 的装配结果。main.go 拿它挂路由与后台巡检。
type Assembly struct {
	Galaxy   galaxy.Service
	Metrics  *metrics.Registry
	Registry *corepkg.Registry
	Exchange *corepkg.Exchange
	Journal  *corepkg.Journal
	Control  *redisctl.ControlPlane

	Auth      *authpkg.Handler
	Agent     *agent.Handler
	Consumers *consumers.Handler
	Providers *providers.Handler
	Admin     *admin.Handler
}

// Build 是 galaxy-api 唯一的装配点。
//
// 顺序是被依赖关系逼出来的：适配器决定有哪些 kind，kind 注册表喂给共享池核心，
// 核心再回过头注入适配器 —— 所以适配器先用一个空 Deps 建出来拿 KindSpec，
// 装配完成后再把真正的 Deps 填回去。
func Build(database *gorm.DB) (*Assembly, error) {
	control := redisctl.New(redisctl.Options{
		Addresses: httpx.Property("redis.addr"),
		Password:  httpx.Property("redis.password"),
		Mode:      httpx.Property("redis.mode"),
		Namespace: httpx.Property("galaxy.redis_namespace"),
		PoolSize:  intProperty("galaxy.redis_pool_size", 0),
	})
	if control == nil {
		// 共享池没有控制面就无法保证座位与额度的原子性，宁可不启动也不能带病收单。
		return nil, errMissingRedis
	}

	var signer galaxy.ObjectSigner
	if config, err := objectstore.LoadAliyunOSSDeployment(httpx.Property); err != nil {
		log.Printf("galaxy OSS 配置不可用，产物接口将不可用: %v", err)
	} else if storage, err := config.NewClient(); err != nil {
		log.Printf("galaxy OSS 客户端不可用，产物接口将不可用: %v", err)
	} else if storage != nil {
		signer = local.ObjectSigner{Storage: storage}
	}

	exchange := corepkg.NewExchange()
	deps := &corepkg.Deps{Exchange: exchange}
	// 事件日志的落库回调要用到共享池服务，而服务又要先有 kind 注册表才能建起来。
	// 用一个先建后填的闭包打破这个环 —— 日志在第一条事件到来之前不会被调用。
	journal := corepkg.NewJournal(intProperty("galaxy.journal_buffer", 512), func(unitID string, event corepkg.JournalEvent) {
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

	// 启用哪些适配器由配置决定（架构 12：同一二进制可作纯中转站部署）。
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

	// 抽检用 Hub 自己的账号重放。没配就是 nil，抽检整体关闭 ——
	// 拿被查者的凭据去查，查出来的结论没有意义。
	var replayer galaxy.ShadowReplayer
	if shadow := local.NewShadowReplayer(httpx.Property); shadow != nil {
		replayer = shadow
	} else {
		log.Print("galaxy 未配置 Hub 自有账号，抽检已关闭（galaxy.audit.*）")
	}

	// 支付回调验签。没配密钥就是 nil，回调接口整体不挂 ——
	// 一个不验签的支付回调等于把「发额度」挂在公网上让人随便调。
	verifier := loadPaymentVerifier()

	registry := metrics.New()
	service := galaxy.New(database, galaxy.Ports{
		Control: control, Signer: signer, Replayer: replayer,
		Audit: loadAuditConfig(), Metrics: registry, Payment: verifier,
	}, kinds, loadConfig())
	deps.Galaxy = service

	identityService := identity.New(database, local.NoProgramScope{},
		httpx.Property("auth.token_secret"), tokenTTL())
	httpx.SetUserAuthenticator(identityService)

	return &Assembly{
		Galaxy:   service,
		Metrics:  registry,
		Registry: adapters,
		Exchange: exchange,
		Journal:  journal,
		Control:  control,
		Auth:     authpkg.NewHandler(identityService),
		Agent: agent.NewHandler(service, exchange, journal,
			durationProperty("galaxy.stream_idle_timeout_ms", 60_000)),
		Consumers: consumers.NewHandler(service),
		Providers: providers.NewHandler(service),
		Admin:     admin.NewHandler(service),
	}, nil
}

func buildRegistry(deps *corepkg.Deps) (*corepkg.Registry, error) {
	enabled := map[string]bool{}
	for _, name := range strings.Split(defaultString(httpx.Property("galaxy.adapters"), "relay"), ",") {
		if trimmed := strings.TrimSpace(name); trimmed != "" {
			enabled[trimmed] = true
		}
	}
	var adapters []corepkg.Adapter
	if enabled["relay"] {
		adapters = append(adapters, relay.New(deps, relay.Options{
			BodyLimit: int64(intProperty("galaxy.body_limit_bytes", relay.DefaultBodyLimit)),
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

// loadConfig 把默认参数表（设计文档第 15 节）接到 application.properties 上。
// 没配的项一律走默认值，部署方只需要覆盖真正想改的那几个。
func loadConfig() galaxy.Config {
	config := galaxy.DefaultConfig()
	config.Instance = defaultString(httpx.Property("galaxy.instance"), "http://127.0.0.1:10004")
	config.ContractVersion = intProperty("galaxy.contract_version", config.ContractVersion)
	config.PlatformSeatLimit = intProperty("galaxy.platform_seat_limit", config.PlatformSeatLimit)
	config.BindIdleTTL = durationProperty("galaxy.bind_idle_ttl_ms", int(config.BindIdleTTL.Milliseconds()))
	config.SpillWait = durationProperty("galaxy.spill_wait_ms", int(config.SpillWait.Milliseconds()))
	config.MaxWait = durationProperty("galaxy.max_wait_ms", int(config.MaxWait.Milliseconds()))
	config.HeartbeatTimeout = durationProperty("galaxy.heartbeat_timeout_ms", int(config.HeartbeatTimeout.Milliseconds()))
	config.KeyTTL = time.Duration(intProperty("galaxy.key_ttl_days", 30)) * 24 * time.Hour
	config.KeyFreeze = time.Duration(intProperty("galaxy.key_freeze_days", 30)) * 24 * time.Hour
	config.ProviderTermsVersion = defaultString(httpx.Property("galaxy.provider_terms_version"), config.ProviderTermsVersion)
	config.ConsumerNoticeVersion = defaultString(httpx.Property("galaxy.consumer_notice_version"), config.ConsumerNoticeVersion)
	// 不配就由 withDefaults 从 galaxy.instance 派生成 <instance>/v1。
	config.ConsumerBaseURL = strings.TrimSpace(httpx.Property("galaxy.consumer_base_url"))
	// 节点侧的对外地址。不配就由 withDefaults 从 consumer_base_url 去掉 /v1 派生。
	config.ProviderHubURL = strings.TrimSpace(httpx.Property("galaxy.provider_hub_url"))
	config.SessionIdleTTL = time.Duration(intProperty("galaxy.session_idle_hours", 24)) * time.Hour
	return config
}

// loadAuditConfig 抽检参数。比例在 service 里再封一次 1% 上限 ——
// 那是对提供者的承诺，不该由一行配置就能改掉。
func loadAuditConfig() galaxy.AuditConfig {
	config := galaxy.DefaultAuditConfig()
	if raw := strings.TrimSpace(httpx.Property("galaxy.audit.ratio")); raw != "" {
		if value, err := strconv.ParseFloat(raw, 64); err == nil && value >= 0 {
			config.Ratio = value
		}
	}
	config.DailyCap = intProperty("galaxy.audit.daily_cap", config.DailyCap)
	return config
}

// loadPaymentVerifier 按配置组装支付渠道表。
//
// 一个渠道都没配就返回 nil：这时回调路由压根不注册，渠道打过来是 404。
// 比「注册了但不验签」好得多 —— 后者会在没人注意的时候把额度发给任何人。
//
// 三组配置，可以同时存在：
//
//	galaxy.payment.hmac_secret            单渠道的老写法，渠道码取 galaxy.payment.channel
//	galaxy.payment.channels = a,b         多渠道，各自的密钥在 galaxy.payment.<code>.*
//	galaxy.payment.sandbox_channels = c,d 沙箱渠道，不验签、不收回调，本人点一下就算付
func loadPaymentVerifier() galaxy.PaymentVerifier {
	var channels []payments.Channel

	// 老写法：一把密钥挂在一个渠道码上。留着它，已有部署改配置文件才不是必须的。
	if secret := strings.TrimSpace(httpx.Property("galaxy.payment.hmac_secret")); secret != "" {
		code := defaultProperty("galaxy.payment.channel", "default")
		channel, err := hmacChannel(code, "galaxy.payment", secret)
		if err != nil {
			log.Printf("galaxy 支付渠道 %s 构造失败，该渠道未启用：%v", code, err)
		} else {
			channels = append(channels, channel)
		}
	}

	for _, code := range splitCodes(httpx.Property("galaxy.payment.channels")) {
		prefix := "galaxy.payment." + code
		secret := strings.TrimSpace(httpx.Property(prefix + ".hmac_secret"))
		if secret == "" {
			// 列进来了却没给密钥，多半是配漏了。宁可这个渠道不可用，
			// 也不能让它带着一个空密钥上线。
			log.Printf("galaxy 支付渠道 %s 没有配密钥（%s.hmac_secret），该渠道未启用", code, prefix)
			continue
		}
		channel, err := hmacChannel(code, prefix, secret)
		if err != nil {
			log.Printf("galaxy 支付渠道 %s 构造失败，该渠道未启用：%v", code, err)
			continue
		}
		channels = append(channels, channel)
	}

	for _, code := range splitCodes(httpx.Property("galaxy.payment.sandbox_channels")) {
		channels = append(channels, payments.Channel{
			Code:    code,
			Title:   defaultProperty("galaxy.payment."+code+".title", code),
			Sandbox: true,
		})
		// 说重一点：这是一条「点一下就发额度」的路，日志里必须留痕，
		// 否则它跟着配置文件被复制到生产环境时没人会发现。
		log.Printf("galaxy 已启用沙箱支付渠道 %s —— 本人点击即视为到账，切勿用于生产", code)
	}

	registry, err := payments.NewRegistry(channels)
	if err != nil {
		log.Printf("galaxy 支付渠道表构造失败，支付相关接口未启用：%v", err)
		return nil
	}
	if registry == nil {
		log.Print("galaxy 未配置任何支付渠道，回调接口未启用（galaxy.payment.*）")
		return nil
	}
	return registry
}

// hmacChannel 组一个 HMAC 验签渠道。签名头、时间戳头与容差都可以按渠道覆盖，
// 没覆盖就落到 galaxy.payment.* 这一层的默认值上。
func hmacChannel(code, prefix, secret string) (payments.Channel, error) {
	verifier, err := payments.NewHMACVerifier(payments.HMACConfig{
		Channel:         code,
		Secret:          secret,
		SignatureHeader: defaultProperty(prefix+".signature_header", httpx.Property("galaxy.payment.signature_header")),
		TimestampHeader: defaultProperty(prefix+".timestamp_header", httpx.Property("galaxy.payment.timestamp_header")),
		Tolerance: time.Duration(intProperty(prefix+".tolerance_seconds",
			intProperty("galaxy.payment.tolerance_seconds", 300))) * time.Second,
	})
	if err != nil {
		return payments.Channel{}, err
	}
	return payments.Channel{
		Code:     code,
		Title:    defaultProperty(prefix+".title", code),
		Verifier: verifier,
	}, nil
}

// splitCodes 逗号分隔的渠道码列表，顺手去重、去空白、统一小写 ——
// 渠道码要进回调路径和支付流水号，不能带着大小写差异到处跑。
func splitCodes(raw string) []string {
	seen := map[string]bool{}
	var codes []string
	for _, part := range strings.Split(raw, ",") {
		code := strings.ToLower(strings.TrimSpace(part))
		if code == "" || seen[code] {
			continue
		}
		seen[code] = true
		codes = append(codes, code)
	}
	return codes
}

func defaultProperty(key, fallback string) string {
	if value := strings.TrimSpace(httpx.Property(key)); value != "" {
		return value
	}
	return fallback
}

func tokenTTL() time.Duration {
	seconds, _ := strconv.Atoi(httpx.Property("auth.token_ttl_seconds"))
	if seconds <= 0 {
		seconds = 604800
	}
	return time.Duration(seconds) * time.Second
}

func intProperty(key string, fallback int) int {
	value, err := strconv.Atoi(strings.TrimSpace(httpx.Property(key)))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func durationProperty(key string, fallbackMillis int) time.Duration {
	return time.Duration(intProperty(key, fallbackMillis)) * time.Millisecond
}

func defaultString(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

var _ = contract.GalaxyBizLine
