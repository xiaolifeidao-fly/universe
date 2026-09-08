package manager

import (
	"context"
	"strings"

	"service/manager/dto"
	"service/manager/internal/repository"
)

// 角色与资源的后台维护。每个写操作结束都要 invalidateACL —— 漏掉一处，
// 撤销的权限会在缓存过期前一直生效。

func (s *service) ListRoles(ctx context.Context) ([]dto.RoleView, error) {
	rows, err := s.repository.ListRoles(ctx, "")
	if err != nil {
		return nil, err
	}
	views := make([]dto.RoleView, 0, len(rows))
	for _, row := range rows {
		count, err := s.repository.UsersByRole(ctx, row.ID)
		if err != nil {
			return nil, err
		}
		views = append(views, dto.RoleView{
			ID: row.ID, Code: row.Code, Name: row.Name, Writable: row.Writable,
			Status: row.Status, Remark: row.Remark, UserCount: count, CreatedTime: row.CreatedTime,
		})
	}
	return views, nil
}

func (s *service) SaveRole(ctx context.Context, req dto.SaveRoleRequest) (dto.RoleView, error) {
	code := strings.TrimSpace(req.Code)
	status := req.Status
	if status != StatusDisabled {
		status = StatusActive
	}
	if req.ID == 0 {
		if _, err := s.repository.FindRoleByCode(ctx, code); err == nil {
			return dto.RoleView{}, ErrRoleCodeTaken
		} else if !repository.IsNotFound(err) {
			return dto.RoleView{}, err
		}
		row := &repository.ManagerRole{
			Code: code, Name: req.Name, Writable: req.Writable,
			Status: status, Remark: truncate(req.Remark, 256),
		}
		if err := s.repository.CreateRole(ctx, row); err != nil {
			return dto.RoleView{}, err
		}
		s.invalidateACL(ctx)
		return dto.RoleView{ID: row.ID, Code: row.Code, Name: row.Name, Writable: row.Writable,
			Status: row.Status, Remark: row.Remark, CreatedTime: row.CreatedTime}, nil
	}

	existing, err := s.repository.FindRole(ctx, req.ID)
	if repository.IsNotFound(err) {
		return dto.RoleView{}, ErrNotFound
	}
	if err != nil {
		return dto.RoleView{}, err
	}
	// super_admin 的编码不能改：checkRoute 靠这个字符串认出「绕过资源过滤」的角色，
	// 改掉它等于让所有人一起被关在门外。
	if existing.Code == SuperAdminCode && code != SuperAdminCode {
		return dto.RoleView{}, ErrRoleCodeTaken
	}
	if !strings.EqualFold(existing.Code, code) {
		if _, err := s.repository.FindRoleByCode(ctx, code); err == nil {
			return dto.RoleView{}, ErrRoleCodeTaken
		} else if !repository.IsNotFound(err) {
			return dto.RoleView{}, err
		}
	}
	if err := s.repository.UpdateRole(ctx, req.ID, map[string]any{
		"code": code, "name": req.Name, "writable": req.Writable,
		"status": status, "remark": truncate(req.Remark, 256),
	}); err != nil {
		return dto.RoleView{}, err
	}
	s.invalidateACL(ctx)
	if err := s.kickRoleMembers(ctx, req.ID); err != nil {
		return dto.RoleView{}, err
	}
	updated, err := s.repository.FindRole(ctx, req.ID)
	if err != nil {
		return dto.RoleView{}, err
	}
	count, err := s.repository.UsersByRole(ctx, req.ID)
	if err != nil {
		return dto.RoleView{}, err
	}
	return dto.RoleView{ID: updated.ID, Code: updated.Code, Name: updated.Name, Writable: updated.Writable,
		Status: updated.Status, Remark: updated.Remark, UserCount: count, CreatedTime: updated.CreatedTime}, nil
}

