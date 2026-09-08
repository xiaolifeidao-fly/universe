// managerseed 打印一份可以直接在 MySQL 上执行的初始化 SQL：三个默认角色、
// 全部资源（页面手写、接口从真实路由表生成）、一个超级管理员账号，以及授权。
//
// 它和 cmd/managerinit 做的是同一件事，出口不同：managerinit 直接写库，
// 这个只把 SQL 打到标准输出，给「变更以 SQL 形式提交给 DBA / 在远端库上手工执行」
// 的流程用。两者共用同一份路由表与资源编码算法，所以不会分叉。
//
// 用法（在 server/manager-api 下）：
//
//	go run ./cmd/managerseed -username admin -password '你的初始密码' > /tmp/manager_seed.sql
//
// 不连数据库、不读配置：路由表是把 handler 注册一遍拿到的，服务实例传 nil ——
// 注册阶段只把接口存下来，不会调用它们。
package main

import (
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"

	"manager-api/routers"
	"service/manager"
)

// 页面资源。手写的这一份是 UI 结构，从路由表推导不出来。
// code 同时是前端取 i18n 文案的键（t("nav." + code)）。
var pages = []struct {
	Code, Name, Parent, PageURL, Icon string
	Type                              string
	SortID                            int
}{
	{Code: "dashboard", Name: "仪表盘", PageURL: "/dashboard", Icon: "DashboardOutlined", Type: manager.ResourcePage, SortID: 10},
	{Code: "users", Name: "用户管理", PageURL: "/users", Icon: "TeamOutlined", Type: manager.ResourcePage, SortID: 20},
	{Code: "businessLines", Name: "业务线管理", PageURL: "/business-lines", Icon: "BranchesOutlined", Type: manager.ResourcePage, SortID: 30},
	{Code: "programs", Name: "项目管理", PageURL: "/programs", Icon: "FolderOutlined", Type: manager.ResourcePage, SortID: 40},
	{Code: "galaxy", Name: "共享算力池", PageURL: "/galaxy", Icon: "GlobalOutlined", Type: manager.ResourcePage, SortID: 50},
	{Code: "settings", Name: "系统设置", Icon: "SettingOutlined", Type: manager.ResourceMenu, SortID: 90},
	{Code: "settingsAccounts", Name: "管理端账号", Parent: "settings", PageURL: "/settings/accounts", Type: manager.ResourcePage, SortID: 91},
	{Code: "settingsRoles", Name: "角色与权限", Parent: "settings", PageURL: "/settings/roles", Type: manager.ResourcePage, SortID: 92},
}

// operatorPages 运营看得到的页面：不含系统设置。
// 一个能改角色授权的角色，和超级管理员就没有区别了。
var operatorPages = []string{"dashboard", "users", "businessLines", "programs", "galaxy"}

func main() {
	username := flag.String("username", "admin", "超级管理员用户名")
	displayName := flag.String("display-name", "Administrator", "显示名")
	password := flag.String("password", "", "初始密码，至少 8 位；账号建出来是「必须改密」状态")
	flag.Parse()

	if len(*password) < 8 {
		fmt.Fprintln(os.Stderr, "需要 -password，且至少 8 个字符")
		os.Exit(2)
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(*password), bcrypt.DefaultCost)
	if err != nil {
		fmt.Fprintf(os.Stderr, "生成密码哈希失败: %v\n", err)
		os.Exit(1)
	}

	gin.SetMode(gin.ReleaseMode)
	// 服务实例全传 nil：注册路由只把接口存进 handler，不会调用它们。
	engine, err := routers.New(nil, nil, nil, nil, nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "装配路由失败: %v\n", err)
		os.Exit(1)
	}

	var out strings.Builder
	writeHeader(&out, *username)
	writeRoles(&out)
	writePages(&out)
	apis := writeAPIs(&out, routers.Routes(engine))
	writeAdmin(&out, *username, *displayName, string(hash))
	writeGrants(&out, apis)
	writeFooter(&out)
	fmt.Print(out.String())
}

