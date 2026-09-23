package routers

import (
	"time"

	"app-api/pkg/commands"
	"app-api/pkg/documents"
	"app-api/pkg/management"
	"app-api/pkg/push"

	"common/middleware/httpx"
	"common/objectstore"
	"service/business"
	"service/delivery"
	"service/identity"

	"github.com/gin-gonic/gin"
)

func New(
	deliveryService delivery.Service,
	identityService identity.Service,
	businessService business.Service,
	objects *objectstore.AliyunOSS,
	signedURLTTL time.Duration,
	pushService *push.Service,
	waiter commands.CommandNotificationWaiter,
	spaces management.SpaceDirectory,
) *gin.Engine {
	router := gin.New()
	router.Use(gin.Logger(), gin.Recovery())
	// An independently hosted PWA needs an explicit origin allowlist. Same-origin
	// reverse-proxy deployments leave this empty and do not emit CORS headers.
	router.Use(cors(httpx.Property("app.cors_origins")))
	router.OPTIONS("/*path", func(context *gin.Context) { context.Status(204) })
	router.GET("/healthz", func(context *gin.Context) { context.String(200, "ok") })
	api := router.Group("/api")
	management.NewHandler(deliveryService, identityService, businessService, spaces).Register(api)
	commands.NewHandler(deliveryService, waiter, pushService).Register(api)
	documents.NewHandler(deliveryService, objects, signedURLTTL).Register(api)
	push.NewHandler(pushService).Register(api)
	return router
}

// ConfigureAuthenticator is kept at the application boundary so command routes
// use the same signed user token and scope semantics as the existing console.
func ConfigureAuthenticator(authenticator httpx.UserAuthenticator) {
	httpx.SetUserAuthenticator(authenticator)
}
