package manager

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"

	"service/manager/dto"
	"service/manager/internal/repository"
)

// 自助路由：必须改初始密码的人也走得通这几条，否则新装的默认管理员会被自己的
// 初始密码锁死 —— 改不了密码，也进不去任何接口。
var selfServicePaths = map[string]bool{
	"/api/auth/me":       true,
	"/api/auth/password": true,
	"/api/auth/logout":   true,
}

func (s *service) Login(ctx context.Context, req dto.LoginRequest) (dto.LoginResult, error) {
	username := strings.TrimSpace(req.Username)
	user, err := s.repository.FindUserByUsername(ctx, username)
	if repository.IsNotFound(err) {
		s.recordLogin(ctx, "", username, req, false, "用户不存在")
		return dto.LoginResult{}, ErrLoginFailed
	}
	if err != nil {
		return dto.LoginResult{}, err
	}
	// 账号被禁用和密码错返回同一句话：分开说等于把「这个用户名存在」告诉试探者。
	if user.Status != StatusActive {
		s.recordLogin(ctx, user.UserID, username, req, false, "账号已禁用")
		return dto.LoginResult{}, ErrLoginFailed
	}
	if bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)) != nil {
		s.recordLogin(ctx, user.UserID, username, req, false, "密码不正确")
		return dto.LoginResult{}, ErrLoginFailed
	}

	roleIDs, err := s.roleIDsOf(ctx, user.UserID)
	if err != nil {
		return dto.LoginResult{}, err
	}
	token, err := newToken()
	if err != nil {
		return dto.LoginResult{}, err
	}
	session := Session{
		UserID: user.UserID, Username: user.Username, DisplayName: user.DisplayName,
		RoleIDs: roleIDs, MustChangePassword: user.MustChangePassword, IssuedAt: time.Now(),
	}
	// 存不进去就不能说登录成功：那会签发一个谁也验不了的令牌，
	// 用户拿着它每一个请求都被拒，却看不出是哪里坏了。
	if err := s.tokens.Save(ctx, token, session, s.config.TokenTTL); err != nil {
		return dto.LoginResult{}, err
	}
	now := time.Now()
	_ = s.repository.TouchLogin(ctx, user.UserID, now)
	s.recordLogin(ctx, user.UserID, username, req, true, "")

	view, err := s.currentUserFrom(ctx, user, roleIDs)
	if err != nil {
		return dto.LoginResult{}, err
	}
	return dto.LoginResult{Token: token, User: view}, nil
}

// Authorize 中间件的唯一入口。
func (s *service) Authorize(ctx context.Context, token, method, routePath string) (Session, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return Session{}, ErrNotLogin
	}
	session, ok, err := s.tokens.Load(ctx, token)
	if err != nil {
		// 存储不可用时拒绝，不降级放行。管理端的每一个写接口都会动到真实数据，
		// 「Redis 挂了所以先放进来」不是一个可以接受的降级。
		return Session{}, err
	}
	if !ok {
		return Session{}, ErrNotLogin
	}
	if err := s.ensureACL(ctx); err != nil {
		return Session{}, err
	}

	path := normalizePath(routePath)
	if selfServicePaths[path] {
		_ = s.tokens.Touch(ctx, token, s.config.TokenTTL)
		return session, nil
	}
	// 必须改密的人只能走自助路由。这一条要挡在资源判断**之前** ——
	// 否则超级管理员会绕过它，初始密码永远留在库里。
	if session.MustChangePassword {
		return Session{}, ErrMustChangePasswd
	}
	if err := s.checkRoute(session.RoleIDs, method, path); err != nil {
		return Session{}, err
	}
	// 滑动过期：活跃会话自动续期。续期失败不该让请求挂掉 —— 那是存储的问题，
	// 而这次鉴权已经过了。
	_ = s.tokens.Touch(ctx, token, s.config.TokenTTL)
	return session, nil
}

func (s *service) Logout(ctx context.Context, token string) error {
	return s.tokens.Delete(ctx, strings.TrimSpace(token))
}

func (s *service) CurrentUser(ctx context.Context, userID string) (dto.CurrentUser, error) {
	user, err := s.repository.FindUser(ctx, userID)
	if repository.IsNotFound(err) {
		return dto.CurrentUser{}, ErrNotFound
	}
	if err != nil {
		return dto.CurrentUser{}, err
	}
	roleIDs, err := s.roleIDsOf(ctx, userID)
	if err != nil {
		return dto.CurrentUser{}, err
	}
	if err := s.ensureACL(ctx); err != nil {
		return dto.CurrentUser{}, err
	}
	return s.currentUserFrom(ctx, user, roleIDs)
}