func writeHeader(out *strings.Builder, username string) {
	fmt.Fprintf(out, `-- =========================================================================
-- 管理端初始化数据 · zt_manager_*
--
-- 由 manager-api/cmd/managerseed 生成于 %s，不要手改 ——
-- 接口资源是从真实路由表导出的，手改会和代码分叉，而分叉的现象是
-- 「登录用户一律 403」，看起来像 bug 其实是配置漏登记。
--
-- 前置：先执行 server/manager.sql 建表。
-- 幂等：反复执行安全。角色、资源、账号都按业务键去重；已存在的记录不会被覆盖，
--       所以**不会**把线上改过的密码或授权重置回来。
--
-- 执行完之后用 %s 登录，首次登录会被强制要求改密码。
-- =========================================================================

`, time.Now().Format("2006-01-02"), username)
}

func writeRoles(out *strings.Builder) {
	out.WriteString(`-- ---------------------------------------------------------------------
-- 1. 角色
--
-- writable 是角色级的读写总开关，和资源授权叠加：写操作两道门都得过。
-- 只有资源授权配不出「这个角色临时只读」（要逐条撤销写资源）；
-- 只有 writable 配不出「能改用户、不能封节点」。
--
-- super_admin 绕过资源过滤 —— 一次配错授权就能把所有人关在门外，
-- 必须留一条改回来的活路。它不需要任何 role_resource 记录。
-- ---------------------------------------------------------------------

`)
	roles := []struct {
		Code, Name, Remark string
		Writable           int
	}{
		{"super_admin", "超级管理员", "绕过资源过滤，看得到也改得了全部", 1},
		{"operator", "运营", "日常运营：五个业务页面可读可写，不含系统设置", 1},
		{"viewer", "只读", "所有页面只读；任何写操作都会被 writable 挡下", 0},
	}
	for _, role := range roles {
		fmt.Fprintf(out, "INSERT INTO zt_manager_role (code, name, writable, status, remark, created_time, updated_time)\nSELECT %s, %s, %d, 'active', %s, NOW(3), NOW(3)\nFROM DUAL\nWHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_role WHERE code = %s) AS t);\n",
			quote(role.Code), quote(role.Name), role.Writable, quote(role.Remark), quote(role.Code))
	}
	out.WriteString("\n")
}

func writePages(out *strings.Builder) {
	out.WriteString(`-- ---------------------------------------------------------------------
-- 2. 页面与菜单资源
--
-- code 是稳定标识：前端按 t("nav." + code) 取 i18n 文案，改它等于改文案键。
-- 分两步插：先插顶层，再插子页面（parent_id 要引用刚插进去的菜单 id）。
-- ---------------------------------------------------------------------

`)
	for _, page := range pages {
		if page.Parent != "" {
			continue
		}
		writeResourceInsert(out, page.Code, page.Name, page.Type, "", "", page.PageURL, page.Icon, page.SortID, "")
	}
	out.WriteString("\n-- 子页面：parent_id 按 code 反查，不写死自增 id。\n\n")
	for _, page := range pages {
		if page.Parent == "" {
			continue
		}
		writeResourceInsert(out, page.Code, page.Name, page.Type, "", "", page.PageURL, page.Icon, page.SortID, page.Parent)
	}
	out.WriteString("\n")
}

