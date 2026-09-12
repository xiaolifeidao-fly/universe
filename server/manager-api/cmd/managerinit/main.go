// managerinit 建管理端权限体系的表，登记资源，写入默认角色与默认管理员。
//
// 建表不做成进程启动的副作用：线上 DDL 该是一次显式的发布动作。
// 用法：在 server/manager-api 目录下 `go run ./cmd/managerinit`
//
// 幂等，可以反复跑：
//   - 表已存在就只做增量迁移；
//   - 资源按 code 冲突更新，不重建 —— 重建会换掉资源 id，把角色授权全部作废；
//   - 角色与默认管理员已存在就跳过，不会把线上改过的密码重置回配置值；
//   - 授权是并集，不会抹掉管理员在后台调过的权限。
package main

import (
	"context"
	"log"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"common/middleware/httpx"
	"manager-api/pkg/tokenstore"
	"manager-api/routers"
	"service/bizline"
	"service/delivery"
	"service/identity"
	"service/manager"
	managerdto "service/manager/dto"
)

// 页面资源。这一份必须手写 —— 它是 UI 结构，从路由表推导不出来。
// code 同时是前端取 i18n 文案的键（t("nav." + code)），改它等于改文案键。
var pages = []managerdto.SaveResourceRequest{
	{Code: "dashboard", Name: "仪表盘", ResourceType: manager.ResourcePage, PageURL: "/dashboard", Icon: "DashboardOutlined", SortID: 10},
	{Code: "users", Name: "用户管理", ResourceType: manager.ResourcePage, PageURL: "/users", Icon: "TeamOutlined", SortID: 20},
	{Code: "businessLines", Name: "业务线管理", ResourceType: manager.ResourcePage, PageURL: "/business-lines", Icon: "BranchesOutlined", SortID: 30},
	{Code: "programs", Name: "项目管理", ResourceType: manager.ResourcePage, PageURL: "/programs", Icon: "FolderOutlined", SortID: 40},
	// 共享算力池是菜单不是页面：原来那十一块内容挤在一个页面的页签条里，
	// 现在一块一个页面挂在它底下 —— 页签排到第十一个就不是导航了。
	{Code: "galaxy", Name: "共享算力池", ResourceType: manager.ResourceMenu, Icon: "GlobalOutlined", SortID: 50},
	{Code: "galaxyPool", Name: "池水位", ResourceType: manager.ResourcePage, PageURL: "/galaxy/pool", SortID: 51},
	{Code: "galaxyNodes", Name: "节点与贡献", ResourceType: manager.ResourcePage, PageURL: "/galaxy/nodes", SortID: 52},
	{Code: "galaxyAccounts", Name: "账号", ResourceType: manager.ResourcePage, PageURL: "/galaxy/accounts", SortID: 53},
	{Code: "galaxyProbes", Name: "抽检", ResourceType: manager.ResourcePage, PageURL: "/galaxy/probes", SortID: 54},
	{Code: "galaxyDisputes", Name: "争议工单", ResourceType: manager.ResourcePage, PageURL: "/galaxy/disputes", SortID: 55},
	{Code: "galaxyPackages", Name: "额度包", ResourceType: manager.ResourcePage, PageURL: "/galaxy/packages", SortID: 56},
	{Code: "galaxyModels", Name: "模型目录", ResourceType: manager.ResourcePage, PageURL: "/galaxy/models", SortID: 57},
	{Code: "galaxyPoints", Name: "积分充值", ResourceType: manager.ResourcePage, PageURL: "/galaxy/points", SortID: 58},
	{Code: "galaxyKeys", Name: "算力密钥", ResourceType: manager.ResourcePage, PageURL: "/galaxy/keys", SortID: 59},
	{Code: "galaxySettlement", Name: "结算汇总", ResourceType: manager.ResourcePage, PageURL: "/galaxy/settlement", SortID: 60},
	{Code: "galaxyBridgeReleases", Name: "ai-bridge 版本", ResourceType: manager.ResourcePage, PageURL: "/galaxy/bridge-releases", SortID: 61},
	{Code: "settings", Name: "系统设置", ResourceType: manager.ResourceMenu, Icon: "SettingOutlined", SortID: 90},
	{Code: "settingsAccounts", Name: "管理端账号", ResourceType: manager.ResourcePage, PageURL: "/settings/accounts", SortID: 91},
	{Code: "settingsRoles", Name: "角色与权限", ResourceType: manager.ResourcePage, PageURL: "/settings/roles", SortID: 92},
}

// 挂在菜单下面的子页面。父节点在 pages 里排在子页面前面，下面那个循环才查得到它的 id。
var pageParents = map[string]string{
	"galaxyPool":           "galaxy",
	"galaxyNodes":          "galaxy",
	"galaxyAccounts":       "galaxy",
	"galaxyProbes":         "galaxy",
	"galaxyDisputes":       "galaxy",
	"galaxyPackages":       "galaxy",
	"galaxyModels":         "galaxy",
	"galaxyPoints":         "galaxy",
	"galaxyKeys":           "galaxy",
	"galaxySettlement":     "galaxy",
	"galaxyBridgeReleases": "galaxy",
	"settingsAccounts":     "settings",
	"settingsRoles":        "settings",
}

// operatorPages 日常运营看得到的页面：不含系统设置。
// 一个能改权限的角色和超级管理员就没有区别了。
//
// 只列叶子页面：共享算力池那个菜单由 CurrentMenus 的 withAncestors 自动带出来，
// 单独授权它没有意义 —— 一个点开是空的目录比没有更糟。
var operatorPages = []string{
	"dashboard", "users", "businessLines", "programs",
	"galaxyPool", "galaxyNodes", "galaxyAccounts", "galaxyProbes", "galaxyDisputes",
	"galaxyPackages", "galaxyModels", "galaxyPoints", "galaxyKeys", "galaxySettlement",
	"galaxyBridgeReleases",
}

