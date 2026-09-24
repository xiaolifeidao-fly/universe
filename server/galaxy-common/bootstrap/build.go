package bootstrap

import (
	"fmt"
	"log"
	"strings"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"common/middleware/httpx"
	"common/objectstore"
	"galaxy-common/auth"
	"galaxy-common/kinds"
	"galaxy-common/local"
	"galaxy-common/metrics"
	"service/galaxy"
	"service/galaxy/account"
	"service/galaxy/redisctl"
)

type Assembly struct {
	Galaxy  galaxy.Service
	Metrics *metrics.Registry
	Control *redisctl.ControlPlane
	// DesktopFeedBase 桌面壳去哪儿取更新清单：OSS 上那个公开读目录的前缀，
	// 从 oss.* 推出来（<publicHost>/<dirPrefix>），两个端共用，端那一段由界面补。
	// 没装对象存储就是空串 —— 那个部署不检查更新，不是故障。
	DesktopFeedBase string
}

func Build(database *gorm.DB, registry *galaxy.KindRegistry, replayer galaxy.ShadowReplayer) (*Assembly, error) {
	if registry == nil {
		var err error
		registry, err = DefaultKinds()
		if err != nil {
			return nil, err
		}
	}
	control := redisctl.New(redisctl.Options{
		Addresses: httpx.Property("redis.addr"), Password: httpx.Property("redis.password"),
		Mode: httpx.Property("redis.mode"), Namespace: httpx.Property("galaxy.redis_namespace"),
		PoolSize: IntProperty("galaxy.redis_pool_size", 0),
	})
	if control == nil {
		return nil, fmt.Errorf("Galaxy 需要 redis.addr：控制面缺席就无法保证座位与额度的原子性")
	}
	var signer galaxy.ObjectSigner
	var desktopFeedBase string
	if config, err := objectstore.LoadAliyunOSSDeployment(httpx.Property); err != nil {
		log.Printf("galaxy OSS 配置不可用: %v", err)
	} else {
		// 桌面壳的更新目录前缀从同一份 oss.* 推出来，不另设一份配置：发版页往
		// <dirPrefix>/<端>/ 写清单，客户端就得去同一个地方取。让界面那一侧再配一遍
		// 等于养第二份真相，而抄错了没人会发现 —— 客户端只是安静地不更新。
		//
		// 它排在建客户端**之前**，而且不看客户端建没建起来：公开读地址不签名，
		// 没有 oss.accessKey* 的部署照样该把更新地址报给壳。
		if base, err := config.PublicPrefixURL(); err != nil {
			log.Printf("galaxy 桌面更新目录地址不可用: %v", err)
		} else {
			desktopFeedBase = base
		}
		if storage, err := config.NewClient(); err != nil {
			log.Printf("galaxy OSS 客户端不可用: %v", err)
		} else if storage != nil {
			signer = local.ObjectSigner{Storage: storage}
		}
	}
	metrics := metrics.New()
	service := galaxy.New(database, galaxy.Ports{Control: control, Signer: signer, Replayer: replayer,
		Audit: LoadAuditConfig(), Metrics: metrics}, registry, LoadConfig())
	return &Assembly{Galaxy: service, Metrics: metrics, Control: control, DesktopFeedBase: desktopFeedBase}, nil
}

// Accounts 装配账号服务。keys 是使用端「注册即送一把密钥」的签发方，传 Assembly.Galaxy；
// 传 nil 就只建账号不送密钥。
//
// control 是连续登录失败那道闸的计数面，传 Assembly.Control。参数类型写成具体的
// *ControlPlane 而不是 account.LoginGuard，是为了躲开「装着 nil 指针的非 nil 接口」——
// 那种值会让 account 里每一处 `guard == nil` 的判断都落空，闸看起来装上了，
// 一调就是空指针。
func Accounts(database *gorm.DB, keys account.KeyIssuer, control *redisctl.ControlPlane) (account.Service, *auth.Gate) {
	var registrationGift account.RegistrationGiftIssuer
	if issuer, ok := keys.(account.RegistrationGiftIssuer); ok {
		registrationGift = issuer
	}
	options := account.Options{
		TokenSecret: TokenSecret(), TokenTTL: TokenTTL(), Keys: keys, RegistrationGift: registrationGift,
		MaxLoginFail:      signedProperty("galaxy.max_login_fail"),
		MaxLoginFailPerIP: signedProperty("galaxy.max_login_fail_per_ip"),
		LoginFailWindow:   DurationProperty("galaxy.login_fail_window_ms", 0),
	}
	if control != nil {
		options.Guard = control
	}
	accounts := account.New(database, options)
	return accounts, auth.NewGate(accounts)
}

// DefaultKinds 只装配能力契约，控制台不加载 Hub 的传输适配器。
func DefaultKinds() (*galaxy.KindRegistry, error) {
	registry := galaxy.NewKindRegistry()
	enabled := map[string]bool{}
	for _, name := range strings.Split(DefaultString(httpx.Property("galaxy.adapters"), "relay"), ",") {
		enabled[strings.TrimSpace(name)] = true
	}
	count := 0
	if enabled["relay"] {
		if err := registry.Register(kinds.Relay(map[string]string{"anthropic": "claude_oauth", "openai": "codex_chatgpt"}, int64(IntProperty("galaxy.body_limit_bytes", 4<<20)))); err != nil {
			return nil, err
		}
		count++
	}
	if enabled["delivery"] {
		if err := registry.Register(kinds.Delivery([]string{"delivery-task-planner"})); err != nil {
			return nil, err
		}
		count++
	}
	if enabled["videofarm"] {
		if err := registry.Register(kinds.VideoFarm([]string{"ffmpeg-local"}, 20, 50)); err != nil {
			return nil, err
		}
		count++
	}
	if count == 0 {
		return nil, fmt.Errorf("galaxy.adapters 没有启用任何适配器")
	}
	return registry, nil
}

// Engine 装配三个服务共用的那层：日志、恢复、指标、存活与就绪。
//
// healthz 与 readyz 是两件事，别合并：
//   - healthz 是**存活**，进程还在就 200。它翻成失败等于让编排重启这个进程，
//     而优雅退出期间进程恰恰是健康的 —— 它正在把在途请求送完。
//   - readyz 是**就绪**，一宣布退出就 503，为的是让上游把这台摘出轮转。
//
// K8s 直接把两者接到 liveness / readiness 探针上。开源 nginx 没有主动健康检查，
// 那边靠 drain 脚本把这台标 down 再 reload，readyz 用来确认它确实开始退出了。
func Engine(metrics *metrics.Registry, drain *Drain) *gin.Engine {
	engine := gin.New()
	engine.Use(gin.Logger(), gin.Recovery())
	_ = engine.SetTrustedProxies(nil)
	engine.GET("/metrics", metrics.Handler())
	engine.GET("/healthz", func(c *gin.Context) {
		c.JSON(200, gin.H{"success": true, "code": 0, "data": "ok", "message": "ok", "error": nil})
	})
	engine.GET("/readyz", func(c *gin.Context) {
		if drain.Active() {
			c.JSON(503, gin.H{"success": false, "code": 503, "data": "draining",
				"message": "正在优雅退出，请把这台摘出轮转", "error": nil})
			return
		}
		c.JSON(200, gin.H{"success": true, "code": 0, "data": "ok", "message": "ok", "error": nil})
	})
	return engine
}
