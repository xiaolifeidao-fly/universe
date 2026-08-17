# API 设计规范

## 1. Handler 包结构

一个子域一个包，一个 `handler.go`。固定骨架：

```go
package devices

import (
	"common/middleware/httpx"
	"common/middleware/routers"

	"contract"
	"service/resource"
	resourcedto "service/resource/dto"

	"github.com/gin-gonic/gin"
)

type Handler struct{ service resource.Service }

func NewHandler(service resource.Service) *Handler { return &Handler{service: service} }

func (h *Handler) RegisterHandler(group *gin.RouterGroup) { /* 见下 */ }

// ... 每个接口一个小写方法

func bizLineOf(context *gin.Context) contract.BizLine {
	return contract.BizLine(httpx.BizLine(context))
}

var _ routers.Handler = (*Handler)(nil)   // 编译期确认实现了 routers.Handler
```

约定：

- 结构体名固定 `Handler`，构造函数固定 `NewHandler`，接收 **Service 接口**而不是 `*gorm.DB`。
- 包名用复数资源名（`devices` / `proxies` / `bindings` / `tasks` / `templates`），聚合包用层名。
- import 分三组：`common/*`、业务（`contract` + `service/*`）、第三方。
- 领域 dto 用**带前缀的别名**：`resourcedto`、`riskdto`、`orchdto`，避免多个 `dto` 撞名。
- 文件末尾的 `var _ routers.Handler = (*Handler)(nil)` 不要省。
- 每个用到业务线的包都有一份三行的 `bizLineOf` —— 这是有意的局部重复，不要抽到 common 去。

## 2. 路由注册与鉴权

**每条路由显式声明鉴权**，不靠路径前缀猜（`SERVICES.md`：「猜的那种写法漏一条就是一个洞」）。

```go
func (h *Handler) RegisterHandler(group *gin.RouterGroup) {
	// 同一鉴权的一批路由用子组
	api := group.Group("/resource", httpx.RequireUser())
	api.GET("/devices", h.list)
	api.GET("/device", h.get)
	api.POST("/devices", h.save)
	api.GET("/device/detail", h.detail)
	api.POST("/device/params", h.saveParams)
	// 参数模板是设备指纹的复用配置，随设备模块演进，不单独形成服务边界。
	api.GET("/templates", h.listTemplates)
	api.POST("/template/apply", h.applyTemplate)

	// 鉴权不同的，从 group 上单独挂，写全路径
	group.GET("/resource/devices/overview", httpx.RequireUserOrService(), h.overview)
	group.POST("/resource/heartbeat", httpx.RequireDevice(), h.heartbeat)
	group.POST("/resource/devices/sweep", httpx.RequireService(), h.sweepOffline)
}
```

`group` 是 `/api`，所以上面注册出的是 `/api/resource/devices` 等。

### 四个中间件与分配原则

| 中间件 | 用在哪 |
|---|---|
| `RequireUser()` | **写配置一律用这个**：模板、策略、Agent、业务线注册、资源绑定。机器不该能改配置 |
| `RequireService()` | **同步链路的内部接口**：`/risk/gate/check`、`/risk/results`、`/aisched/decide`、`/strategy/calibration/apply`、各种 sweep/回写。人不该能直接调闸门改配额台账，也不该能直接触发 LLM |
| `RequireDevice()` | 端侧 App 接口：`/task/poll`、`/task/report`、`/resource/heartbeat` |
| `RequireUserOrService()` | **只读且两边都要看**：绑定查询、健康分、生效策略、各种 overview |

特例：`/orchestration/remote`（远控真机）**只允许 `RequireUser`** —— 能直接操作真实设备的接口必须是人在操作。

> 当前四个 `Require*` 都是 passthrough 空实现。**照规则写不能省** —— 中间件落地那天不用回头逐条补，也不会有漏。

## 3. URL 路径设计

```
/api/{层前缀}/{资源}[/{子资源或动作}]
```

