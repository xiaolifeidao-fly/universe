package main

import (
	"context"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"service/bizline"
	"service/delivery"
	galaxysvc "service/galaxy"
	galaxyaccount "service/galaxy/account"
	"service/galaxy/redisctl"
	"service/identity"
	"service/manager"

	"common/middleware/httpx"
	"common/objectstore"
	"manager-api/pkg/tokenstore"
	"manager-api/routers"
)

func main() {
	gin.SetMode(gin.ReleaseMode)
	database := httpx.Boot("manager-api")

	// 令牌在 Redis 里，所以 Redis 是管理端的**启动硬依赖**。
	// 连不上就直接退出，不要起一个每个登录请求各失败一次的进程。
	tokens := tokenstore.New(tokenstore.Options{
		Addresses: httpx.Property("redis.addr"),
		Password:  httpx.Property("redis.password"),
		Mode:      httpx.Property("redis.mode"),
		Namespace: httpx.Property("manager.redis_namespace"),
	})
	if tokens == nil {
		log.Fatal("manager-api 需要 Redis：请在 configs/application.properties 里配置 redis.addr")
	}
	defer func() { _ = tokens.Close() }()
	pingCtx, cancelPing := context.WithTimeout(context.Background(), 5*time.Second)
	if err := tokens.Ping(pingCtx); err != nil {
		cancelPing()
		log.Fatalf("连接 Redis 失败: %v", err)
	}
	cancelPing()

	tokenTTL, _ := strconv.Atoi(httpx.Property("auth.token_ttl_seconds"))
	managerService, err := manager.New(database, manager.Ports{Tokens: tokens}, manager.Config{
		TokenTTL: time.Duration(tokenTTL) * time.Second,
	})
	if err != nil {
		log.Fatal(err)
	}

	// cloudStorage=nil: manager-api 的项目管理不涉及云端文件同步（那是本机桥接
	// 和 web 控制台的事），delivery.Service 对 nil CloudObjectStorage 的相关方法
	// 容错（未配置就报「不可用」，不会 panic），用不到那部分能力的调用方不受影响。
	deliveryService := delivery.New(database, nil)
	bizLineService := bizline.New(database, deliveryService)
	// identityService 只用来给 /api/users 这些页面读写**业务用户**，
	// 不再参与管理端自己的登录。这里刻意不调 httpx.SetUserAuthenticator ——
	// 挂上它，web 控制台的业务令牌就又能进管理端接口了。
	identityService := identity.New(database, deliveryService, httpx.Property("auth.token_secret"),
		time.Duration(tokenTTL)*time.Second)

	// 共享算力池的运营接口直接复用 service/galaxy，不经过 galaxy-api ——
	// 管理端令牌和 galaxy-api 认的 Galaxy 账号令牌是两套，浏览器直连过去每一个请求
	// 都会被判成 not login，前端拦截器随即清 token 跳登录页。
	// 账在同一个 MySQL、控制面在同一个 Redis，manager-api 两样都连得到。
	galaxyService, closeGalaxy := buildGalaxyService(database)
	defer closeGalaxy()
	// Galaxy 账号（共享端、使用端两批人）只要数据库。管理端不签发、不校验它们的令牌，
	// 所以不给签名密钥 —— 那把密钥只该在 galaxy-api 上。
	galaxyAccounts := galaxyaccount.New(database, galaxyaccount.Options{})

	engine, err := routers.New(managerService, identityService, bizLineService, deliveryService, galaxyService, galaxyAccounts)
	if err != nil {
		log.Fatal(err)
	}
	checkCtx, cancelCheck := context.WithTimeout(context.Background(), 10*time.Second)
	routers.ReportUnregisteredRoutes(checkCtx, engine, managerService)
	cancelCheck()

	log.Printf("manager-api listening on %s", listenAddress())
	if err := engine.Run(listenAddress()); err != nil {
		log.Fatal(err)
	}
}

