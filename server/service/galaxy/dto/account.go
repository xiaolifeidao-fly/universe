package dto

import "time"

// Galaxy 账号的两端。共享端出算力（Nova），使用端花钱买额度（Orbit）。
// 两端是两批人：各注册各的，令牌互不通用。
const (
	SideProvider = "provider"
	SideConsumer = "consumer"
)

const (
	AccountActive   = "active"
	AccountDisabled = "disabled"
)

// RegisterAccountRequest 自助注册。端由路由决定，请求体里报的不算数。
//
// 这几个自助请求都不写 binding:"required"：绑定器的报错是给程序员看的英文，
// 必填项由 service 用人话校验，登录页上直接能显示。
type RegisterAccountRequest struct {
	Side        string `json:"-"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	Password    string `json:"password"`
}

// LoginAccountRequest 端同样由路由决定：同一个用户名在两端可以是两个人。
type LoginAccountRequest struct {
	Side     string `json:"-"`
	Username string `json:"username"`
	Password string `json:"password"`
}

type ChangeAccountPasswordRequest struct {
	CurrentPassword string `json:"currentPassword"`
	NewPassword     string `json:"newPassword"`
}

// AccountView 账号的对外形状。ID 是业务键（pu_… / cu_…），就是池内表里 owner_user_id 存的那个值。
type AccountView struct {
	ID                 string `json:"id"`
	Side               string `json:"side"`
	Username           string `json:"username"`
	DisplayName        string `json:"displayName"`
	Status             string `json:"status"`
	MustChangePassword bool   `json:"mustChangePassword"`
	// ProviderType 只有共享端有：individual=散户，studio=工作室。使用端没有这个字段。
	ProviderType string     `json:"providerType,omitempty"`
	LastLoginAt  *time.Time `json:"lastLoginAt,omitempty"`
	CreatedAt    time.Time  `json:"createdAt"`
}

// AccountLoginResult 登录、注册、改密码都回这个：改密码会让旧令牌作废，所以同时发一张新的。
type AccountLoginResult struct {
	Token string      `json:"token"`
	User  AccountView `json:"user"`
}

// ---------- 运营 ----------

// AccountQuery 管理端的账号列表。Side 必填：两端是两批人，混在一张表里翻没有意义。
type AccountQuery struct {
	Side    string `form:"side"`
	Keyword string `form:"keyword"`
	Status  string `form:"status"`
	// ProviderType 只对共享端生效。
	ProviderType string `form:"providerType"`
	Offset       int    `form:"offset"`
	Limit        int    `form:"limit"`
}

type AccountPage struct {
	List  []AccountView `json:"list"`
	Total int64         `json:"total"`
}

// SetAccountStatusRequest 停用或启用。停用当场生效：已经发出去的令牌一起作废。
type SetAccountStatusRequest struct {
	UserID string `json:"userId" binding:"required"`
	Status string `json:"status" binding:"required"`
	// UpdatedBy 由接口层从凭证里取。
	UpdatedBy string `json:"-"`
}

// ResetAccountPasswordRequest 运营替忘了密码的人重置。重置后本人下次登录要先改掉它 ——
// 运营知道这串密码，它不该一直有效。
type ResetAccountPasswordRequest struct {
	UserID    string `json:"userId" binding:"required"`
	Password  string `json:"password" binding:"required"`
	UpdatedBy string `json:"-"`
}
