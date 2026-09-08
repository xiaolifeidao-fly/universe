package manager

import (
	"context"
	"strings"
	"time"

	"service/manager/dto"
	"service/manager/internal/repository"
)

func (s *service) ListAccounts(ctx context.Context, query dto.AccountQuery) (dto.AccountPage, error) {
	rows, total, err := s.repository.ListUsers(ctx, repository.UserQuery{
		Keyword: query.Keyword, Status: query.Status,
		Offset: query.Offset(), Limit: query.Limit(),
	})
	if err != nil {
		return dto.AccountPage{}, err
	}
	views := make([]dto.AccountView, 0, len(rows))
	for _, row := range rows {
		view, err := s.accountView(ctx, row)
		if err != nil {
			return dto.AccountPage{}, err
		}
		views = append(views, view)
	}
	return dto.AccountPage{List: views, Total: total}, nil
}

func (s *service) GetAccount(ctx context.Context, userID string) (dto.AccountView, error) {
	row, err := s.repository.FindUser(ctx, userID)
	if repository.IsNotFound(err) {
		return dto.AccountView{}, ErrNotFound
	}
	if err != nil {
		return dto.AccountView{}, err
	}
	return s.accountView(ctx, row)
}

func (s *service) SaveAccount(ctx context.Context, req dto.SaveAccountRequest) (dto.AccountView, error) {
	username := strings.TrimSpace(req.Username)
	if username == "" {
		return dto.AccountView{}, ErrNotFound
	}
	status := req.Status
	if status != StatusDisabled {
		status = StatusActive
	}

	if req.UserID == "" {
		if _, err := s.repository.FindUserByUsername(ctx, username); err == nil {
			return dto.AccountView{}, ErrUsernameTaken
		} else if !repository.IsNotFound(err) {
			return dto.AccountView{}, err
		}
		hash, err := hashPassword(req.Password)
		if err != nil {
			return dto.AccountView{}, err
		}
		row := &repository.ManagerUser{
			UserID: "mu_" + newULID(time.Now()), Username: username,
			DisplayName: defaultString(req.DisplayName, username), PasswordHash: hash,
			Status: status, MustChangePassword: true, Remark: truncate(req.Remark, 256),
		}
		if err := s.repository.CreateUser(ctx, row); err != nil {
			return dto.AccountView{}, err
		}
		if err := s.assignRoles(ctx, row, req.RoleIDs); err != nil {
			return dto.AccountView{}, err
		}
		return s.accountView(ctx, row)
	}

	row, err := s.repository.FindUser(ctx, req.UserID)
	if repository.IsNotFound(err) {
		return dto.AccountView{}, ErrNotFound
	}
	if err != nil {
		return dto.AccountView{}, err
	}
	if !strings.EqualFold(row.Username, username) {
		if _, err := s.repository.FindUserByUsername(ctx, username); err == nil {
			return dto.AccountView{}, ErrUsernameTaken
		} else if !repository.IsNotFound(err) {
			return dto.AccountView{}, err
		}
	}
	values := map[string]any{
		"username": username, "display_name": defaultString(req.DisplayName, username),
		"status": status, "remark": truncate(req.Remark, 256),
	}
	// 密码留空就是不改。编辑表单里回显密码本身就是个坏主意，
	// 所以「没填」不能被当成「改成空」。
	if strings.TrimSpace(req.Password) != "" {
		hash, err := hashPassword(req.Password)
		if err != nil {
			return dto.AccountView{}, err
		}
		values["password_hash"] = hash
		values["must_change_password"] = true
	}
	if err := s.repository.UpdateUser(ctx, req.UserID, values); err != nil {
		return dto.AccountView{}, err
	}
	if err := s.assignRoles(ctx, row, req.RoleIDs); err != nil {
		return dto.AccountView{}, err
	}
	// 禁用、改密、换角色都要当场生效：留着旧会话等于改了个寂寞。
	if status == StatusDisabled || values["password_hash"] != nil {
		if _, err := s.tokens.DeleteByUser(ctx, req.UserID); err != nil {
			return dto.AccountView{}, err
		}
	}
	updated, err := s.repository.FindUser(ctx, req.UserID)
	if err != nil {
		return dto.AccountView{}, err
	}
	return s.accountView(ctx, updated)
}

// assignRoles 换角色之后必须踢掉会话：角色 id 是写进令牌会话里的，
// 不踢的话降权要等到令牌过期才生效。
func (s *service) assignRoles(ctx context.Context, user *repository.ManagerUser, roleIDs []int64) error {
	if roleIDs == nil {
		return nil
	}
	current, err := s.repository.ListUserRoles(ctx, user.ID)
	if err != nil {
		return err
	}
	if err := s.guardLastSuperAdmin(ctx, user.ID, current, roleIDs); err != nil {
		return err
	}
	if err := s.repository.ReplaceUserRoles(ctx, user.ID, roleIDs); err != nil {
		return err
	}
	_, err = s.tokens.DeleteByUser(ctx, user.UserID)
	return err
}