// writeAPIs 按真实路由表写接口资源，返回 (code, method) 便于后面按方法授权。
func writeAPIs(out *strings.Builder, routes []manager.RouteRef) []apiResource {
	seen := map[string]bool{}
	items := make([]apiResource, 0, len(routes))
	for _, route := range routes {
		method := strings.ToUpper(strings.TrimSpace(route.Method))
		path := normalizePath(route.Path)
		// OPTIONS / HEAD 不进资源表：中间件对它们直接放行（预检请求带不了令牌）。
		if method == "" || path == "" || method == "OPTIONS" || method == "HEAD" {
			continue
		}
		// /healthz 不在 /api 下，不走鉴权中间件。
		if !strings.HasPrefix(path, "/api/") {
			continue
		}
		code := manager.APIResourceCode(method, path)
		if seen[code] {
			continue
		}
		seen[code] = true
		items = append(items, apiResource{Code: code, Method: method, Path: path})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Path != items[j].Path {
			return items[i].Path < items[j].Path
		}
		return items[i].Method < items[j].Method
	})

	fmt.Fprintf(out, `-- ---------------------------------------------------------------------
-- 3. 接口资源（%d 条，从 gin 路由表导出）
--
-- resource_url 存的是**路由模板**（/api/users/:id），不是具体请求路径 ——
-- 中间件拿 c.FullPath() 来比对，否则每个 id 都要在表里占一行。
--
-- method 参与身份认定：同一路径的 GET 和 POST 是两条独立资源，
-- 这样才配得出「能看用户列表、不能改用户」。
--
-- 公开路由（POST /api/auth/login）也在表里，但中间件在白名单阶段就放行了，
-- 不会走到资源判断 —— 留着它是为了后台能看到这条路由存在。
-- ---------------------------------------------------------------------

`, len(items))
	for _, item := range items {
		writeResourceInsert(out, item.Code, item.Method+" "+item.Path, manager.ResourceAPI,
			item.Method, item.Path, "", "", 0, "")
	}
	out.WriteString("\n")
	return items
}

func writeAdmin(out *strings.Builder, username, displayName, hash string) {
	fmt.Fprintf(out, `-- ---------------------------------------------------------------------
-- 4. 超级管理员
--
-- password_hash 是 bcrypt（cost 10）。must_change_password=1：这个账号除了改密码
-- 什么接口都调不动（中间件把这个判断放在资源检查之前），前端会强制弹出改密弹窗
-- 且不给关闭。
--
-- user_id 用 UUID 代替代码里的 ULID —— 形状不同不影响任何逻辑，它只是个不透明的
-- 业务键；这样这份 SQL 里就不用硬编码一个固定 id。
-- ---------------------------------------------------------------------

INSERT INTO zt_manager_user
  (user_id, username, display_name, password_hash, status, must_change_password, remark, created_time, updated_time)
SELECT CONCAT('mu_', REPLACE(UUID(), '-', '')), %s, %s, %s, 'active', 1, '初始超级管理员', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_user WHERE username = %s) AS t);

-- 绑上 super_admin。两个 id 都按业务键反查，不写死自增值。
INSERT INTO zt_manager_user_role (user_id, role_id, created_time)
SELECT u.id, r.id, NOW(3)
FROM zt_manager_user u
JOIN zt_manager_role r ON r.code = 'super_admin'
WHERE u.username = %s
  AND NOT EXISTS (
    SELECT 1 FROM zt_manager_user_role rr WHERE rr.user_id = u.id AND rr.role_id = r.id
  );

`, quote(username), quote(displayName), quote(hash), quote(username), quote(username))
}

func writeGrants(out *strings.Builder, apis []apiResource) {
	out.WriteString(`-- ---------------------------------------------------------------------
-- 5. 授权
--
-- super_admin 不在这里 —— 它绕过资源过滤，给它记授权是多余的。
--
-- operator：五个业务页面 + 全部接口。它是「日常运营」，改得动数据，
--           但看不到系统设置那两个页面（能改角色授权的角色，和超管没区别了）。
-- viewer：  五个业务页面 + 只读接口。写接口不给它 —— 给了再靠 writable 拦
--           虽然拦得住，但后台上看到的授权范围会和实际能力不一致，容易误判。
-- ---------------------------------------------------------------------

`)
	writeGrant(out, "operator", operatorPages, nil)
	var writeAPIs, readAPIs []string
	for _, item := range apis {
		if item.Method == "GET" {
			readAPIs = append(readAPIs, item.Code)
		}
		writeAPIs = append(writeAPIs, item.Code)
	}
	writeGrant(out, "operator", nil, writeAPIs)
	writeGrant(out, "viewer", operatorPages, nil)
	writeGrant(out, "viewer", nil, readAPIs)
}

