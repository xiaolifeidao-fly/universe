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
	if config, err := objectstore.LoadAliyunOSSDeployment(httpx.Property); err != nil {
		log.Printf("galaxy OSS 配置不可用: %v", err)
	} else if storage, err := config.NewClient(); err != nil {
		log.Printf("galaxy OSS 客户端不可用: %v", err)
	} else if storage != nil {
		signer = local.ObjectSigner{Storage: storage}
	}
	metrics := metrics.New()
	service := galaxy.New(database, galaxy.Ports{Control: control, Signer: signer, Replayer: replayer,
		Audit: LoadAuditConfig(), Metrics: metrics}, registry, LoadConfig())
	return &Assembly{Galaxy: service, Metrics: metrics, Control: control}, nil
}

// Accounts 装配账号服务。keys 是使用端「注册即送一把密钥」的签发方，传 Assembly.Galaxy；
// 传 nil 就只建账号不送密钥。
func Accounts(database *gorm.DB, keys account.KeyIssuer) (account.Service, *auth.Gate) {
	accounts := account.New(database, account.Options{
		TokenSecret: TokenSecret(), TokenTTL: TokenTTL(), Keys: keys,
	})
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
