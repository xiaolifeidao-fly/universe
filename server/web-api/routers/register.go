package routers

import (
	"context"
	"log"
	"strconv"
	"time"

	"common/middleware/httpx"
	commonrouters "common/middleware/routers"
	"common/objectstore"

	deliveryapi "delivery-api/pkg/delivery"
	"service/bizline"
	"service/business"
	"service/delivery"
	"service/identity"
	"web-api/pkg/local"
	"web-api/pkg/remote"

	"gorm.io/gorm"
)

func registerHandlers(database *gorm.DB) []commonrouters.Handler {
	return buildHandlers(context.Background(), database)
}

// buildHandlers 是聚合进程唯一的装配点：new 出各层 service（本地实现互相直连），
// 再把各层的聚合 handler 注册到 /api。
//
// 目前只有交付推进层（第 0 层 bizline 还没有 HTTP 入口）。6 层业务的装配
// —— resource / task / risk / strategy / aisched / orchestration ——
// 随各层落地逐个加回来，形状照 delivery 这一段抄。
func buildHandlers(_ context.Context, database *gorm.DB) []commonrouters.Handler {
	var cloudStorage delivery.CloudObjectStorage
	if endpoint := httpx.Property("oss.endpoint"); endpoint != "" {
		storage, err := objectstore.NewAliyunOSS(objectstore.OSSConfig{
			Endpoint:        endpoint,
			Bucket:          httpx.Property("oss.bucket"),
			AccessKeyID:     httpx.Property("oss.access_key_id"),
			AccessKeySecret: httpx.Property("oss.access_key_secret"),
			Prefix:          httpx.Property("oss.prefix"),
			PathStyle:       httpx.Property("oss.path_style") == "true",
		})
		if err != nil {
			log.Printf("delivery cloud sync OSS is unavailable: %v", err)
		} else {
			cloudStorage = storage
		}
	}
	deliveryService := delivery.New(database, cloudStorage)
	bizLineService := bizline.New(database, deliveryService)
	businessTimeoutSeconds, _ := strconv.Atoi(httpx.Property("business.kodes.timeout_seconds"))
	businessAssistant := remote.NewBusinessAssistant(
		httpx.Property("business.kodes.remote_url"),
		httpx.Property("business.kodes.token"),
		httpx.Property("business.kodes.workspace"),
		httpx.Property("business.kodes.model"),
		httpx.Property("business.kodes.reasoning_effort"),
		time.Duration(businessTimeoutSeconds)*time.Second,
	)
	businessService := business.New(database, local.BusinessProgramReader{Service: deliveryService}, businessAssistant)
	tokenTTL, _ := strconv.Atoi(httpx.Property("auth.token_ttl_seconds"))
	identityService := identity.New(database, deliveryService, httpx.Property("auth.token_secret"), time.Duration(tokenTTL)*time.Second)
	httpx.SetUserAuthenticator(identityService)

	return []commonrouters.Handler{
		deliveryapi.NewHandler(deliveryService, bizLineService, identityService, businessService),
	}
}