func writeFooter(out *strings.Builder) {
	out.WriteString(`-- ---------------------------------------------------------------------
-- 6. 跑完 SQL 还差一步：让 ACL 缓存失效
--
-- 权限判定走进程内缓存，一致性靠 Redis 里的版本号。直接改库不会碰这个版本号，
-- 已经跑着的 manager-api 会拿着旧缓存继续跑，上面这些资源与授权**不生效**。
--
--     redis-cli INCR manager:acl:version
--
-- 键名是 {manager.redis_namespace}:acl:version，namespace 缺省 manager，
-- 实际值见 server/manager-api/configs/application.properties。
-- 或者直接重启 manager-api。
-- ---------------------------------------------------------------------
`)
}

func writeGrant(out *strings.Builder, roleCode string, pageCodes, apiCodes []string) {
	codes := append(append([]string{}, pageCodes...), apiCodes...)
	if len(codes) == 0 {
		return
	}
	quoted := make([]string, 0, len(codes))
	for _, code := range codes {
		quoted = append(quoted, quote(code))
	}
	label := "页面"
	if len(pageCodes) == 0 {
		label = "接口"
	}
	fmt.Fprintf(out, "-- %s ← %d 条%s资源\nINSERT INTO zt_manager_role_resource (role_id, resource_id, created_time)\nSELECT rl.id, r.id, NOW(3)\nFROM zt_manager_resource r\nJOIN (SELECT id FROM (SELECT id FROM zt_manager_role WHERE code = %s) AS x) AS rl\nWHERE r.status = 'active'\n  AND r.code IN (\n  %s\n  )\n  AND NOT EXISTS (\n    SELECT 1 FROM zt_manager_role_resource rr WHERE rr.role_id = rl.id AND rr.resource_id = r.id\n  );\n\n",
		roleCode, len(codes), label, quote(roleCode), wrapList(quoted, 4))
}

// writeResourceInsert 一条资源的幂等插入。
//
// 存在性判断套了一层派生表（AS t）：MySQL 不允许 INSERT ... SELECT 的 WHERE 直接
// 引用目标表，会报 1093。多这一层强制子查询先物化，绕开它。父节点 id 同理。
func writeResourceInsert(out *strings.Builder, code, name, resourceType, method, resourceURL, pageURL, icon string, sortID int, parent string) {
	parentExpr := "0"
	if parent != "" {
		parentExpr = fmt.Sprintf("(SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = %s) AS p)", quote(parent))
	}
	fmt.Fprintf(out, "INSERT INTO zt_manager_resource\n  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)\nSELECT %s, %s, %s, %s, %s, %s, %s, %s, %d, 'active', NOW(3), NOW(3)\nFROM DUAL\nWHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = %s) AS t);\n",
		parentExpr, quote(code), quote(name), quote(resourceType), quote(method),
		quote(resourceURL), quote(pageURL), quote(icon), sortID, quote(code))
}

type apiResource struct{ Code, Method, Path string }

// quote 生成 SQL 字符串字面量。这些值全部来自代码里的常量与路由表，不是用户输入，
// 但仍然转义 —— 一个带引号的路由（比如以后有人写了个奇怪的路径）不该让整份 SQL 语法错。
func quote(value string) string {
	replacer := strings.NewReplacer("\\", "\\\\", "'", "\\'")
	return "'" + replacer.Replace(value) + "'"
}

func wrapList(items []string, perLine int) string {
	var lines []string
	for i := 0; i < len(items); i += perLine {
		end := i + perLine
		if end > len(items) {
			end = len(items)
		}
		lines = append(lines, strings.Join(items[i:end], ", "))
	}
	return strings.Join(lines, ",\n  ")
}

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
