package dto

import "time"

type BizLineView struct {
	Code        string `json:"code"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Enabled     bool   `json:"enabled"`
	// Visible 为否时这条业务线只对本空间管理员可见，成员也看不到。
	Visible bool `json:"visible"`

	// CanManage / CanWrite 是「当前调用者对这条业务线的权限」，由 API 层按调用者身份填充。
	// 前端据此决定按钮的显隐 —— 权限判定只有服务端说了算，
	// 浏览器里缓存的那份授权范围随时会过时。
	CanManage bool `json:"canManage"`
	CanWrite  bool `json:"canWrite"`
}

type Capability struct {
	Key             string `json:"key"`
	MinAgentVersion string `json:"minAgentVersion"`
	Enabled         bool   `json:"enabled"`
}

type RegisterRequest struct {
	Code string `json:"code"`
	Name string `json:"name"`
}

// ---------- 分享链接 ----------

const (
	PermissionRead  = "read"
	PermissionWrite = "write"
	// DefaultShareTTLMinutes 是分享链接的默认有效期：签发后 1 小时。
	DefaultShareTTLMinutes = 60
	// MaxShareTTLMinutes 给有效期封顶，避免出现事实上的长期公开入口。
	MaxShareTTLMinutes = 7 * 24 * 60
)

// MaxOwnedBizLines 是单个用户名下启用空间的上限。
// 只算启用项：删除或停用不用的空间就能腾出名额继续建。
const MaxOwnedBizLines = 30

type CreateShareLinkRequest struct {
	BizLine    string `json:"bizLine"`
	Permission string `json:"permission"`
	// TTLMinutes 留空即取 DefaultShareTTLMinutes。
	TTLMinutes int    `json:"ttlMinutes"`
	CreatedBy  string `json:"-"`
}

type ShareLinkView struct {
	Token      string    `json:"token"`
	BizLine    string    `json:"bizLine"`
	Permission string    `json:"permission"`
	ExpiresAt  time.Time `json:"expiresAt"`
}

// ShareLinkTarget 是受邀人点开链接后看到的内容：空间描述加上这条链接给的权限。
type ShareLinkTarget struct {
	BizLine     string    `json:"bizLine"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Permission  string    `json:"permission"`
	ExpiresAt   time.Time `json:"expiresAt"`
}

// SaveBizLineRequest 创建或更新一条业务线。编码是其他业务表使用的归属键，
// 控制台编辑时会保持不可变；这里保留 upsert 语义以覆盖创建和状态、名称更新。
type SaveBizLineRequest struct {
	Code        string `json:"code"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Enabled     bool   `json:"enabled"`
	Visible     bool   `json:"visible"`
}

type DeleteBizLineRequest struct {
	Code string `json:"code"`
}

type SaveCapabilityRequest struct {
	BizLine         string `json:"bizLine"`
	Key             string `json:"key"`
	MinAgentVersion string `json:"minAgentVersion"`
	Enabled         bool   `json:"enabled"`
}