- 层前缀固定：`bizline` / `resource` / `task` / `risk` / `strategy` / `aisched` / `orchestration`。
- 多词用 kebab-case：`/resource/binding/unify-check`、`/task/execution-guard`。
- 列表用复数（`/resource/devices`），单个用单数 + 查询参数（`/resource/device?deviceId=CP-096`）。
- 动作类用动词后缀：`/binding/acquire`、`/binding/release`、`/template/apply`、`/devices/sweep`。
- 概览统一 `overview` 后缀：`/resource/devices/overview`。
- 详情统一 `detail`：`/resource/device/detail`。

**方法约定：** 读 `GET`；写（新建 + 更新 + 动作）一律 `POST`。项目里基本不用 `PUT`/`DELETE`，upsert 语义走 `POST /xxxs`（`SaveXxx`）。别在新代码里引入 `PUT`/`DELETE`，前端 `@/utils/axios` 的封装也是围绕 `GET` + `POST` 设计的。

**Handler 方法名用短动作名**：`list` / `get` / `save` / `detail` / `overview` / `acquire` / `release` / `heartbeat`；同一包内有多个资源时加后缀 `listTemplates` / `getTemplate` / `saveTemplate`。

## 4. Handler 方法体：三种形状

**读（查询参数绑定）：**

```go
func (h *Handler) list(context *gin.Context) {
	var query resourcedto.DeviceQuery
	if err := context.ShouldBindQuery(&query); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	query.BizLine = bizLineOf(context)          // 覆盖：bizLine 由中间件/头决定，不信查询参数里的
	page, err := h.service.ListDevices(context.Request.Context(), query)
	httpx.JSON(context, page, err)
}
```

**读（单参数，不用 DTO）：**

```go
func (h *Handler) get(context *gin.Context) {
	view, err := h.service.GetDevice(context.Request.Context(), bizLineOf(context), context.Query("deviceId"))
	httpx.JSON(context, view, err)
}
```

**写（JSON body）：**

```go
func (h *Handler) save(context *gin.Context) {
	var req resourcedto.SaveDeviceRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	httpx.JSON(context, nil, h.service.SaveDevice(context.Request.Context(), req))
}
```

铁律：

- **一律 `context.Request.Context()`**，不要传 `context`（gin.Context）本身，也不要 `context.Background()`。
- 绑参失败 → `httpx.Fail` + `return`；业务错误 → 交给 `httpx.JSON` 的第三个参数。
- 无返回值的写操作：`httpx.JSON(context, nil, err)`。
- Handler 里**不写 if 业务判断**、不碰 repository、不做数据组装。看到 handler 超过 8 行就该怀疑。

### 端侧上报必须覆盖身份

```go
func (h *Handler) heartbeat(context *gin.Context) {
	var req resourcedto.HeartbeatRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	req.DeviceID = httpx.CallerID(context)   // ★ 请求体是端侧自报的，不可信
	httpx.JSON(context, nil, h.service.Heartbeat(context.Request.Context(), req))
}
```

`/task/poll` 同理 —— 不覆盖的话任一台设备都能拉别人的指令去执行。

## 5. 统一响应

`httpx.JSON` / `httpx.Fail` 是唯一出口，**HTTP 状态码永远 200**，成败看 `success`：

```json
// 成功
{"success": true,  "code": 0,  "data": <任意>, "message": "请求成功", "error": null}
// 失败
{"success": false, "code": -1, "data": null,   "message": "请求失败", "error": "具体错误信息"}
```

`/healthz`（在 `web-api/routers/router.go`，不鉴权）也返同样信封，`data: "ok"`。

不要自己 `context.JSON(...)`；不要返 4xx/5xx —— 前端 `@/utils/axios` 的 `unwrapResponse` 只认 `success` 字段，返非 200 会走到 axios 的 error 分支，前端拿不到 `error` 文案。

**错误文案会直接显示给用户**，Service 层的 `errors.New` / `fmt.Errorf` 要写成人能看懂的中文短句，不要暴露 SQL 或内部字段名。

## 6. DTO 规范

放在 `service/{domain}/dto/dto.go`，每个域一个文件，用注释分组（`// ---------- 号码池 ----------`）。

