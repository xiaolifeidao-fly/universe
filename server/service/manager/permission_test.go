package manager

import (
	"testing"

	"service/manager/internal/repository"
)

// aclFixture 直接摆好缓存，不碰数据库 —— 这几条规则是纯判断，
// 拿真库跑只会把「规则错了」和「查询错了」混在一起。
func aclFixture() *service {
	svc := &service{}
	svc.acl.loaded = true
	svc.acl.byRoute = map[routeKey]int64{
		{Method: "GET", Path: "/api/users"}:       1,
		{Method: "POST", Path: "/api/users"}:      2,
		{Method: "GET", Path: "/api/users/:id"}:   3,
		{Method: "POST", Path: "/api/galaxy/ban"}: 4,
	}
	svc.acl.byRole = map[int64]map[int64]struct{}{
		10: {1: {}, 2: {}, 3: {}, 4: {}}, // operator：全给
		20: {1: {}, 3: {}},               // viewer：只有两个读接口
		30: {1: {}, 2: {}},               // 有写资源但角色只读
	}
	svc.acl.writable = map[int64]bool{10: true, 20: false, 30: false}
	svc.acl.superRole = map[int64]bool{99: true}
	return svc
}

func TestCheckRouteDeniesUnregisteredRoute(t *testing.T) {
	svc := aclFixture()
	// 没登记的路由默认拒绝。按放行处理的话，新增接口天生对所有登录用户开放 ——
	// 一个忘了登记的漏洞会安静地存在到有人发现为止。
	if err := svc.checkRoute([]int64{10}, "GET", "/api/secret"); err != ErrNoPermission {
		t.Fatalf("未登记的路由应当拒绝，实际 %v", err)
	}
}

func TestCheckRouteSuperAdminBypassesEverything(t *testing.T) {
	svc := aclFixture()
	// 超级管理员连没登记的路由都放行：一次配错授权就能把所有人关在门外，
	// 必须留一条改回来的活路。
	for _, route := range [][2]string{
		{"GET", "/api/users"}, {"POST", "/api/galaxy/ban"}, {"DELETE", "/api/anything"},
	} {
		if err := svc.checkRoute([]int64{99}, route[0], route[1]); err != nil {
			t.Fatalf("超级管理员应当放行 %s %s，实际 %v", route[0], route[1], err)
		}
	}
}

func TestCheckRouteSeparatesReadFromWriteOnSamePath(t *testing.T) {
	svc := aclFixture()
	// 这条是加 method 的全部理由：同一路径的 GET 和 POST 必须分得开。
	if err := svc.checkRoute([]int64{20}, "GET", "/api/users"); err != nil {
		t.Fatalf("viewer 应当读得到用户列表，实际 %v", err)
	}
	if err := svc.checkRoute([]int64{20}, "POST", "/api/users"); err != ErrNoPermission {
		t.Fatalf("viewer 没有 POST 资源，应当拒绝，实际 %v", err)
	}
}

func TestCheckRouteWritableIsSecondGate(t *testing.T) {
	svc := aclFixture()
	// 角色 30 有 POST /api/users 这条资源，但整体只读 —— 两道门叠加，
	// 少了 writable 这一道就配不出「这个角色临时只读」。
	if err := svc.checkRoute([]int64{30}, "GET", "/api/users"); err != nil {
		t.Fatalf("只读角色仍应读得到，实际 %v", err)
	}
	if err := svc.checkRoute([]int64{30}, "POST", "/api/users"); err != ErrReadOnlyRole {
		t.Fatalf("只读角色的写操作应当被 writable 挡住，实际 %v", err)
	}
}

func TestCheckRouteNoRoleIsDenied(t *testing.T) {
	svc := aclFixture()
	// 一个角色都没有 = 什么都进不去。空切片被当成「不过滤」就是越权。
	if err := svc.checkRoute(nil, "GET", "/api/users"); err != ErrNoPermission {
		t.Fatalf("没有角色应当拒绝，实际 %v", err)
	}
}

