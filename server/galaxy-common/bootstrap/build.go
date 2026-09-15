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
		Audit: LoadAuditConfig(), Metrics: metrics, Payment: LoadPaymentVerifier()}, registry, LoadConfig())
	return &Assembly{Galaxy: service, Metrics: metrics, Control: control}, nil
}
func Accounts(database *gorm.DB) (account.Service, *auth.Gate) {
	accounts := account.New(database, account.Options{TokenSecret: TokenSecret(), TokenTTL: TokenTTL()})
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
func Engine(metrics *metrics.Registry) *gin.Engine {
	engine := gin.New()
	engine.Use(gin.Logger(), gin.Recovery())
	_ = engine.SetTrustedProxies(nil)
	engine.GET("/metrics", metrics.Handler())
	engine.GET("/healthz", func(c *gin.Context) {
		c.JSON(200, gin.H{"success": true, "code": 0, "data": "ok", "message": "ok", "error": nil})
	})
	return engine
}
