package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"app-api/pkg/local"
	"app-api/pkg/push"
	"app-api/pkg/redisqueue"
	"app-api/routers"

	"common/middleware/httpx"
	"common/objectstore"
	"service/bizline"
	"service/business"
	"service/businessassistant"
	"service/delivery"
	deliverydto "service/delivery/dto"
	"service/identity"
)

func main() {
	database := httpx.Boot("app-api")
	storage, signedURLTTL, err := newObjectStorage()
	if err != nil {
		log.Fatal(err)
	}
	queue := redisqueue.New(httpx.Property("redis.addr"), httpx.Property("redis.password"), httpx.Property("redis.mode"))
	if queue == nil {
		log.Print("app-api redis notification queue is disabled; workers will use database fallback polling")
	} else {
		defer func() { _ = queue.Close() }()
	}
	deliveryService := delivery.NewWithCommandNotifier(database, storage, queue)
	tokenTTL, _ := strconv.Atoi(httpx.Property("auth.token_ttl_seconds"))
	identityService := identity.New(database, deliveryService, httpx.Property("auth.token_secret"), time.Duration(tokenTTL)*time.Second)
	// 业务访谈的传输方式和控制台同一套配置：手机端提的诉求和 PC 端提的落在同一
	// 张表上，装配不一致会让同一条诉求在两个入口得到两种行为。
	businessTimeoutSeconds, _ := strconv.Atoi(httpx.Property("business.kodes.timeout_seconds"))
	businessAssistant := businessassistant.New(businessassistant.Config{
		Transport:       httpx.Property("business.kodes.transport"),
		RemoteURL:       httpx.Property("business.kodes.remote_url"),
		WorkerUserID:    httpx.Property("business.kodes.worker_user_id"),
		Model:           httpx.Property("business.kodes.model"),
		ReasoningEffort: httpx.Property("business.kodes.reasoning_effort"),
		Timeout:         time.Duration(businessTimeoutSeconds) * time.Second,
	}, deliveryService)
	businessService := business.New(database, local.BusinessProgramReader{Service: deliveryService}, businessAssistant)
	pushService := push.New(database, push.Config{
		VAPIDPublicKey: httpx.Property("push.vapid_public_key"), VAPIDPrivateKey: httpx.Property("push.vapid_private_key"), VAPIDSubject: httpx.Property("push.vapid_subject"),
	})
	if !pushService.Enabled() {
		log.Print("app-api Web Push is disabled; configure push.vapid_* to enable background notifications")
	}
	// 空间注册表让移动端登录后直接选空间，而不是手输业务线编码。
	bizLineService := bizline.New(database, deliveryService)
	routers.ConfigureAuthenticator(identityService)
	go reconcileLoop(deliveryService, pushService)
	go purgeLoop(deliveryService)
	address := strings.TrimSpace(os.Getenv("APP_API_ADDR"))
	if address == "" {
		address = strings.TrimSpace(httpx.Property("server.address"))
	}
	if address == "" {
		address = ":10002"
	}
	log.Printf("app-api listening on %s", address)
	if err := http.ListenAndServe(address, routers.New(deliveryService, identityService, businessService, storage, signedURLTTL, pushService, queue, bizLineService)); err != nil {
		log.Fatal(err)
	}
}

func reconcileLoop(commandService delivery.CommandService, notifier interface {
	NotifyCommandTerminal(context.Context, deliverydto.CommandView)
}) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		views, err := commandService.ReconcileExpiredCommands(context.Background())
		if err != nil {
			log.Printf("app-api reconcile expired commands: %v", err)
			continue
		}
		for _, view := range views {
			notifier.NotifyCommandTerminal(context.Background(), view)
		}
	}
}

// purgeLoop 把命令表当执行痕迹维护，而不是当日志表堆着：会话页每几秒就落一条快照
// 命令，不清理的话表和事件行会无上限地涨。每轮只删一批，慢慢追平即可。
func purgeLoop(commandService delivery.CommandService) {
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		if _, err := commandService.PurgeFinishedCommands(context.Background()); err != nil {
			log.Printf("app-api purge finished commands: %v", err)
		}
	}
}

func newObjectStorage() (*objectstore.AliyunOSS, time.Duration, error) {
	config, err := objectstore.LoadAliyunOSSDeployment(httpx.Property)
	if err != nil {
		return nil, 0, err
	}
	storage, err := config.NewClient()
	if err != nil {
		return nil, 0, err
	}
	if !config.Enabled {
		log.Print("app-api OSS is disabled")
	}
	return storage, config.SignedURLTTL, nil
}
