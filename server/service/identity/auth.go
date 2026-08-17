// 登录与密码：签发凭证、校验凭证、改密与重置。
// 令牌本身的编解码在 token.go。

package identity

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"common/middleware/httpx"
	"service/identity/dto"
	"service/identity/internal/repository"

	"golang.org/x/crypto/bcrypt"
)

func (s *service) Login(ctx context.Context, req dto.LoginRequest) (dto.LoginResult, error) {
	username := strings.TrimSpace(req.Username)
	if username == "" || req.Password == "" {
		return dto.LoginResult{}, errors.New("请输入账号和密码")
	}
	user, err := s.repo.FindUserByUsername(ctx, username)
	if err != nil {
		return dto.LoginResult{}, loginError(err)
	}
	if user.Status != StatusActive || bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)) != nil {
		return dto.LoginResult{}, errors.New("账号或密码错误")
	}
	token, err := issueToken(s.tokenSecret, user.ID, user.TokenVersion, time.Now().Add(s.tokenTTL))
	if err != nil {
		return dto.LoginResult{}, err
	}
	if err := s.repo.UpdateLastLogin(ctx, user.ID); err != nil {
		return dto.LoginResult{}, err
	}
	view, err := s.toUserView(ctx, user)
	if err != nil {
		return dto.LoginResult{}, err
	}
	view.LastLoginAt = timePtr(time.Now())
	return dto.LoginResult{Token: token, User: view}, nil
}

func (s *service) AuthenticateToken(ctx context.Context, rawToken string) (httpx.UserPrincipal, error) {
	claims, err := parseToken(s.tokenSecret, rawToken)
	if err != nil {
		return httpx.UserPrincipal{}, err
	}
	user, err := s.repo.FindUser(ctx, claims.Subject)
	if err != nil || user.Status != StatusActive || user.TokenVersion != claims.TokenVersion {
		return httpx.UserPrincipal{}, errors.New("登录凭证已失效")
	}
	view, err := s.toUserView(ctx, user)
	if err != nil {
		return httpx.UserPrincipal{}, err
	}
	programIDs := make([]int64, 0, len(view.Programs))
	managedProgramIDs := make([]int64, 0, len(view.ManagedPrograms))
	for _, program := range view.Programs {
		programIDs = append(programIDs, program.ProgramID)
	}
	for _, program := range view.ManagedPrograms {
		managedProgramIDs = append(managedProgramIDs, program.ProgramID)
	}
	return httpx.UserPrincipal{
		ID: strconv.FormatInt(user.ID, 10), Username: user.Username, DisplayName: user.DisplayName,
		Role: user.Role, MustChangePassword: user.MustChangePassword, BizLines: view.BizLines, ManagedBizLines: view.ManagedBizLines, ProgramIDs: programIDs, ManagedProgramIDs: managedProgramIDs,
	}, nil
}

func (s *service) ResetPassword(ctx context.Context, req dto.ResetPasswordRequest) error {
	if req.UserID <= 0 || strings.TrimSpace(req.Password) == "" {
		return errors.New("请填写用户和新密码")
	}
	user, err := s.repo.FindUser(ctx, req.UserID)
	if err != nil {
		return translate(err)
	}
	user.PasswordHash, err = hashPassword(req.Password)
	if err != nil {
		return err
	}
	user.TokenVersion++
	user.MustChangePassword = true
	return s.repo.UpdateUser(ctx, user)
}

func (s *service) ChangeOwnPassword(ctx context.Context, userID int64, req dto.ChangeOwnPasswordRequest) (dto.LoginResult, error) {
	if strings.TrimSpace(req.CurrentPassword) == "" || strings.TrimSpace(req.NewPassword) == "" {
		return dto.LoginResult{}, errors.New("请填写当前密码和新密码")
	}
	user, err := s.repo.FindUser(ctx, userID)
	if err != nil {
		return dto.LoginResult{}, translate(err)
	}
	if bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.CurrentPassword)) != nil {
		return dto.LoginResult{}, errors.New("当前密码不正确")
	}
	user.PasswordHash, err = hashPassword(req.NewPassword)
	if err != nil {
		return dto.LoginResult{}, err
	}
	user.TokenVersion++
	user.MustChangePassword = false
	if err := s.repo.UpdateUser(ctx, user); err != nil {
		return dto.LoginResult{}, err
	}
	token, err := issueToken(s.tokenSecret, user.ID, user.TokenVersion, time.Now().Add(s.tokenTTL))
	if err != nil {
		return dto.LoginResult{}, err
	}
	view, err := s.toUserView(ctx, user)
	if err != nil {
		return dto.LoginResult{}, err
	}
	return dto.LoginResult{Token: token, User: view}, nil
}

func hashPassword(value string) (string, error) {
	if len(value) < 8 {
		return "", errors.New("密码至少需要 8 个字符")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(value), bcrypt.DefaultCost)
	return string(hash), err
}

func loginError(err error) error {
	if repository.IsNotFound(err) {
		return errors.New("账号或密码错误")
	}
	return fmt.Errorf("认证服务不可用: %w", err)
}
