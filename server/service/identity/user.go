// 控制台账号的增删改查，以及实体到视图的转换。

package identity

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"service/identity/dto"
	"service/identity/internal/repository"
)

func (s *service) CurrentUser(ctx context.Context, id int64) (dto.UserView, error) {
	return s.GetUser(ctx, id)
}

func (s *service) ListUsers(ctx context.Context, query dto.UserQuery) (dto.UserPage, error) {
	rows, total, err := s.repo.ListUsers(ctx, repository.UserQuery{Keyword: strings.TrimSpace(query.Keyword), Role: query.Role, Persona: query.Persona, Status: query.Status, Offset: query.Offset(), Limit: query.Limit()})
	if err != nil {
		return dto.UserPage{}, err
	}
	views := make([]dto.UserView, 0, len(rows))
	for _, row := range rows {
		view, err := s.toUserView(ctx, row)
		if err != nil {
			return dto.UserPage{}, err
		}
		views = append(views, view)
	}
	return dto.UserPage{Total: total, Data: views}, nil
}

func (s *service) ListMembers(ctx context.Context, query dto.MemberQuery) ([]dto.MemberView, error) {
	rows, _, err := s.repo.ListUsers(ctx, repository.UserQuery{
		Keyword: strings.TrimSpace(query.Keyword),
		Status:  "active",
		Offset:  0,
		Limit:   200,
	})
	if err != nil {
		return nil, err
	}
	members := make([]dto.MemberView, 0, len(rows))
	for _, row := range rows {
		members = append(members, dto.MemberView{
			ID:          strconv.FormatInt(row.ID, 10),
			Username:    row.Username,
			DisplayName: row.DisplayName,
		})
	}
	return members, nil
}

func (s *service) GetUser(ctx context.Context, id int64) (dto.UserView, error) {
	if id <= 0 {
		return dto.UserView{}, errors.New("缺少用户标识")
	}
	user, err := s.repo.FindUser(ctx, id)
	if err != nil {
		return dto.UserView{}, translate(err)
	}
	return s.toUserView(ctx, user)
}

func (s *service) SaveUser(ctx context.Context, req dto.SaveUserRequest) (dto.UserView, error) {
	username := strings.TrimSpace(req.Username)
	displayName := strings.TrimSpace(req.DisplayName)
	if username == "" || displayName == "" {
		return dto.UserView{}, errors.New("用户名和显示名不能为空")
	}
	if !validRole(req.Role) || !validStatus(req.Status) {
		return dto.UserView{}, errors.New("用户角色或状态无效")
	}
	personas, err := normalizePersonas(req.Personas, req.Persona)
	if err != nil {
		return dto.UserView{}, err
	}
	// 管理员是系统管理权限，必须同时具备产品产研身份。业务方和产品
	// 产研可以并存；拥有两者的管理员仍可进入系统管理和两类工作台。
	if req.Role == RoleAdmin && !hasPersona(personas, PersonaProductResearch) {
		return dto.UserView{}, errors.New("管理员必须具备产品产研身份")
	}
	bizLines, programs, err := normalizeAssignments(req.BizLines, req.Programs)
	if err != nil {
		return dto.UserView{}, err
	}
	if err := s.validatePrograms(ctx, programs); err != nil {
		return dto.UserView{}, err
	}

	if req.ID == 0 {
		if req.Password == "" {
			return dto.UserView{}, errors.New("新用户必须设置密码")
		}
		if _, err := s.repo.FindUserByUsername(ctx, username); err == nil {
			return dto.UserView{}, errors.New("用户名已存在")
		} else if !repository.IsNotFound(err) {
			return dto.UserView{}, err
		}
		hash, err := hashPassword(req.Password)
		if err != nil {
			return dto.UserView{}, err
		}
		user := &repository.IdentityUser{Username: username, DisplayName: displayName, PasswordHash: hash, Role: req.Role, Persona: personaStorage(personas), Status: req.Status, MustChangePassword: true, TokenVersion: 1}
		if err := s.repo.CreateUser(ctx, user); err != nil {
			return dto.UserView{}, err
		}
		if err := s.repo.ReplaceAssignments(ctx, user.ID, bizLines, programs); err != nil {
			return dto.UserView{}, err
		}
		return s.toUserView(ctx, user)
	}

	user, err := s.repo.FindUser(ctx, req.ID)
	if err != nil {
		return dto.UserView{}, translate(err)
	}
	if user.Username != username {
		if other, findErr := s.repo.FindUserByUsername(ctx, username); findErr == nil && other.ID != user.ID {
			return dto.UserView{}, errors.New("用户名已存在")
		} else if findErr != nil && !repository.IsNotFound(findErr) {
			return dto.UserView{}, findErr
		}
	}
	// 允许管理员停用或降级自己，但整个系统必须至少还留一个启用的管理员。
	if user.Role == RoleAdmin && user.Status == StatusActive && (req.Role != RoleAdmin || req.Status != StatusActive) {
		admins, countErr := s.repo.CountActiveAdmins(ctx)
		if countErr != nil {
			return dto.UserView{}, countErr
		}
		if admins <= 1 {
			return dto.UserView{}, errors.New("至少保留一个启用的管理员")
		}
	}
	user.Username, user.DisplayName, user.Role, user.Persona, user.Status = username, displayName, req.Role, personaStorage(personas), req.Status
	if strings.TrimSpace(req.Password) != "" {
		user.PasswordHash, err = hashPassword(req.Password)
		if err != nil {
			return dto.UserView{}, err
		}
		user.TokenVersion++
		user.MustChangePassword = true
	}
	if err := s.repo.UpdateUser(ctx, user); err != nil {
		return dto.UserView{}, err
	}
	if err := s.repo.ReplaceAssignments(ctx, user.ID, bizLines, programs); err != nil {
		return dto.UserView{}, err
	}
	return s.toUserView(ctx, user)
}

