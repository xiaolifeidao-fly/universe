// Package delivery 负责交付推进服务的 HTTP 入口组合。
//
// 实际 API 按资源类型拆在各自的子包中。这样交付服务未来独立部署或继续拆分时，
// API 归属不需要从 web-api 回迁，也不会形成一个不断增长的 Handler。
package delivery

import (
	"common/middleware/routers"

	"delivery-api/pkg/identity"
	"service/bizline"
	deliveryservice "service/delivery"
	identityservice "service/identity"

	"delivery-api/pkg/bizlines"
	"delivery-api/pkg/boards"
	"delivery-api/pkg/items"
	"delivery-api/pkg/programs"
	"delivery-api/pkg/requirements"
	"delivery-api/pkg/snapshots"

	"github.com/gin-gonic/gin"
)

type Handler struct {
	handlers []routers.Handler
}

func NewHandler(deliveryService deliveryservice.Service, bizLineService bizline.Service, identityService identityservice.Service) *Handler {
	return &Handler{handlers: []routers.Handler{
		identity.NewHandler(identityService, bizLineService),
		bizlines.NewHandler(bizLineService, identityService),
		programs.NewHandler(deliveryService, identityService),
		requirements.NewHandler(deliveryService),
		items.NewHandler(deliveryService),
		boards.NewHandler(deliveryService),
		snapshots.NewHandler(deliveryService),
	}}
}

func (h *Handler) RegisterHandler(group *gin.RouterGroup) {
	for _, handler := range h.handlers {
		handler.RegisterHandler(group)
	}
}

var _ routers.Handler = (*Handler)(nil)
