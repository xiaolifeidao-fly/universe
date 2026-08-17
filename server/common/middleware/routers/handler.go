package routers

import "github.com/gin-gonic/gin"

type Handler interface {
	RegisterHandler(*gin.RouterGroup)
}
