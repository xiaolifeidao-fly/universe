// Package repository 是管理端身份与权限的持久化层。
//
// 时间列一律写 `type:timestamp null`，不要写成 `type:timestamp` 或 `type:timestamp;null`。
// `;null` 是个空写法：GORM 不认识这个标签元素，发出去的 DDL 里没有 NULL。而 MySQL 在
// explicit_defaults_for_timestamp=OFF 时（5.7 默认，8.x 也可能被配成这样），会对没有
// 显式 NULL / DEFAULT 的 TIMESTAMP 列做两件事：每张表的第一个静默补上
// `NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`，第二个及以后补上
// `DEFAULT '0000-00-00'` 被 NO_ZERO_DATE 拒绝、建表直接报 1067。报错那半是好事，
// 静默那半才要命 —— 一个记「最后登录时间」的列会变成每次 UPDATE 都刷新。
package repository

import "time"

// ManagerUser 管理端账号。
//
// 这是一套**独立于 zt_identity_user** 的身份：web 控制台和 App 的业务账号登不进管理端。
// 管理端的处置动作会动真钱（争议裁决在三本账上记反向流水、封禁节点、发算力密钥），
// 它的账号不该和业务用户共用一个 role=admin 布尔。
//
// 没有 token_version：令牌在 Redis 里，撤销直接删键，不需要无状态令牌那套版本号。
type ManagerUser struct {
	ID     int64  `gorm:"column:id;primaryKey;autoIncrement"`
	UserID string `gorm:"column:user_id;type:varchar(40);uniqueIndex:uk_mgr_user_id" description:"mu_ + ULID"`

	Username     string `gorm:"column:username;type:varchar(64);uniqueIndex:uk_mgr_user_name"`
	DisplayName  string `gorm:"column:display_name;type:varchar(128)"`
	PasswordHash string `gorm:"column:password_hash;type:varchar(128)" description:"bcrypt，明文不落库"`
	Status       string `gorm:"column:status;type:varchar(16);index:idx_mgr_user_status" description:"active/disabled"`
	// MustChangePassword 初装的默认管理员为真。中间件会把它挡在除改密之外的所有接口外面。
	MustChangePassword bool       `gorm:"column:must_change_password;default:false"`
	LastLoginAt        *time.Time `gorm:"column:last_login_at;type:timestamp null"`
	Remark             string     `gorm:"column:remark;type:varchar(256)"`

	CreatedTime time.Time `gorm:"column:created_time;autoCreateTime"`
	UpdatedTime time.Time `gorm:"column:updated_time;autoUpdateTime"`
}

func (r *ManagerUser) TableName() string { return "zt_manager_user" }
func (r *ManagerUser) Init()             {}

// ManagerRole 角色。
//
// Writable 是一道**粗粒度保险**：把一个角色整体设成只读，一句话配完，不必逐条撤销
// 它的写资源。它和资源授权是叠加关系 —— 两道门都得过。光有资源授权配不出
// 「这个人临时只读」，光有 writable 配不出「能改用户、不能封节点」。
type ManagerRole struct {
	ID       int64  `gorm:"column:id;primaryKey;autoIncrement"`
	Code     string `gorm:"column:code;type:varchar(64);uniqueIndex:uk_mgr_role_code"`
	Name     string `gorm:"column:name;type:varchar(64)"`
	Writable bool   `gorm:"column:writable;default:false" description:"角色是否允许写操作，默认只读"`
	Status   string `gorm:"column:status;type:varchar(16);index:idx_mgr_role_status" description:"active/disabled"`
	Remark   string `gorm:"column:remark;type:varchar(256)"`

	CreatedTime time.Time `gorm:"column:created_time;autoCreateTime"`
	UpdatedTime time.Time `gorm:"column:updated_time;autoUpdateTime"`
}

func (r *ManagerRole) TableName() string { return "zt_manager_role" }
func (r *ManagerRole) Init()             {}

