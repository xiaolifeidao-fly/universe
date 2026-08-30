// 登录与密码：签发凭证、校验凭证、改密与重置。
// 令牌本身的编解码在 token.go。

package identity

import (
	"context"
	"errors"
	"fmt"
	"regexp"
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
		Role: user.Role, Persona: view.Persona, Personas: view.Personas, MustChangePassword: user.MustChangePassword, BizLines: view.BizLines, WritableBizLines: view.WritableBizLines, ManagedBizLines: view.ManagedBizLines, ProgramIDs: programIDs, ManagedProgramIDs: managedProgramIDs,
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

// registerUsernamePattern 与 bizline 的空间编码规则保持一致：
// 注册成功后用户名会直接作为该用户专属空间的编码。
var registerUsernamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)

// Register 是登录页自助注册：只创建账号本身。
// 专属空间的创建与授权由 API 层编排，identity 不反向依赖 bizline。
func (s *service) Register(ctx context.Context, req dto.RegisterRequest) (dto.LoginResult, error) {
	username := strings.ToLower(strings.TrimSpace(req.Username))
	displayName := strings.TrimSpace(req.DisplayName)
	if displayName == "" {
		displayName = username
	}
	if username == "" {
		return dto.LoginResult{}, errors.New("请输入用户名")
	}
	if len(username) < 2 || len(username) > 32 {
		return dto.LoginResult{}, errors.New("用户名长度需要在 2 到 32 个字符之间")
	}
	if !registerUsernamePattern.MatchString(username) {
		return dto.LoginResult{}, errors.New("用户名仅支持小写字母、数字、下划线和连字符，且需以字母或数字开头")
	}
	if len(displayName) > 64 {
		return dto.LoginResult{}, errors.New("显示名不能超过 64 个字符")
	}
	if _, err := s.repo.FindUserByUsername(ctx, username); err == nil {
		return dto.LoginResult{}, errors.New("用户名已存在")
	} else if !repository.IsNotFound(err) {
		return dto.LoginResult{}, err
	}
	hash, err := hashPassword(req.Password)
	if err != nil {
		return dto.LoginResult{}, err
	}
	user := &repository.IdentityUser{
		Username:           username,
		DisplayName:        displayName,
		PasswordHash:       hash,
		Role:               RoleMember,
		Persona:            PersonaProductResearch,
		Status:             StatusActive,
		MustChangePassword: false,
		TokenVersion:       1,
	}
	if err := s.repo.CreateUser(ctx, user); err != nil {
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
