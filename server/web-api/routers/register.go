package routers

import (
	"context"
	"strconv"
	"time"

	"common/middleware/httpx"
	commonrouters "common/middleware/routers"

	deliveryapi "delivery-api/pkg/delivery"
	"service/bizline"
	"service/delivery"
	"service/identity"

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
	deliveryService := delivery.New(database)
	bizLineService := bizline.New(database, deliveryService)
	tokenTTL, _ := strconv.Atoi(httpx.Property("auth.token_ttl_seconds"))
	identityService := identity.New(database, deliveryService, httpx.Property("auth.token_secret"), time.Duration(tokenTTL)*time.Second)
	httpx.SetUserAuthenticator(identityService)

	return []commonrouters.Handler{
		deliveryapi.NewHandler(deliveryService, bizLineService, identityService),
	}
}
