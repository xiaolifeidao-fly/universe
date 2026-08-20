// Package dto contains identity domain request and response shapes.
package dto

import "time"

type Page struct {
	PageIndex int `json:"pageIndex" form:"pageIndex"`
	PageSize  int `json:"pageSize" form:"pageSize"`
}

func (p Page) Offset() int {
	if p.PageIndex <= 1 {
		return 0
	}
	return (p.PageIndex - 1) * p.Limit()
}

func (p Page) Limit() int {
	if p.PageSize <= 0 {
		return 20
	}
	if p.PageSize > 200 {
		return 200
	}
	return p.PageSize
}

type ProgramScope struct {
	BizLine   string `json:"bizLine"`
	ProgramID int64  `json:"programId"`
}

type UserView struct {
	ID                 int64          `json:"id"`
	Username           string         `json:"username"`
	DisplayName        string         `json:"displayName"`
	Role               string         `json:"role"`
	Status             string         `json:"status"`
	MustChangePassword bool           `json:"mustChangePassword"`
	BizLines           []string       `json:"bizLines"`
	WritableBizLines   []string       `json:"writableBizLines"`
	ManagedBizLines    []string       `json:"managedBizLines"`
	Programs           []ProgramScope `json:"programs"`
	ManagedPrograms    []ProgramScope `json:"managedPrograms"`
	LastLoginAt        *time.Time     `json:"lastLoginAt"`
	UpdatedAt          *time.Time     `json:"updatedAt"`
	CreatedAt          *time.Time     `json:"createdAt"`
}

type UserPage struct {
	Total int64      `json:"total"`
	Data  []UserView `json:"data"`
}

// MemberView 是给选人控件用的最小用户信息。
// 需求要指定主负责人和辅助人，普通成员也得能列出同事，
// 但没有理由让他们看到别人的角色、业务线授权和登录时间。
type MemberView struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
}

type MemberQuery struct {
	Keyword string `json:"keyword" form:"keyword"`
}

// ScopeAssignment keeps a resource's members and administrators separate.
// Managers are always also members, so replacing either list cannot create a
// manager that has no visibility of the corresponding resource.
type ScopeAssignment struct {
	UserIDs    []int64 `json:"userIds"`
	WriterIDs  []int64 `json:"writerIds"`
	ManagerIDs []int64 `json:"managerIds"`
}

// BizLineMemberView 是「查看成员」面板一行。空间管理员要据此决定
// 谁该被剔除、谁该从只读升到写入，所以比 MemberView 多带权限位。
type BizLineMemberView struct {
	ID          int64      `json:"id"`
	Username    string     `json:"username"`
	DisplayName string     `json:"displayName"`
	IsManager   bool       `json:"isManager"`
	CanWrite    bool       `json:"canWrite"`
	Permission  string     `json:"permission"`
	JoinedAt    *time.Time `json:"joinedAt"`
}

// BizLineMemberRequest 单个成员的加入或权限调整。
// 加入走分享链接，权限调整走「查看成员」面板，两者共用这一个入参。
type BizLineMemberRequest struct {
	BizLine   string `json:"bizLine"`
	UserID    int64  `json:"userId"`
	CanWrite  bool   `json:"canWrite"`
	AsManager bool   `json:"asManager"`
}

type UserQuery struct {
	Page
	Keyword string `json:"keyword" form:"keyword"`
	Role    string `json:"role" form:"role"`
	Status  string `json:"status" form:"status"`
}

type SaveUserRequest struct {
	ID          int64          `json:"id"`
	Username    string         `json:"username"`
	DisplayName string         `json:"displayName"`
	Role        string         `json:"role"`
	Status      string         `json:"status"`
	Password    string         `json:"password"`
	BizLines    []string       `json:"bizLines"`
	Programs    []ProgramScope `json:"programs"`
	ActorID     string         `json:"-"`
}

type ResetPasswordRequest struct {
	UserID   int64  `json:"userId"`
	Password string `json:"password"`
	ActorID  string `json:"-"`
}

type LoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type LoginResult struct {
	Token string   `json:"token"`
	User  UserView `json:"user"`
}

type ChangeOwnPasswordRequest struct {
	CurrentPassword string `json:"currentPassword"`
	NewPassword     string `json:"newPassword"`
}

// RegisterRequest 是登录页自助注册的入参。
// 用户名同时会成为该用户专属空间的编码，所以约束比后台建号更严。
type RegisterRequest struct {
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	Password    string `json:"password"`
}