func main() {
	gin.SetMode(gin.ReleaseMode)
	database := httpx.Boot("manager-api")
	if err := manager.Migrate(database); err != nil {
		log.Fatalf("建表失败: %v", err)
	}
	log.Print("zt_manager_* 建表完成")

	tokens := tokenstore.New(tokenstore.Options{
		Addresses: httpx.Property("redis.addr"),
		Password:  httpx.Property("redis.password"),
		Mode:      httpx.Property("redis.mode"),
		Namespace: httpx.Property("manager.redis_namespace"),
	})
	if tokens == nil {
		log.Fatal("需要 Redis：请在 configs/application.properties 里配置 redis.addr")
	}
	defer func() { _ = tokens.Close() }()

	service, err := manager.New(database, manager.Ports{Tokens: tokens}, manager.Config{})
	if err != nil {
		log.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()

	// 三个角色。writable 是粗粒度保险：viewer 拿到的资源和 operator 一样多也没用，
	// 它的每一个写请求都会被这道门挡下。
	superAdminID, err := service.EnsureRole(ctx, manager.SuperAdminCode, "超级管理员", true)
	if err != nil {
		log.Fatalf("写入角色失败: %v", err)
	}
	if _, err := service.EnsureRole(ctx, "operator", "运营", true); err != nil {
		log.Fatalf("写入角色失败: %v", err)
	}
	if _, err := service.EnsureRole(ctx, "viewer", "只读", false); err != nil {
		log.Fatalf("写入角色失败: %v", err)
	}
	log.Printf("角色就绪（超级管理员 id=%d）", superAdminID)

	// 页面资源。先建菜单再建它的子页面，否则 parent_id 查不到。
	// 按 code 幂等：这份清单会变（页面长出子页、于是自己变成菜单），
	// 认自增 id 的那条路只会撞上 code 的唯一索引。
	codeToID := map[string]int64{}
	for _, page := range pages {
		if parent, ok := pageParents[page.Code]; ok {
			page.ParentID = codeToID[parent]
		}
		id, err := service.EnsureResource(ctx, page)
		if err != nil {
			log.Fatalf("写入页面资源 %s 失败: %v", page.Code, err)
		}
		codeToID[page.Code] = id
	}
	log.Printf("页面资源就绪：%d 条", len(pages))

	// 接口资源按真实路由表生成。手写一份清单和路由迟早分叉，
	// 而分叉的后果是「登录用户一律 403」—— 一个看起来像 bug 的配置故障。
	engine, err := buildEngine(database, service)
	if err != nil {
		log.Fatalf("装配路由失败: %v", err)
	}
	count, err := service.SyncAPIResources(ctx, routers.Routes(engine))
	if err != nil {
		log.Fatalf("同步接口资源失败: %v", err)
	}
	log.Printf("接口资源就绪：%d 条", count)

	if err := grantRoles(ctx, service, engine); err != nil {
		log.Fatalf("授权失败: %v", err)
	}

	username := httpx.Property("auth.default_username")
	if err := service.EnsureDefaultAdmin(ctx, username,
		httpx.Property("auth.default_display_name"), httpx.Property("auth.default_password")); err != nil {
		log.Fatalf("创建默认管理员失败: %v", err)
	}
	log.Printf("默认管理员就绪：%s（首次登录必须改密码）", username)

	if missing, err := service.UnregisteredRoutes(ctx, routers.Routes(engine)); err != nil {
		log.Printf("路由自检失败: %v", err)
	} else if len(missing) > 0 {
		log.Printf("仍有 %d 条路由未登记，请检查", len(missing))
	} else {
		log.Print("路由自检通过：全部接口均已登记")
	}
}

// viewerWithheld 只读角色也不给的读接口。门户线索里是陌生人留下的手机、邮箱，
// 只读角色没有理由拉这份名单。
var viewerWithheld = map[string]bool{
	"/api/galaxy/admin/portal/leads": true,
}

// grantRoles 给 operator 与 viewer 铺一份可用的初始授权。
// 超级管理员不需要授权 —— 它绕过资源过滤。
func grantRoles(ctx context.Context, service manager.Service, engine *gin.Engine) error {
	codes := make([]string, 0, len(operatorPages))
	codes = append(codes, operatorPages...)
	viewerCodes := append([]string{}, operatorPages...)

	for _, route := range routers.Routes(engine) {
		if route.Method == "OPTIONS" || route.Method == "HEAD" {
			continue
		}
		code := manager.APIResourceCode(route.Method, route.Path)
		codes = append(codes, code)
		// viewer 只拿读接口。给它写接口再靠 writable 拦，虽然拦得住，
		// 但后台上看到的授权范围会和实际能力不一致，配起来容易误判。
		if route.Method == "GET" && !viewerWithheld[route.Path] {
			viewerCodes = append(viewerCodes, code)
		}
	}
	if err := service.GrantRoleByCode(ctx, "operator", codes); err != nil {
		return err
	}
	return service.GrantRoleByCode(ctx, "viewer", viewerCodes)
}

// buildEngine 只为拿到路由表，不监听端口。
func buildEngine(database *gorm.DB, managerService manager.Service) (*gin.Engine, error) {
	deliveryService := delivery.New(database, nil)
	bizLineService := bizline.New(database, deliveryService)
	identityService := identity.New(database, deliveryService, httpx.Property("auth.token_secret"), time.Hour)
	// galaxyService 传 nil：这里只要路由表，不调用任何服务方法。
	return routers.New(managerService, identityService, bizLineService, deliveryService, nil, nil)
}