// ManagerResource 受控资源：菜单、页面、接口，三者同一棵树。
//
// Method + ResourceURL 是接口资源的身份。只按 URL 匹配的话，同一路径的 GET 和 POST
// 分不开 —— 而那正是只读角色最该分开的地方。
//
// ResourceURL 存的是 **gin 的路由模板**（如 /api/users/:id），不是具体请求路径，
// 否则每个 id 都要在表里占一行。
type ManagerResource struct {
	ID       int64  `gorm:"column:id;primaryKey;autoIncrement"`
	ParentID int64  `gorm:"column:parent_id;default:0;index:idx_mgr_resource_parent"`
	Code     string `gorm:"column:code;type:varchar(96);uniqueIndex:uk_mgr_resource_code" description:"稳定标识，前端按它取 i18n 文案"`
	Name     string `gorm:"column:name;type:varchar(64)"`

	ResourceType string `gorm:"column:resource_type;type:varchar(16);index:idx_mgr_resource_type" description:"menu/group/page/api；group 是菜单里的分组标题，不是页面"`
	Method       string `gorm:"column:method;type:varchar(8)" description:"接口资源的 HTTP 方法；菜单与页面为空"`
	ResourceURL  string `gorm:"column:resource_url;type:varchar(200);index:idx_mgr_resource_url" description:"gin 路由模板，如 /api/users/:id"`
	PageURL      string `gorm:"column:page_url;type:varchar(200)" description:"前端路由，菜单项的 key 就是它"`
	Icon         string `gorm:"column:icon;type:varchar(64)" description:"antd 图标名，前端按白名单查组件"`
	SortID       int    `gorm:"column:sort_id;default:0"`
	Status       string `gorm:"column:status;type:varchar(16)" description:"active/disabled"`

	CreatedTime time.Time `gorm:"column:created_time;autoCreateTime"`
	UpdatedTime time.Time `gorm:"column:updated_time;autoUpdateTime"`
}

func (r *ManagerResource) TableName() string { return "zt_manager_resource" }
func (r *ManagerResource) Init()             {}

type ManagerUserRole struct {
	ID     int64 `gorm:"column:id;primaryKey;autoIncrement"`
	UserID int64 `gorm:"column:user_id;uniqueIndex:uk_mgr_user_role,priority:1"`
	RoleID int64 `gorm:"column:role_id;uniqueIndex:uk_mgr_user_role,priority:2;index:idx_mgr_user_role_role"`

	CreatedTime time.Time `gorm:"column:created_time;autoCreateTime"`
}

func (r *ManagerUserRole) TableName() string { return "zt_manager_user_role" }
func (r *ManagerUserRole) Init()             {}

type ManagerRoleResource struct {
	ID         int64 `gorm:"column:id;primaryKey;autoIncrement"`
	RoleID     int64 `gorm:"column:role_id;uniqueIndex:uk_mgr_role_resource,priority:1"`
	ResourceID int64 `gorm:"column:resource_id;uniqueIndex:uk_mgr_role_resource,priority:2"`

	CreatedTime time.Time `gorm:"column:created_time;autoCreateTime"`
}

func (r *ManagerRoleResource) TableName() string { return "zt_manager_role_resource" }
func (r *ManagerRoleResource) Init()             {}

// ManagerLoginRecord 登录留痕。失败也记 —— 只记成功的话，撞库看不出来。
type ManagerLoginRecord struct {
	ID        int64  `gorm:"column:id;primaryKey;autoIncrement"`
	UserID    string `gorm:"column:user_id;type:varchar(40);index:idx_mgr_login_user,priority:1"`
	Username  string `gorm:"column:username;type:varchar(64)"`
	IP        string `gorm:"column:ip;type:varchar(64)"`
	UserAgent string `gorm:"column:user_agent;type:varchar(256)"`
	Success   bool   `gorm:"column:success;default:false"`
	// Reason 失败原因。面向审计，不含密码或令牌。
	Reason string `gorm:"column:reason;type:varchar(128)"`

	CreatedTime time.Time `gorm:"column:created_time;autoCreateTime;index:idx_mgr_login_user,priority:2,sort:desc"`
}

func (r *ManagerLoginRecord) TableName() string { return "zt_manager_login_record" }
func (r *ManagerLoginRecord) Init()             {}