func (s *service) DeleteRole(ctx context.Context, id int64) error {
	row, err := s.repository.FindRole(ctx, id)
	if repository.IsNotFound(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if row.Code == SuperAdminCode {
		return ErrLastSuperAdmin
	}
	if err := s.kickRoleMembers(ctx, id); err != nil {
		return err
	}
	if err := s.repository.DeleteRole(ctx, id); err != nil {
		return err
	}
	s.invalidateACL(ctx)
	return nil
}

// kickRoleMembers 角色一变就踢掉它下面所有人的会话。
// 角色 id 写在令牌会话里，不踢的话降权要等到令牌过期才生效。
func (s *service) kickRoleMembers(ctx context.Context, roleID int64) error {
	members, err := s.repository.ListUserIDsByRole(ctx, roleID)
	if err != nil {
		return err
	}
	for _, userID := range members {
		if _, err := s.tokens.DeleteByUser(ctx, userID); err != nil {
			return err
		}
	}
	return nil
}

// ---------- 资源 ----------

func (s *service) ListResources(ctx context.Context, resourceType string) ([]dto.ResourceView, error) {
	rows, err := s.repository.ListResources(ctx, resourceType, "")
	if err != nil {
		return nil, err
	}
	return resourceViews(rows), nil
}

func (s *service) SaveResource(ctx context.Context, req dto.SaveResourceRequest) (dto.ResourceView, error) {
	status := req.Status
	if status != StatusDisabled {
		status = StatusActive
	}
	row := &repository.ManagerResource{
		ID: req.ID, ParentID: req.ParentID, Code: strings.TrimSpace(req.Code), Name: req.Name,
		ResourceType: req.ResourceType, Method: normalizeMethod(req.Method),
		ResourceURL: normalizePath(req.ResourceURL), PageURL: normalizePath(req.PageURL),
		Icon: req.Icon, SortID: req.SortID, Status: status,
	}
	if req.ID == 0 {
		if err := s.repository.CreateResource(ctx, row); err != nil {
			return dto.ResourceView{}, err
		}
	} else {
		if _, err := s.repository.FindResource(ctx, req.ID); repository.IsNotFound(err) {
			return dto.ResourceView{}, ErrNotFound
		} else if err != nil {
			return dto.ResourceView{}, err
		}
		if err := s.repository.UpdateResource(ctx, req.ID, map[string]any{
			"parent_id": row.ParentID, "code": row.Code, "name": row.Name,
			"resource_type": row.ResourceType, "method": row.Method,
			"resource_url": row.ResourceURL, "page_url": row.PageURL,
			"icon": row.Icon, "sort_id": row.SortID, "status": row.Status,
		}); err != nil {
			return dto.ResourceView{}, err
		}
	}
	s.invalidateACL(ctx)
	return resourceViews([]*repository.ManagerResource{row})[0], nil
}

func (s *service) DeleteResource(ctx context.Context, id int64) error {
	if _, err := s.repository.FindResource(ctx, id); repository.IsNotFound(err) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	if err := s.repository.DeleteResource(ctx, id); err != nil {
		return err
	}
	s.invalidateACL(ctx)
	return nil
}

func (s *service) ListRoleResourceIDs(ctx context.Context, roleID int64) ([]int64, error) {
	rows, err := s.repository.ListRoleResources(ctx, []int64{roleID})
	if err != nil {
		return nil, err
	}
	ids := make([]int64, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ResourceID)
	}
	return ids, nil
}

func (s *service) SaveRoleResources(ctx context.Context, req dto.SaveRoleResourceRequest) error {
	if _, err := s.repository.FindRole(ctx, req.RoleID); repository.IsNotFound(err) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	if err := s.repository.ReplaceRoleResources(ctx, req.RoleID, req.ResourceIDs); err != nil {
		return err
	}
	s.invalidateACL(ctx)
	// 授权变了同样要踢会话 —— 缓存清了，但那个人手里的令牌还带着旧角色，
	// 而权限是按角色算的，所以这里踢的是「让新授权立刻被算一遍」。
	return s.kickRoleMembers(ctx, req.RoleID)
}

// EnsureRole 幂等地保证一个角色存在，返回它的 id。给初始化命令用。
func (s *service) EnsureRole(ctx context.Context, code, name string, writable bool) (int64, error) {
	row, err := s.repository.FindRoleByCode(ctx, code)
	if err == nil {
		return row.ID, nil
	}
	if !repository.IsNotFound(err) {
		return 0, err
	}
	created := &repository.ManagerRole{Code: code, Name: name, Writable: writable, Status: StatusActive}
	if err := s.repository.CreateRole(ctx, created); err != nil {
		return 0, err
	}
	s.invalidateACL(ctx)
	return created.ID, nil
}