// guardLastSuperAdmin 挡住「把最后一个超级管理员降权」。
// 没有这一条，一次误操作就能让整个管理端再也没人进得去角色配置页。
func (s *service) guardLastSuperAdmin(ctx context.Context, userID int64, current []*repository.ManagerUserRole, next []int64) error {
	superRole, err := s.repository.FindRoleByCode(ctx, SuperAdminCode)
	if repository.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	hadSuper := false
	for _, row := range current {
		if row.RoleID == superRole.ID {
			hadSuper = true
			break
		}
	}
	if !hadSuper {
		return nil
	}
	for _, roleID := range next {
		if roleID == superRole.ID {
			return nil
		}
	}
	total, err := s.repository.UsersByRole(ctx, superRole.ID)
	if err != nil {
		return err
	}
	if total <= 1 {
		return ErrLastSuperAdmin
	}
	return nil
}

func (s *service) ResetPassword(ctx context.Context, req dto.ResetPasswordRequest) error {
	hash, err := hashPassword(req.Password)
	if err != nil {
		return err
	}
	if _, err := s.repository.FindUser(ctx, req.UserID); repository.IsNotFound(err) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	if err := s.repository.UpdateUser(ctx, req.UserID, map[string]any{
		"password_hash": hash, "must_change_password": true,
	}); err != nil {
		return err
	}
	_, err = s.tokens.DeleteByUser(ctx, req.UserID)
	return err
}

func (s *service) SetAccountStatus(ctx context.Context, userID, status string) error {
	if status != StatusDisabled {
		status = StatusActive
	}
	if _, err := s.repository.FindUser(ctx, userID); repository.IsNotFound(err) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	if err := s.repository.UpdateUser(ctx, userID, map[string]any{"status": status}); err != nil {
		return err
	}
	if status != StatusDisabled {
		return nil
	}
	_, err := s.tokens.DeleteByUser(ctx, userID)
	return err
}

func (s *service) DeleteAccount(ctx context.Context, userID string) error {
	user, err := s.repository.FindUser(ctx, userID)
	if repository.IsNotFound(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	current, err := s.repository.ListUserRoles(ctx, user.ID)
	if err != nil {
		return err
	}
	if err := s.guardLastSuperAdmin(ctx, user.ID, current, nil); err != nil {
		return err
	}
	if err := s.repository.DeleteUser(ctx, userID); err != nil {
		return err
	}
	_, err = s.tokens.DeleteByUser(ctx, userID)
	return err
}

// EnsureDefaultAdmin 幂等：用户名已存在直接返回，不会把线上管理员的密码重置回配置值。
func (s *service) EnsureDefaultAdmin(ctx context.Context, username, displayName, password string) error {
	username = strings.TrimSpace(username)
	if _, err := s.repository.FindUserByUsername(ctx, username); err == nil {
		return nil
	} else if !repository.IsNotFound(err) {
		return err
	}
	hash, err := hashPassword(password)
	if err != nil {
		return err
	}
	user := &repository.ManagerUser{
		UserID: "mu_" + newULID(time.Now()), Username: username,
		DisplayName: defaultString(displayName, username), PasswordHash: hash,
		Status: StatusActive, MustChangePassword: true,
	}
	if err := s.repository.CreateUser(ctx, user); err != nil {
		return err
	}
	roleID, err := s.EnsureRole(ctx, SuperAdminCode, "超级管理员", true)
	if err != nil {
		return err
	}
	return s.repository.ReplaceUserRoles(ctx, user.ID, []int64{roleID})
}

func (s *service) accountView(ctx context.Context, row *repository.ManagerUser) (dto.AccountView, error) {
	bindings, err := s.repository.ListUserRoles(ctx, row.ID)
	if err != nil {
		return dto.AccountView{}, err
	}
	roleIDs := make([]int64, 0, len(bindings))
	for _, binding := range bindings {
		roleIDs = append(roleIDs, binding.RoleID)
	}
	refs, err := s.roleRefs(ctx, roleIDs)
	if err != nil {
		return dto.AccountView{}, err
	}
	return dto.AccountView{
		UserID: row.UserID, Username: row.Username, DisplayName: row.DisplayName,
		Status: row.Status, MustChangePassword: row.MustChangePassword, Remark: row.Remark,
		Roles: refs, LastLoginAt: row.LastLoginAt, CreatedTime: row.CreatedTime,
	}, nil
}

func defaultString(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}
