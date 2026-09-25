package dto

// 埋点只回答两个产品问题，事件键由服务端入口固定，不接受浏览器任意填写。
const (
	TrackingEventPortalOpen       = "portal.open"
	TrackingEventModelSquareClick = "model_square.model_click"
)

// DashboardTracking 管理端仪表盘上所选日期的埋点统计。
type DashboardTracking struct {
	Date              string `json:"date"`
	PortalOpens       int64  `json:"portalOpens"`
	ModelSquareClicks int64  `json:"modelSquareClicks"`
}