// buildGalaxyService 装配共享池领域服务的**只读运营**那一面。
//
// 和 galaxy-api 的装配比，这里少了三个端口，都是故意的：
//
//	Signer    产物直传的签名。运营接口不碰产物字节。
//	Replayer  抽检重放。抽检由 galaxy-api 的巡检跑，管理端只看结果。
//	Payment   支付回调验签。回调打的是 galaxy-api，不会打到管理端。
//
// 控制面（Redis）不能省：池水位要读贡献快照，封禁要把机器从候选里摘掉。
// 连接池给小值 —— 那个 600 的默认值是给 galaxy-api 的 BLPOP 长轮询准备的，
// 管理端只做零星的读，照抄过来等于白占几百条连接。
//
// 返回 nil 表示没配 Redis：路由照样注册（资源表按路由表生成），调到依赖池子的接口时报「未启用」。
func buildGalaxyService(database *gorm.DB) (galaxysvc.Service, func()) {
	control := redisctl.New(redisctl.Options{
		Addresses: httpx.Property("redis.addr"),
		Password:  httpx.Property("redis.password"),
		Mode:      httpx.Property("redis.mode"),
		// 命名空间必须和 galaxy-api 一致，否则读到的是一个空控制面。
		Namespace: defaultString(httpx.Property("galaxy.redis_namespace"), "galaxy"),
		PoolSize:  16,
	})
	if control == nil {
		log.Print("manager-api 未配置 Redis 控制面，共享算力池运营接口未启用（redis.addr）")
		return nil, func() {}
	}
	config := galaxysvc.DefaultConfig()
	// 心跳超时决定「在线 / 离线」怎么判。跟着同一个配置项走，
	// 免得同一台机器在管理端显示离线、在 galaxy 控制台显示在线。
	if raw, err := strconv.Atoi(httpx.Property("galaxy.heartbeat_timeout_ms")); err == nil && raw > 0 {
		config.HeartbeatTimeout = time.Duration(raw) * time.Millisecond
	}
	// 信誉回升速率同理：管理端列表上的信誉是现算的，速率对不上，
	// 这里显示的分数就和 galaxy-api 派单时用的那份不一样。
	if raw, err := strconv.ParseFloat(strings.TrimSpace(httpx.Property("galaxy.reputation_recovery_per_day")), 64); err == nil && raw > 0 {
		config.ReputationRecoveryPerDay = raw
	}
	// 取回密钥明文要和签发它的 galaxy-api 用同一把加密密钥；地址是运营转交密钥时一起给对方的那个 base_url。
	// 两项都没配时对应的功能明说「取不回」「没有地址」，不影响别的运营页面。
	config.KeyCipherSecret = strings.TrimSpace(httpx.Property("galaxy.key_cipher_secret"))
	if config.KeyCipherSecret == "" {
		log.Print("manager-api 未配置 galaxy.key_cipher_secret：管理端取不回算力密钥明文")
	}
	config.ConsumerBaseURL = strings.TrimSpace(httpx.Property("galaxy.consumer_base_url"))
	// ai-bridge 的发布公钥。上传安装包时服务端按它验一遍签名，验不过不收 ——
	// 没签名的包发下去，每台机器都会在升级的最后一步拒装，而运营要到那时候才知道。
	config.BridgeReleaseKeys = splitList(httpx.Property("galaxy.bridge_release.public_keys"))

	ports := galaxysvc.Ports{Control: control}
	// 上传安装包是**唯一**要服务端经手字节的地方，也是唯一在管理端装配对象存储的理由：
	// sha256 与发布签名的校验只有经手字节的一方做得了。产物仍然走 presigned 直传。
	// 没配 OSS 不影响别的运营页面，只是传不了包（接口会明说）。
	if deployment, err := objectstore.LoadAliyunOSSDeployment(httpx.Property); err != nil {
		log.Printf("manager-api OSS 配置不可用，ai-bridge 安装包上传不可用：%v", err)
	} else if storage, err := deployment.NewClient(); err != nil {
		log.Printf("manager-api OSS 客户端不可用，ai-bridge 安装包上传不可用：%v", err)
	} else if storage != nil {
		ports.Uploader = storage
	}
	service := galaxysvc.New(database, ports, nil, config)
	return service, func() { _ = control.Close() }
}

// splitList 逗号分隔的配置值。空白项去掉 —— 配置里换行对齐时很容易多出一个空串，
// 而一把空的公钥会让验签在循环里白跑一轮。
func splitList(raw string) []string {
	var values []string
	for _, part := range strings.Split(raw, ",") {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			values = append(values, trimmed)
		}
	}
	return values
}

func defaultString(value, fallback string) string {
	if trimmed := strings.TrimSpace(value); trimmed != "" {
		return trimmed
	}
	return fallback
}

// listenAddress 监听地址：环境变量 > 配置 server.address > :10003。
//
// 环境变量优先是给 start.sh 用的（和 web-api / app-api 同一个理由）：脚本按同样的
// 顺序算出端口再去探 /healthz，少了这一层，`MANAGER_API_ADDR=:9000 ./start.sh`
// 会变成「进程起在 10003、脚本在 9000 上等就绪」，报一个和真实情况无关的启动失败。
func listenAddress() string {
	if address := os.Getenv("MANAGER_API_ADDR"); address != "" {
		return address
	}
	if address := httpx.Property("server.address"); address != "" {
		return address
	}
	return ":10003"
}
