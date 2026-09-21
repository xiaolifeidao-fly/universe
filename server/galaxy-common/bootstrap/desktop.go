package bootstrap

import (
	"github.com/gin-gonic/gin"

	"common/middleware/httpx"
)

// RegisterDesktop 桌面壳要的那一条：更新清单放在 OSS 的哪个目录下。
//
// 两个端各自的后端（Nova → galaxy-api、Orbit → galaxy-consumer-api）都挂这一条，
// 所以放在共用的 bootstrap 里而不是某一端的 handler 包：它回的东西和端无关 ——
// 前缀是两端共用的，端那一段由界面的 /api/desktop-health 补上。
//
// **不鉴权**：壳在用户登录之前就要探这一下，而回的只是一个本来就公开读的目录地址
// （桶上那个前缀谁都能取，不然 electron-updater 也取不到清单）。
//
// 没装对象存储时 base 是空串，照样 200 —— 「这个部署不检查更新」是常态之一，
// 不是故障。回 4xx 会让界面把它当错误画出来，而用户对此无能为力。
func RegisterDesktop(group *gin.RouterGroup, base string) {
	group.GET("/desktop/update-feed", func(context *gin.Context) {
		httpx.JSON(context, gin.H{"updateFeed": base}, nil)
	})
}
