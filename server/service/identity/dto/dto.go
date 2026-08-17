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
	Programs           []ProgramScope `json:"programs"`
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
