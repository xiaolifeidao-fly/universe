package manager

import (
	"context"
	"sort"
	"strings"

	"service/manager/dto"
	"service/manager/internal/repository"
)

// 权限判定。
//
// shennong 的做法是每个请求查两次库（按 URL 找资源、再查 role_resource）。
// 资源表和授权表都很小（百来行）且极少变，这里改成进程内缓存，鉴权退化成纯内存
// 判断 —— 每个请求只剩一次令牌存储的读。
//
// 缓存一致性靠 TokenStore 里的版本号：本进程写权限直接清，别的实例写了版本号会变，
// 下一次鉴权重建。宁可多重建一次，也不能让撤掉的权限还生效。

// ensureACL 保证缓存是最新的。
func (s *service) ensureACL(ctx context.Context) error {
	version, err := s.tokens.ACLVersion(ctx)
	if err != nil {
		// 版本号读不到不代表权限数据不可信 —— 已经加载过就接着用旧的。
		// 从没加载过则必须真的去查一次，不能放行。
		s.acl.RLock()
		loaded := s.acl.loaded
		s.acl.RUnlock()
		if loaded {
			return nil
		}
		version = 0
	}

	s.acl.RLock()
	fresh := s.acl.loaded && s.acl.version == version
	s.acl.RUnlock()
	if fresh {
		return nil
	}
	return s.reloadACL(ctx, version)
}

func (s *service) reloadACL(ctx context.Context, version int64) error {
	resources, err := s.repository.ListResources(ctx, "", StatusActive)
	if err != nil {
		return err
	}
	roles, err := s.repository.ListRoles(ctx, "")
	if err != nil {
		return err
	}
	bindings, err := s.repository.ListRoleResources(ctx, nil)
	if err != nil {
		return err
	}

	byRoute := make(map[routeKey]int64, len(resources))
	for _, row := range resources {
		if row.ResourceType != ResourceAPI || row.ResourceURL == "" {
			continue
		}
		byRoute[routeKey{Method: normalizeMethod(row.Method), Path: normalizePath(row.ResourceURL)}] = row.ID
	}
	byRole := make(map[int64]map[int64]struct{}, len(roles))
	for _, row := range bindings {
		set, ok := byRole[row.RoleID]
		if !ok {
			set = map[int64]struct{}{}
			byRole[row.RoleID] = set
		}
		set[row.ResourceID] = struct{}{}
	}
	writable := make(map[int64]bool, len(roles))
	superRole := make(map[int64]bool, len(roles))
	for _, row := range roles {
		// 停用的角色一律当不存在：它既不给资源，也不给写权限。
		if row.Status == StatusDisabled {
			continue
		}
		writable[row.ID] = row.Writable
		superRole[row.ID] = row.Code == SuperAdminCode
	}

	s.acl.Lock()
	s.acl.version = version
	s.acl.loaded = true
	s.acl.byRoute = byRoute
	s.acl.byRole = byRole
	s.acl.writable = writable
	s.acl.superRole = superRole
	s.acl.Unlock()
	return nil
}

// invalidateACL 本进程改完权限之后调用：先清本地，再把版本号推给别的实例。
func (s *service) invalidateACL(ctx context.Context) {
	s.acl.Lock()
	s.acl.loaded = false
	s.acl.Unlock()
	_ = s.tokens.BumpACLVersion(ctx)
}

// checkRoute 判断这组角色能不能访问 (method, routePath)。
//
// 三条规则，顺序不能换：
//  1. super_admin 直接放行 —— 一次配错授权就能把所有人关在门外，得留一条活路；
//  2. 路由没在资源表里登记 → 拒。默认拒绝而不是默认放行：忘了登记是配置疏漏，
//     按放行处理等于新接口天生对所有人开放；
//  3. 写方法额外要求角色 writable。
func (s *service) checkRoute(roleIDs []int64, method, routePath string) error {
	s.acl.RLock()
	defer s.acl.RUnlock()

	for _, roleID := range roleIDs {
		if s.acl.superRole[roleID] {
			return nil
		}
	}
	if len(roleIDs) == 0 {
		return ErrNoPermission
	}

	resourceID, ok := s.acl.byRoute[routeKey{Method: normalizeMethod(method), Path: normalizePath(routePath)}]
	if !ok {
		return ErrNoPermission
	}
	granted := false
	for _, roleID := range roleIDs {
		if set, ok := s.acl.byRole[roleID]; ok {
			if _, has := set[resourceID]; has {
				granted = true
				break
			}
		}
	}
	if !granted {
		return ErrNoPermission
	}
	if !isWriteMethod(method) {
		return nil
	}
	for _, roleID := range roleIDs {
		if s.acl.writable[roleID] {
			return nil
		}
	}
	return ErrReadOnlyRole
}

