package auth

import (
	"github.com/gin-gonic/gin"

	shared "galaxy-common/auth"
	"service/galaxy/account"
	"service/galaxy/dto"
)

type Handler struct{ handler *shared.Handler }

func NewHandler(accounts account.Service, gate *shared.Gate) *Handler {
	return &Handler{handler: shared.NewHandler(accounts, gate)}
}
func (h *Handler) RegisterHandler(group *gin.RouterGroup) {
	h.handler.RegisterSide(group, dto.SideConsumer)
}
