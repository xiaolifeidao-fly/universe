// Package identity owns console accounts, password credentials, and user data scopes.
package identity

import (
	"context"
	"strings"
	"time"

	"common/middleware/httpx"
	"contract"
	"service/identity/dto"
	"service/identity/internal/repository"

	"gorm.io/gorm"
)

const (
	RoleAdmin      = "admin"
	RoleMember     = "member"
	StatusActive   = "active"
	StatusDisabled = "disabled"
)

type Service interface {
	Login(context.Context, dto.LoginRequest) (dto.LoginResult, error)
	AuthenticateToken(context.Context, string) (httpx.UserPrincipal, error)
	CurrentUser(context.Context, int64) (dto.UserView, error)
	ListUsers(context.Context, dto.UserQuery) (dto.UserPage, error)
	// ListMembers 供选人控件使用，任何登录用户都能调用，只返回标识和显示名。
	ListMembers(context.Context, dto.MemberQuery) ([]dto.MemberView, error)
	GetUser(context.Context, int64) (dto.UserView, error)
	SaveUser(context.Context, dto.SaveUserRequest) (dto.UserView, error)
	ResetPassword(context.Context, dto.ResetPasswordRequest) error
	ChangeOwnPassword(context.Context, int64, dto.ChangeOwnPasswordRequest) (dto.LoginResult, error)
	DeleteUser(context.Context, int64, string) error
	EnsureDefaultAdmin(ctx context.Context, username, displayName, password string) error
}

// ProgramScopeReader keeps project ownership validation at the identity
// boundary without importing the delivery domain. The aggregate currently
// injects delivery.Service, while a future identity deployment can use an
// HTTP implementation of the same narrow port.
type ProgramScopeReader interface {
	ResolveProgramBizLine(context.Context, int64) (contract.BizLine, error)
}

type service struct {
	repo        *repository.IdentityRepository
	programs    ProgramScopeReader
	tokenSecret string
	tokenTTL    time.Duration
}

func New(database *gorm.DB, programs ProgramScopeReader, tokenSecret string, tokenTTL time.Duration) Service {
	repo := &repository.IdentityRepository{}
	repo.SetDb(database)
	if tokenTTL <= 0 {
		tokenTTL = 7 * 24 * time.Hour
	}
	return &service{repo: repo, programs: programs, tokenSecret: strings.TrimSpace(tokenSecret), tokenTTL: tokenTTL}
}
