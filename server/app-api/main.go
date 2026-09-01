package main

import (
	"context"
	"fmt"
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
	"service/delivery"
	deliverydto "service/delivery/dto"
	"service/identity"
)

func main() {
	database := httpx.Boot("app-api")
	storage, err := newObjectStorage()
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
	// Remote business-assistant wiring remains the deployment concern of the
	// bridge. The app API still delegates intake reads and creation to business.
	businessService := business.New(database, local.BusinessProgramReader{Service: deliveryService}, nil)
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
	address := strings.TrimSpace(os.Getenv("APP_API_ADDR"))
	if address == "" {
		address = strings.TrimSpace(httpx.Property("server.address"))
	}
	if address == "" {
		address = ":10002"
	}
	log.Printf("app-api listening on %s", address)
	if err := http.ListenAndServe(address, routers.New(deliveryService, identityService, businessService, storage, pushService, queue, bizLineService)); err != nil {
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

func newObjectStorage() (*objectstore.AliyunOSS, error) {
	endpoint := strings.TrimSpace(httpx.Property("oss.endpoint"))
	bucket := strings.TrimSpace(httpx.Property("oss.bucket"))
	accessKeyID := strings.TrimSpace(httpx.Property("oss.access_key_id"))
	accessKeySecret := strings.TrimSpace(httpx.Property("oss.access_key_secret"))
	if endpoint == "" && bucket == "" && accessKeyID == "" && accessKeySecret == "" {
		return nil, nil
	}
	pathStyle, err := strconv.ParseBool(strings.TrimSpace(httpx.Property("oss.path_style")))
	if strings.TrimSpace(httpx.Property("oss.path_style")) == "" {
		pathStyle = false
		err = nil
	}
	if err != nil {
		return nil, fmt.Errorf("oss.path_style 必须为 true 或 false: %w", err)
	}
	storage, err := objectstore.NewAliyunOSS(objectstore.OSSConfig{
		Endpoint: endpoint, Bucket: bucket, AccessKeyID: accessKeyID, AccessKeySecret: accessKeySecret,
		Prefix: httpx.Property("oss.prefix"), PathStyle: pathStyle,
	})
	if err != nil {
		return nil, fmt.Errorf("初始化 OSS 云存储失败: %w", err)
	}
	return storage, nil
}
