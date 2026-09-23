package manager

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"service/manager/internal/repository"
)

// 接口资源与真实路由表的对齐。
//
// 手写一份接口清单和真实路由迟早会分叉，而分叉的后果是「登录用户一律 403」——
// 一个看起来像 bug、其实是配置漏登记的故障。所以接口资源从 engine.Routes() 生成，
// 启动时再比对一次。

// SyncAPIResources 按真实路由表登记接口资源，返回新增或更新了几条。
//
// 幂等：按 code 冲突更新，不重建。重建会换掉资源 id，把角色授权全部作废 ——
// 一次例行的重新初始化就能把所有人的权限清空。
func (s *service) SyncAPIResources(ctx context.Context, routes []RouteRef) (int, error) {
	changed := 0
	for _, route := range routes {
		method := normalizeMethod(route.Method)
		path := normalizePath(route.Path)
		if method == "" || path == "" || method == "HEAD" || method == "OPTIONS" {
			continue
		}
		row := &repository.ManagerResource{
			ParentID: 0, Code: APIResourceCode(method, path),
			Name:         method + " " + path,
			ResourceType: ResourceAPI, Method: method, ResourceURL: path,
			Status: StatusActive,
		}
		if err := s.repository.UpsertResourceByCode(ctx, row); err != nil {
			return changed, err
		}
		changed++
	}
	s.invalidateACL(ctx)
	return changed, nil
}

// UnregisteredRoutes 启动自检：返回没在资源表里登记的路由。
//
// 没有它，新增接口忘了登记要等到有人点了才 403，而且从现象上看不出是配置疏漏
// 还是代码 bug。
func (s *service) UnregisteredRoutes(ctx context.Context, routes []RouteRef) ([]RouteRef, error) {
	rows, err := s.repository.ListResources(ctx, ResourceAPI, "")
	if err != nil {
		return nil, err
	}
	known := make(map[routeKey]struct{}, len(rows))
	for _, row := range rows {
		known[routeKey{Method: normalizeMethod(row.Method), Path: normalizePath(row.ResourceURL)}] = struct{}{}
	}
	missing := make([]RouteRef, 0)
	for _, route := range routes {
		method := normalizeMethod(route.Method)
		path := normalizePath(route.Path)
		if method == "" || path == "" || method == "HEAD" || method == "OPTIONS" {
			continue
		}
		if _, ok := known[routeKey{Method: method, Path: path}]; !ok {
			missing = append(missing, RouteRef{Method: method, Path: path})
		}
	}
	sort.Slice(missing, func(i, j int) bool {
		if missing[i].Path != missing[j].Path {
			return missing[i].Path < missing[j].Path
		}
		return missing[i].Method < missing[j].Method
	})
	return missing, nil
}

// APIResourceCode 接口资源的稳定编码。
//
// 必须只由 (method, path) 决定：换个算法就等于换掉所有接口资源的 code，
// 下一次 SyncAPIResources 会插出一整套新资源，旧授权全部指向孤儿记录。
func APIResourceCode(method, path string) string {
	normalized := strings.ReplaceAll(strings.Trim(normalizePath(path), "/"), "/", ".")
	normalized = strings.ReplaceAll(normalized, ":", "")
	normalized = strings.ReplaceAll(normalized, "*", "")
	return fmt.Sprintf("api.%s.%s", strings.ToLower(normalizeMethod(method)), normalized)
}

// GrantRoleByCode 按资源编码给角色授权，供初始化命令用。
// 已有的授权保留 —— 初始化不该把管理员在后台调过的权限抹掉。
func (s *service) GrantRoleByCode(ctx context.Context, roleCode string, resourceCodes []string) error {
	role, err := s.repository.FindRoleByCode(ctx, roleCode)
	if repository.IsNotFound(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	wanted, err := s.repository.ListResourceCodes(ctx, resourceCodes)
	if err != nil {
		return err
	}
	existing, err := s.repository.ListRoleResources(ctx, []int64{role.ID})
	if err != nil {
		return err
	}
	merged := make(map[int64]struct{}, len(existing)+len(wanted))
	for _, row := range existing {
		merged[row.ResourceID] = struct{}{}
	}
	for _, id := range wanted {
		merged[id] = struct{}{}
	}
	ids := make([]int64, 0, len(merged))
	for id := range merged {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	if err := s.repository.ReplaceRoleResources(ctx, role.ID, ids); err != nil {
		return err
	}
	s.invalidateACL(ctx)
	return nil
}