func (s *service) currentUserFrom(ctx context.Context, user *repository.ManagerUser, roleIDs []int64) (dto.CurrentUser, error) {
	if err := s.ensureACL(ctx); err != nil {
		return dto.CurrentUser{}, err
	}
	refs, err := s.roleRefs(ctx, roleIDs)
	if err != nil {
		return dto.CurrentUser{}, err
	}
	superAdmin := s.rolesAreSuperAdmin(roleIDs)
	return dto.CurrentUser{
		UserID: user.UserID, Username: user.Username, DisplayName: user.DisplayName,
		Status: user.Status, MustChangePassword: user.MustChangePassword,
		Roles: refs, LastLoginAt: user.LastLoginAt,
		// 超级管理员天然可写：它绕过资源过滤，写权限也不该被 writable 拦住。
		Writable:   superAdmin || s.rolesCanWrite(roleIDs),
		SuperAdmin: superAdmin,
	}, nil
}

func (s *service) roleRefs(ctx context.Context, roleIDs []int64) ([]dto.RoleRef, error) {
	if len(roleIDs) == 0 {
		return []dto.RoleRef{}, nil
	}
	rows, err := s.repository.ListRoles(ctx, "")
	if err != nil {
		return nil, err
	}
	wanted := make(map[int64]struct{}, len(roleIDs))
	for _, id := range roleIDs {
		wanted[id] = struct{}{}
	}
	refs := make([]dto.RoleRef, 0, len(roleIDs))
	for _, row := range rows {
		if _, ok := wanted[row.ID]; ok {
			refs = append(refs, dto.RoleRef{ID: row.ID, Code: row.Code, Name: row.Name})
		}
	}
	return refs, nil
}

func (s *service) ChangeOwnPassword(ctx context.Context, userID string, req dto.ChangePasswordRequest) error {
	user, err := s.repository.FindUser(ctx, userID)
	if repository.IsNotFound(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.OldPassword)) != nil {
		return ErrLoginFailed
	}
	if req.OldPassword == req.NewPassword {
		return ErrSamePassword
	}
	hash, err := hashPassword(req.NewPassword)
	if err != nil {
		return err
	}
	if err := s.repository.UpdateUser(ctx, userID, map[string]any{
		"password_hash": hash, "must_change_password": false,
	}); err != nil {
		return err
	}
	// 改密即全端下线。只删当前令牌的话，密码被人拿去登过的那台机器还开着。
	_, err = s.tokens.DeleteByUser(ctx, userID)
	return err
}

func (s *service) recordLogin(ctx context.Context, userID, username string, req dto.LoginRequest, success bool, reason string) {
	// 登录留痕失败不该挡住登录本身。
	_ = s.repository.SaveLoginRecord(ctx, &repository.ManagerLoginRecord{
		UserID: userID, Username: username, IP: req.IP,
		UserAgent: truncate(req.UserAgent, 256), Success: success, Reason: reason,
	})
}

func (s *service) ListLoginRecords(ctx context.Context, userID string, limit int) ([]dto.LoginRecordView, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.repository.ListLoginRecords(ctx, userID, limit)
	if err != nil {
		return nil, err
	}
	views := make([]dto.LoginRecordView, 0, len(rows))
	for _, row := range rows {
		views = append(views, dto.LoginRecordView{
			UserID: row.UserID, Username: row.Username, IP: row.IP, UserAgent: row.UserAgent,
			Success: row.Success, Reason: row.Reason, CreatedTime: row.CreatedTime,
		})
	}
	return views, nil
}

// hashPassword 与 service/identity 同一套 bcrypt。两边各写一份而不是抽公共函数：
// 这两套身份体系是刻意分开的，共用一个工具函数会让人以为它们还有别的牵连。
func hashPassword(value string) (string, error) {
	if len(value) < 8 {
		return "", ErrWeakPassword
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(value), bcrypt.DefaultCost)
	return string(hash), err
}

// newToken 32 字节随机数。令牌是不透明串，不携带任何信息 ——
// 它的全部含义都在令牌存储那一头。
func newToken() (string, error) {
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

func truncate(value string, max int) string {
	if len(value) <= max {
		return value
	}
	return value[:max]
}