func (s *service) rolesAreSuperAdmin(roleIDs []int64) bool {
	s.acl.RLock()
	defer s.acl.RUnlock()
	for _, roleID := range roleIDs {
		if s.acl.superRole[roleID] {
			return true
		}
	}
	return false
}

func (s *service) rolesCanWrite(roleIDs []int64) bool {
	s.acl.RLock()
	defer s.acl.RUnlock()
	for _, roleID := range roleIDs {
		if s.acl.writable[roleID] {
			return true
		}
	}
	return false
}

// CurrentMenus 按角色过滤后的菜单与页面。
func (s *service) CurrentMenus(ctx context.Context, userID string) ([]dto.ResourceView, error) {
	if err := s.ensureACL(ctx); err != nil {
		return nil, err
	}
	roleIDs, err := s.roleIDsOf(ctx, userID)
	if err != nil {
		return nil, err
	}
	rows, err := s.repository.ListResources(ctx, "", StatusActive)
	if err != nil {
		return nil, err
	}
	menus := make([]*repository.ManagerResource, 0, len(rows))
	for _, row := range rows {
		if row.ResourceType == ResourceMenu || row.ResourceType == ResourceGroup || row.ResourceType == ResourcePage {
			menus = append(menus, row)
		}
	}
	sort.SliceStable(menus, func(i, j int) bool {
		if menus[i].SortID != menus[j].SortID {
			return menus[i].SortID < menus[j].SortID
		}
		return menus[i].ID < menus[j].ID
	})

	if s.rolesAreSuperAdmin(roleIDs) {
		return resourceViews(menus), nil
	}
	if len(roleIDs) == 0 {
		return []dto.ResourceView{}, nil
	}

	authorized := map[int64]struct{}{}
	s.acl.RLock()
	for _, roleID := range roleIDs {
		for resourceID := range s.acl.byRole[roleID] {
			authorized[resourceID] = struct{}{}
		}
	}
	s.acl.RUnlock()

	return resourceViews(withAncestors(menus, authorized)), nil
}

// withAncestors 把授权到的节点连同它的祖先菜单一起留下。
//
// 少了这一步，只授权了叶子页面的角色会拿到一批挂在看不见的父节点下的项 ——
// 前端拼树时找不到父节点，整条分支就消失了，用户看到的是一个空菜单。
func withAncestors(resources []*repository.ManagerResource, authorized map[int64]struct{}) []*repository.ManagerResource {
	byID := make(map[int64]*repository.ManagerResource, len(resources))
	for _, row := range resources {
		byID[row.ID] = row
	}
	included := make(map[int64]struct{}, len(authorized))
	for _, row := range resources {
		if _, ok := authorized[row.ID]; !ok {
			continue
		}
		included[row.ID] = struct{}{}
		for parentID := row.ParentID; parentID > 0; {
			parent, ok := byID[parentID]
			if !ok {
				break
			}
			included[parent.ID] = struct{}{}
			parentID = parent.ParentID
		}
	}
	kept := make([]*repository.ManagerResource, 0, len(included))
	for _, row := range resources {
		if _, ok := included[row.ID]; ok {
			kept = append(kept, row)
		}
	}
	return kept
}

func (s *service) roleIDsOf(ctx context.Context, userID string) ([]int64, error) {
	user, err := s.repository.FindUser(ctx, userID)
	if repository.IsNotFound(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	rows, err := s.repository.ListUserRoles(ctx, user.ID)
	if err != nil {
		return nil, err
	}
	ids := make([]int64, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.RoleID)
	}
	return ids, nil
}

func resourceViews(rows []*repository.ManagerResource) []dto.ResourceView {
	views := make([]dto.ResourceView, 0, len(rows))
	for _, row := range rows {
		views = append(views, dto.ResourceView{
			ID: row.ID, ParentID: row.ParentID, Code: row.Code, Name: row.Name,
			ResourceType: row.ResourceType, Method: row.Method, ResourceURL: row.ResourceURL,
			PageURL: row.PageURL, Icon: row.Icon, SortID: row.SortID, Status: row.Status,
		})
	}
	return views
}

func isWriteMethod(method string) bool {
	switch normalizeMethod(method) {
	case "POST", "PUT", "PATCH", "DELETE":
		return true
	}
	return false
}

func normalizeMethod(method string) string {
	return strings.ToUpper(strings.TrimSpace(method))
}

// normalizePath 去掉尾部斜杠并补上前导斜杠。
// 资源表里存的和 gin 报的路由模板都该是同一个形状，这里兜一次底。
func normalizePath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	if len(path) > 1 {
		path = strings.TrimRight(path, "/")
	}
	return path
}
