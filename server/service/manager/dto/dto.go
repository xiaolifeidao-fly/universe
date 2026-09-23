// Package dto 是管理端身份与权限的跨层数据形状。
package dto

import "time"

// ---------- 认证 ----------

type LoginRequest struct {
	Username string `json:"username" binding:"required"`
	Password string `json:"password" binding:"required"`
	// IP / UserAgent 由 handler 从请求里取，不接受请求体传入 —— 那是给审计看的，
	// 让调用方自报等于没记。
	IP        string `json:"-"`
	UserAgent string `json:"-"`
}

type LoginResult struct {
	Token string      `json:"token"`
	User  CurrentUser `json:"user"`
}

// CurrentUser 是 /auth/me 的形状，也是登录响应里那个 user。
//
// Writable 是前端只读开关的**唯一来源**：任何一个在职角色开了写权限就是 true。
// 前端默认取 false，拿不到这个字段时按只读渲染。
type CurrentUser struct {
	UserID             string    `json:"userId"`
	Username           string    `json:"username"`
	DisplayName        string    `json:"displayName"`
	Status             string    `json:"status"`
	MustChangePassword bool      `json:"mustChangePassword"`
	Roles              []RoleRef `json:"roles"`
	Writable           bool      `json:"writable"`
	// SuperAdmin 为真表示绕过资源过滤，看得到全部菜单。
	SuperAdmin  bool       `json:"superAdmin"`
	LastLoginAt *time.Time `json:"lastLoginAt,omitempty"`
}

type RoleRef struct {
	ID   int64  `json:"id"`
	Code string `json:"code"`
	Name string `json:"name"`
}

type ChangePasswordRequest struct {
	OldPassword string `json:"oldPassword" binding:"required"`
	NewPassword string `json:"newPassword" binding:"required"`
}

// ---------- 账号 ----------

type AccountQuery struct {
	Keyword   string `form:"keyword"`
	Status    string `form:"status"`
	PageIndex int    `form:"pageIndex"`
	PageSize  int    `form:"pageSize"`
}

func (q AccountQuery) Offset() int {
	if q.PageIndex <= 1 {
		return 0
	}
	return (q.PageIndex - 1) * q.Limit()
}

func (q AccountQuery) Limit() int {
	if q.PageSize <= 0 {
		return 20
	}
	if q.PageSize > 200 {
		return 200
	}
	return q.PageSize
}

type SaveAccountRequest struct {
	UserID      string `json:"userId"`
	Username    string `json:"username" binding:"required"`
	DisplayName string `json:"displayName"`
	// Password 只在新建时必填。改资料不带它就不动密码 —— 编辑表单里回显密码
	// 本身就是个坏主意。
	Password string  `json:"password"`
	Status   string  `json:"status"`
	Remark   string  `json:"remark"`
	RoleIDs  []int64 `json:"roleIds"`
}

type ResetPasswordRequest struct {
	UserID   string `json:"userId" binding:"required"`
	Password string `json:"password" binding:"required"`
}

type AccountView struct {
	UserID             string     `json:"userId"`
	Username           string     `json:"username"`
	DisplayName        string     `json:"displayName"`
	Status             string     `json:"status"`
	MustChangePassword bool       `json:"mustChangePassword"`
	Remark             string     `json:"remark"`
	Roles              []RoleRef  `json:"roles"`
	LastLoginAt        *time.Time `json:"lastLoginAt,omitempty"`
	CreatedTime        time.Time  `json:"createdTime"`
}

type AccountPage struct {
	List  []AccountView `json:"list"`
	Total int64         `json:"total"`
}

// ---------- 角色 ----------

type SaveRoleRequest struct {
	ID       int64  `json:"id"`
	Code     string `json:"code" binding:"required"`
	Name     string `json:"name" binding:"required"`
	Writable bool   `json:"writable"`
	Status   string `json:"status"`
	Remark   string `json:"remark"`
}

type RoleView struct {
	ID          int64     `json:"id"`
	Code        string    `json:"code"`
	Name        string    `json:"name"`
	Writable    bool      `json:"writable"`
	Status      string    `json:"status"`
	Remark      string    `json:"remark"`
	UserCount   int64     `json:"userCount"`
	CreatedTime time.Time `json:"createdTime"`
}

// ---------- 资源 ----------

type SaveResourceRequest struct {
	ID           int64  `json:"id"`
	ParentID     int64  `json:"parentId"`
	Code         string `json:"code" binding:"required"`
	Name         string `json:"name" binding:"required"`
	ResourceType string `json:"resourceType" binding:"required"`
	Method       string `json:"method"`
	ResourceURL  string `json:"resourceUrl"`
	PageURL      string `json:"pageUrl"`
	Icon         string `json:"icon"`
	SortID       int    `json:"sortId"`
	Status       string `json:"status"`
}

// ResourceView 前端拿到的是**扁平数组 + parentId**，树在前端拼。
// 后端拼好嵌套 JSON 的话，"给我所有 page 类型的" 这种查询就得再遍历一遍。
type ResourceView struct {
	ID           int64  `json:"id"`
	ParentID     int64  `json:"parentId"`
	Code         string `json:"code"`
	Name         string `json:"name"`
	ResourceType string `json:"resourceType"`
	Method       string `json:"method,omitempty"`
	ResourceURL  string `json:"resourceUrl,omitempty"`
	PageURL      string `json:"pageUrl,omitempty"`
	Icon         string `json:"icon,omitempty"`
	SortID       int    `json:"sortId"`
	Status       string `json:"status"`
}

type SaveRoleResourceRequest struct {
	RoleID      int64   `json:"roleId" binding:"required"`
	ResourceIDs []int64 `json:"resourceIds"`
}

type LoginRecordView struct {
	UserID      string    `json:"userId"`
	Username    string    `json:"username"`
	IP          string    `json:"ip"`
	UserAgent   string    `json:"userAgent,omitempty"`
	Success     bool      `json:"success"`
	Reason      string    `json:"reason,omitempty"`
	CreatedTime time.Time `json:"createdTime"`
}