func TestCheckRouteMatchesRouteTemplateNotConcretePath(t *testing.T) {
	svc := aclFixture()
	// 资源表里存的是 gin 的路由模板。传具体路径进来会匹配不上 ——
	// 这条钉住「中间件必须传 c.FullPath()」这个前提。
	if err := svc.checkRoute([]int64{10}, "GET", "/api/users/:id"); err != nil {
		t.Fatalf("模板应当匹配，实际 %v", err)
	}
	if err := svc.checkRoute([]int64{10}, "GET", "/api/users/7"); err != ErrNoPermission {
		t.Fatalf("具体路径不该匹配到模板资源，实际 %v", err)
	}
}

func TestCheckRouteIsCaseAndSlashInsensitive(t *testing.T) {
	svc := aclFixture()
	if err := svc.checkRoute([]int64{10}, "get", "/api/users/"); err != nil {
		t.Fatalf("方法大小写与尾斜杠不该影响判定，实际 %v", err)
	}
}

// TestWithAncestorsKeepsParentMenus 只授权了叶子页面时，祖先菜单必须一起返回。
// 少了它，前端拼树找不到父节点，整条分支在菜单里消失 —— 用户看到的是一片空白，
// 而权限其实是给了的。
func TestWithAncestorsKeepsParentMenus(t *testing.T) {
	resources := []*repository.ManagerResource{
		{ID: 1, ParentID: 0, ResourceType: ResourceMenu, Name: "系统"},
		{ID: 2, ParentID: 1, ResourceType: ResourceMenu, Name: "权限"},
		{ID: 3, ParentID: 2, ResourceType: ResourcePage, Name: "角色"},
		{ID: 4, ParentID: 0, ResourceType: ResourcePage, Name: "仪表盘"},
	}
	kept := withAncestors(resources, map[int64]struct{}{3: {}})
	if len(kept) != 3 {
		t.Fatalf("应当留下叶子加两级祖先，实际 %d 条", len(kept))
	}
	ids := map[int64]bool{}
	for _, row := range kept {
		ids[row.ID] = true
	}
	for _, want := range []int64{1, 2, 3} {
		if !ids[want] {
			t.Fatalf("缺少资源 %d，实际 %v", want, ids)
		}
	}
	if ids[4] {
		t.Fatal("没授权的同级页面不该出现")
	}
}

func TestWithAncestorsDropsEverythingWhenNothingGranted(t *testing.T) {
	resources := []*repository.ManagerResource{
		{ID: 1, ParentID: 0, ResourceType: ResourceMenu},
		{ID: 2, ParentID: 1, ResourceType: ResourcePage},
	}
	if kept := withAncestors(resources, map[int64]struct{}{}); len(kept) != 0 {
		t.Fatalf("没有授权就不该留下任何菜单，实际 %d 条", len(kept))
	}
}

// TestAPIResourceCodeIsStable 编码只能由 (method, path) 决定。
// 换算法等于换掉所有接口资源的 code，下一次同步会插出一整套新资源，
// 旧授权全部指向孤儿记录 —— 表面上权限还在，实际全空。
func TestAPIResourceCodeIsStable(t *testing.T) {
	cases := []struct{ method, path, want string }{
		{"GET", "/api/users", "api.get.api.users"},
		{"POST", "/api/users/:id/delete", "api.post.api.users.id.delete"},
		{"get", "/api/users/", "api.get.api.users"},
	}
	for _, item := range cases {
		if got := APIResourceCode(item.method, item.path); got != item.want {
			t.Fatalf("%s %s 的编码应为 %s，实际 %s", item.method, item.path, item.want, got)
		}
	}
}

func TestIsWriteMethod(t *testing.T) {
	for _, method := range []string{"POST", "put", "PATCH", "delete"} {
		if !isWriteMethod(method) {
			t.Fatalf("%s 应当算写操作", method)
		}
	}
	for _, method := range []string{"GET", "head", "OPTIONS"} {
		if isWriteMethod(method) {
			t.Fatalf("%s 不该算写操作", method)
		}
	}
}