四类命名：

| 类型 | 命名 | 用途 |
|---|---|---|
| 查询 | `XxxQuery` | 嵌入 `Page`，`ShouldBindQuery` 绑定 |
| 视图 | `XxxView` / `XxxDetail` | Service 返回、前端消费 |
| 分页 | `XxxPage` | `{Total int64, Data []XxxView}` |
| 请求 | `SaveXxxRequest` / `ApplyXxxRequest` / `AcquireRequest` | `ShouldBindJSON` 绑定 |
| 概览 | `XxxOverview` | 看板 KPI |

**所有字段必须带 `json` tag 且是 camelCase** —— 前端的 class 字段名靠这个对齐：

```go
type AccountView struct {
	AccountID     string           `json:"accountId"`
	BizLine       contract.BizLine `json:"bizLine"`
	ExternalRatio float64          `json:"externalRatio"`
	LastActiveAt  *time.Time       `json:"lastActiveAt"`
	// HealthScore / Grade 来自 risk 层的快照，仅供展示排序，不可用于判断。
	HealthScore   float64          `json:"healthScore"`
	ScoreSyncedAt *time.Time       `json:"scoreSyncedAt"`
}
```

**分页统一嵌入 `Page`**，边界在 DTO 里兜住，不在 Handler 也不在 Repository：

```go
type Page struct {
	PageIndex int `json:"pageIndex"`
	PageSize  int `json:"pageSize"`
}

// Offset 页码从 1 起；给 0 或负数时回落到第一页，避免负偏移打穿查询。
func (p Page) Offset() int {
	if p.PageIndex <= 1 { return 0 }
	return (p.PageIndex - 1) * p.Limit()
}

func (p Page) Limit() int {
	if p.PageSize <= 0  { return 20 }
	if p.PageSize > 200 { return 200 }   // 上限 200，防拉全表
	return p.PageSize
}
```

**可空时间用 `*time.Time`**（`lastActiveAt`、`scoreSyncedAt`），零值 `time.Time` 序列化成 `0001-01-01T00:00:00Z`，前端 `new Date()` 会显示成公元一年。

**跨层的形状不放 dto，放 `contract`。** `dto.DispatchOutcome` 这种被 `ports.go` 引用的例外可以留在 dto（接口定义在同一个包树里）。

## 7. 新增接口检查清单

- [ ] 确认层归属（看表前缀 / 看调哪个 service），handler 写进 `{层}-api/pkg/{子域}/`，**不是 `web-api/pkg/`**
- [ ] 子域包已存在？没有则新建包 + 在 `{层}-api/pkg/{层}/handler.go` 的列表里注册
- [ ] `service/{domain}/{domain}.go` 的 `Service` 接口加方法（放进对应的 `// ----` 分组）
- [ ] 方法实现第一行校验 `bizLine.Valid()`，返 `contract.ErrBizLineRequired`
- [ ] `dto` 里加 `XxxQuery` / `XxxView` / `SaveXxxRequest`，字段全带 camelCase `json` tag，可空时间用 `*time.Time`
- [ ] Repository 加查询方法；跨层引用用业务键；新表/新条件确认索引以 `biz_line` 打头
- [ ] Entity → View 的 `toXxxView` 转换函数
- [ ] 路由声明了正确的 `Require*`；写配置 = User，同步内部 = Service，端侧 = Device
- [ ] 端侧接口用 `httpx.CallerID` 覆盖请求体里的身份
- [ ] `ctx` 用 `context.Request.Context()` 一路传到 Repository
- [ ] 出口只用 `httpx.JSON` / `httpx.Fail`
- [ ] 若接口要被别的层调：在调用方 `ports.go` 加**最小**接口，并在 `web-api/routers/register.go`（必要时加 `web-api/pkg/local/` 适配器）里接上；`client/` 补 HTTP 实现
- [ ] 前端对接：`src/app/(console)/{page}/api/{name}.api.ts` 加 class + 请求函数，字段名与 `json` tag 一致