func (s *service) DeleteUser(ctx context.Context, userID int64, actorID string) error {
	if userID <= 0 {
		return errors.New("缺少用户标识")
	}
	if strconv.FormatInt(userID, 10) == actorID {
		return errors.New("不能删除当前登录管理员")
	}
	user, err := s.repo.FindUser(ctx, userID)
	if err != nil {
		return translate(err)
	}
	if user.Role == RoleAdmin && user.Status == StatusActive {
		admins, err := s.repo.CountActiveAdmins(ctx)
		if err != nil {
			return err
		}
		if admins <= 1 {
			return errors.New("至少保留一个启用的管理员")
		}
	}
	return translate(s.repo.DeleteUser(ctx, userID))
}

func (s *service) EnsureDefaultAdmin(ctx context.Context, username, displayName, password string) error {
	if _, err := s.repo.FindUserByUsername(ctx, username); err == nil {
		return nil
	} else if !repository.IsNotFound(err) {
		return err
	}
	hash, err := hashPassword(password)
	if err != nil {
		return err
	}
	return s.repo.CreateUser(ctx, &repository.IdentityUser{Username: username, DisplayName: displayName, PasswordHash: hash, Role: RoleAdmin, Persona: PersonaProductResearch, Status: StatusActive, MustChangePassword: true, TokenVersion: 1})
}

func (s *service) toUserView(ctx context.Context, user *repository.IdentityUser) (dto.UserView, error) {
	bizLineRows, err := s.repo.ListBizLineAssignments(ctx, user.ID)
	if err != nil {
		return dto.UserView{}, err
	}
	programRows, err := s.repo.ListPrograms(ctx, user.ID)
	if err != nil {
		return dto.UserView{}, err
	}
	bizLines := make([]string, 0, len(bizLineRows))
	writableBizLines := make([]string, 0, len(bizLineRows))
	managedBizLines := make([]string, 0, len(bizLineRows))
	for _, row := range bizLineRows {
		bizLines = append(bizLines, row.BizLine)
		if row.CanWrite || row.IsManager {
			writableBizLines = append(writableBizLines, row.BizLine)
		}
		if row.IsManager {
			managedBizLines = append(managedBizLines, row.BizLine)
		}
	}
	programs := make([]dto.ProgramScope, 0, len(programRows))
	managedPrograms := make([]dto.ProgramScope, 0, len(programRows))
	for _, row := range programRows {
		scope := dto.ProgramScope{BizLine: row.BizLine, ProgramID: row.ProgramID}
		programs = append(programs, scope)
		if row.IsManager {
			managedPrograms = append(managedPrograms, scope)
		}
	}
	personas := personasOf(user.Persona)
	return dto.UserView{ID: user.ID, Username: user.Username, DisplayName: user.DisplayName, Role: user.Role, Persona: personas[0], Personas: personas, Status: user.Status, MustChangePassword: user.MustChangePassword, BizLines: bizLines, WritableBizLines: writableBizLines, ManagedBizLines: managedBizLines, Programs: programs, ManagedPrograms: managedPrograms, LastLoginAt: user.LastLoginAt, UpdatedAt: timePtr(user.UpdatedTime), CreatedAt: timePtr(user.CreatedTime)}, nil
}
