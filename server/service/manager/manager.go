// Package manager 是**管理端自己的**身份与权限体系。
//
// 它和 service/identity 是两套东西，没有任何数据关联：identity 管的是业务用户
// （web 控制台、App 的账号），manager 管的是登录管理端的平台管理员。合成一套的话，
// 一个业务账号就能进到「封禁节点、裁决争议、发算力密钥」这些会动真钱的地方。
//
// 授权模型是 user → role → resource：
//
//	资源是一棵树，菜单 / 页面 / 接口同处其中。接口资源的身份是 (method, 路由模板)
//	二元组 —— 只按 URL 分的话，同一路径的 GET 和 POST 分不开，而那正是只读角色
//	最该分开的地方。
//
//	角色另有一个 writable 开关，是粗粒度保险：把一个角色整体设成只读一句话配完，
//	不必逐条撤销它的写资源。两道门叠加，写操作两道都得过。
package manager

import (
	"context"
	"sync"
	"time"

	"gorm.io/gorm"

	"service/manager/dto"
	"service/manager/internal/repository"
)

// SuperAdminCode 这个角色绕过资源过滤：看得到全部菜单、访问得了全部接口。
// 没有它，一次配错授权就能把所有人关在门外，连改回来的入口都进不去。
const SuperAdminCode = "super_admin"

const (
	StatusActive   = "active"
	StatusDisabled = "disabled"
)

const (
	ResourceMenu = "menu"
	// ResourceGroup 菜单里的一条分组标题。它和 menu 的差别只在前端怎么画：
	// menu 是要点一下才展开的目录，group 是一行小标题，底下的页面一直摊着。
	//
	// 有它是因为「共享算力池」底下已经十几个页面 —— 平铺成一长条找不到东西，
	// 而再套一层要点开的目录，等于让每天都用的页面多一次点击。分组标题两头都不占。
	ResourceGroup = "group"
	ResourcePage  = "page"
	ResourceAPI   = "api"
)

type Service interface {
	// ---------- 认证 ----------
	Login(ctx context.Context, req dto.LoginRequest) (dto.LoginResult, error)
	// Authorize 是中间件的唯一入口：验令牌 + 判这条路由能不能访问。
	// routePath 要传 gin 的**路由模板**（/api/users/:id），不是具体请求路径。
	Authorize(ctx context.Context, token, method, routePath string) (Session, error)
	Logout(ctx context.Context, token string) error
	CurrentUser(ctx context.Context, userID string) (dto.CurrentUser, error)
	ChangeOwnPassword(ctx context.Context, userID string, req dto.ChangePasswordRequest) error
	// CurrentMenus 按角色过滤后的菜单与页面，扁平数组带 parentId。
	CurrentMenus(ctx context.Context, userID string) ([]dto.ResourceView, error)

	// ---------- 账号 ----------
	ListAccounts(ctx context.Context, query dto.AccountQuery) (dto.AccountPage, error)
	GetAccount(ctx context.Context, userID string) (dto.AccountView, error)
	SaveAccount(ctx context.Context, req dto.SaveAccountRequest) (dto.AccountView, error)
	ResetPassword(ctx context.Context, req dto.ResetPasswordRequest) error
	SetAccountStatus(ctx context.Context, userID, status string) error
	DeleteAccount(ctx context.Context, userID string) error
	ListLoginRecords(ctx context.Context, userID string, limit int) ([]dto.LoginRecordView, error)

	// ---------- 角色与资源 ----------
	ListRoles(ctx context.Context) ([]dto.RoleView, error)
	SaveRole(ctx context.Context, req dto.SaveRoleRequest) (dto.RoleView, error)
	DeleteRole(ctx context.Context, id int64) error
	ListResources(ctx context.Context, resourceType string) ([]dto.ResourceView, error)
	SaveResource(ctx context.Context, req dto.SaveResourceRequest) (dto.ResourceView, error)
	DeleteResource(ctx context.Context, id int64) error
	ListRoleResourceIDs(ctx context.Context, roleID int64) ([]int64, error)
	SaveRoleResources(ctx context.Context, req dto.SaveRoleResourceRequest) error

	// ---------- 初始化与自检 ----------
	EnsureDefaultAdmin(ctx context.Context, username, displayName, password string) error
	EnsureRole(ctx context.Context, code, name string, writable bool) (int64, error)
	// EnsureResource 按 code 幂等登记一条页面或菜单资源，返回它的 id。
	// 页面结构是手写的（路由表里推不出来），但和接口资源一样要经得起反复跑。
	EnsureResource(ctx context.Context, req dto.SaveResourceRequest) (int64, error)
	// SyncAPIResources 按真实路由表登记接口资源。手写清单和路由迟早对不上，
	// 而对不上的后果是登录用户一律 403。
	SyncAPIResources(ctx context.Context, routes []RouteRef) (int, error)
	// UnregisteredRoutes 启动自检：哪些路由没在资源表里登记。
	UnregisteredRoutes(ctx context.Context, routes []RouteRef) ([]RouteRef, error)
	GrantRoleByCode(ctx context.Context, roleCode string, resourceCodes []string) error
}

// RouteRef 一条 gin 路由。Path 是模板，不是具体请求路径。
type RouteRef struct {
	Method string
	Path   string
}

type Config struct {
	// TokenTTL 会话有效期，每次请求滑动续期。
	TokenTTL time.Duration
	// LoginFailWindow / MaxLoginFail 同一账号连续失败多少次就暂时拒绝。
	// 0 表示不限制。
	MaxLoginFail    int
	LoginFailWindow time.Duration
}

func (c Config) withDefaults() Config {
	if c.TokenTTL <= 0 {
		c.TokenTTL = 7 * 24 * time.Hour
	}
	if c.LoginFailWindow <= 0 {
		c.LoginFailWindow = 15 * time.Minute
	}
	return c
}

type Ports struct {
	// Tokens 必填。没有令牌存储就没法登录 —— 构造时会返回错误，
	// 而不是留到运行时空指针。
	Tokens TokenStore
}

type service struct {
	repository *repository.ManagerRepository
	tokens     TokenStore
	config     Config

	// acl 是权限表的进程内缓存。这两张表小且极少变，每个请求查两次库不值得。
	// version 跟着 TokenStore 里的版本号走，别的实例改了权限这边会重建。
	acl struct {
		sync.RWMutex
		version   int64
		loaded    bool
		byRoute   map[routeKey]int64           // (method, path) → resourceID
		byRole    map[int64]map[int64]struct{} // roleID → 资源集合
		writable  map[int64]bool               // roleID → 是否可写
		superRole map[int64]bool               // roleID → 是否 super_admin
	}
}

type routeKey struct {
	Method string
	Path   string
}

func New(database *gorm.DB, ports Ports, config Config) (Service, error) {
	if ports.Tokens == nil {
		return nil, ErrTokenStoreMissing
	}
	repo := &repository.ManagerRepository{}
	repo.SetDb(database)
	return &service{repository: repo, tokens: ports.Tokens, config: config.withDefaults()}, nil
}

// Migrate 建表。与 identity / galaxy 一致，由显式的初始化命令调用。
func Migrate(database *gorm.DB) error {
	repo := &repository.ManagerRepository{}
	repo.SetDb(database)
	return repo.AutoMigrate()
}
