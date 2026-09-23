package auth_test

import (
	"github.com/gin-gonic/gin"

	"common/middleware/httpx"
)

// httpxCallerID 只是把 httpx 的读取函数搬过来用，避免测试里直接摸 context key。
func httpxCallerID(context *gin.Context) string { return httpx.CallerID(context) }
