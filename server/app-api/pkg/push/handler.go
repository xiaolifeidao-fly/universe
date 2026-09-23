package push

import (
	"strings"

	"common/middleware/httpx"

	"github.com/gin-gonic/gin"
)

type Handler struct{ service *Service }

func NewHandler(service *Service) *Handler { return &Handler{service: service} }

func (h *Handler) Register(api *gin.RouterGroup) {
	push := api.Group("/push", httpx.RequireUser())
	push.GET("/config", h.config)
	push.PUT("/subscription", h.subscribe)
	push.DELETE("/subscription", h.unsubscribe)
}

func (h *Handler) config(c *gin.Context) {
	httpx.JSON(c, h.service.Config(), nil)
}

func (h *Handler) subscribe(c *gin.Context) {
	var req SubscriptionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, err.Error())
		return
	}
	err := h.service.Subscribe(c.Request.Context(), httpx.CallerID(c), req)
	httpx.JSON(c, gin.H{"subscribed": err == nil}, err)
}

func (h *Handler) unsubscribe(c *gin.Context) {
	var req struct {
		Endpoint string `json:"endpoint"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		httpx.Fail(c, err.Error())
		return
	}
	err := h.service.Unsubscribe(c.Request.Context(), httpx.CallerID(c), strings.TrimSpace(req.Endpoint))
	httpx.JSON(c, gin.H{"subscribed": false}, err)
}
