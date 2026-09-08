package manager

import (
	"context"
	"time"
)

// service/manager 的对外依赖全部收在这一个文件里。
// 领域包不认识 Redis、不认识 gin —— 它只认这些接口，由 manager-api 注入实现。

// Session 是一次登录会话在令牌存储里的内容。
//
// 只放**判断权限必需的最小集合**：用户 id 和角色 id。用户名与显示名一并带上
// 是为了免掉每个请求回库查一次用户，代价是改了显示名要等重新登录才更新 ——
// 这个取舍是明确的，因为显示名不参与任何判断。
type Session struct {
	UserID             string    `json:"userId"`
	Username           string    `json:"username"`
	DisplayName        string    `json:"displayName"`
	RoleIDs            []int64   `json:"roleIds"`
	MustChangePassword bool      `json:"mustChangePassword"`
	IssuedAt           time.Time `json:"issuedAt"`
}

// TokenStore 是登录令牌的存放处。
//
// 用外部存储而不是无状态签名令牌，图的是**即时吊销**：管理端会动真钱，撤权、
// 禁用、改密必须当场生效，不能等令牌自然过期。
//
// 实现不可用时**必须返回错误，不能返回「没找到」** —— 前者让请求被拒，
// 后者会被上层当成「令牌无效」，两者对调用方是一样的；但登录路径上，
// 「存不进去」被当成成功会签发一个谁也验不了的令牌。
type TokenStore interface {
	Save(ctx context.Context, token string, session Session, ttl time.Duration) error
	// Load 返回 (会话, 是否存在, 错误)。存储不可用时返回错误，不是 (零值, false, nil)。
	Load(ctx context.Context, token string) (Session, bool, error)
	// Touch 滑动过期：活跃会话自动续期。
	Touch(ctx context.Context, token string, ttl time.Duration) error
	Delete(ctx context.Context, token string) error
	// DeleteByUser 踢掉一个人的全部会话，返回删掉几条。
	// 撤权、禁用、改密都走它 —— 只删当前令牌的话，那个人另一台机器上还开着。
	DeleteByUser(ctx context.Context, userID string) (int, error)

	// ACLVersion 读权限表的版本号，用于多实例间同步进程内缓存。
	ACLVersion(ctx context.Context) (int64, error)
	// BumpACLVersion 在权限写操作之后调用。
	BumpACLVersion(ctx context.Context) error
}
