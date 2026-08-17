# 新增向导：接口 / 子域 / 领域层

三种粒度，从小到大。先判断你在做哪一种。

---

## A. 给已有子域加一个接口

例：给设备池加「批量导入设备」`POST /api/resource/devices/import`。

**① Repository**（`service/resource/internal/repository/repository.go`）

```go
func (r *ResourceRepository) BatchInsertDevices(ctx context.Context, rows []*ResourceDevice) (int, error) {
	if len(rows) == 0 { return 0, nil }
	err := r.Db.WithContext(ctx).CreateInBatches(rows, 200).Error
	return len(rows), err
}
```

**② DTO**（`service/resource/dto/dto.go`，放进 `// ---------- 设备池 ----------` 分组）

```go
type ImportDevicesRequest struct {
	BizLine contract.BizLine    `json:"bizLine"`
	Items   []SaveDeviceRequest `json:"items"`
}
```

**③ Service 接口 + 实现**（`service/resource/resource.go`）

```go
// 接口里加到设备池分组
ImportDevices(ctx context.Context, req dto.ImportDevicesRequest) (int, error)

// 实现
func (s *service) ImportDevices(ctx context.Context, req dto.ImportDevicesRequest) (int, error) {
	if !req.BizLine.Valid() {
		return 0, contract.ErrBizLineRequired
	}
	rows := make([]*repository.ResourceDevice, 0, len(req.Items))
	for _, item := range req.Items {
		if item.DeviceID == "" {
			return 0, errors.New("设备编号不能为空")
		}
		rows = append(rows, toDeviceEntity(req.BizLine, item))
	}
	return s.repo.BatchInsertDevices(ctx, rows)
}
```

**④ Handler**（`resource-api/pkg/devices/handler.go`）

```go
// RegisterHandler 里，写配置 → RequireUser 的子组
api.POST("/devices/import", h.importDevices)

func (h *Handler) importDevices(context *gin.Context) {
	var req resourcedto.ImportDevicesRequest
	if err := context.ShouldBindJSON(&req); err != nil {
		httpx.Fail(context, err.Error())
		return
	}
	req.BizLine = bizLineOf(context)
	count, err := h.service.ImportDevices(context.Request.Context(), req)
	httpx.JSON(context, gin.H{"imported": count}, err)
}
```

**⑤ 前端**（`client/web/src/app/(console)/device-pool/api/device.api.ts`）

```ts
export async function importDevices(bizLine: BusinessLineId, items: SaveDevicePayload[]) {
  const response = await instance.post<ApiResponse<{ imported: number }>>(
    "/resource/devices/import", { bizLine, items });
  return unwrapApiResponse(response.data);
}
```

装配点不用动 —— 新接口只要不被别的层调用，`register.go` 和 `ports.go` 都不涉及。

---

## B. 给已有层加一个子域

例：给 risk 层加「告警规则」子域，路径 `/api/risk/alerts*`。

**① 数据层**：`service/risk/internal/repository/model.go` 加 `RiskAlertRule`（表 `zt_risk_alert_rule`），`repository.go` 加查询方法。同步 `server/SCHEMA.md` 的 risk-api 小节。

**② DTO**：`service/risk/dto/dto.go` 加 `// ---------- 告警规则 ----------` 分组 + `AlertRuleQuery` / `AlertRuleView` / `SaveAlertRuleRequest`。

**③ Service**：`service/risk/risk.go` 的 `Service` 接口加分组和方法，实现照 §A。

**④ 新建 handler 包**：`risk-api/pkg/alerts/handler.go`，照 `backend-api-design.md` §1 的骨架抄，包名 `alerts`。

**⑤ 注册进层聚合 handler**：`risk-api/pkg/risk/handler.go`

```go
import "risk-api/pkg/alerts"

func NewHandler(riskService risk.Service) *Handler {
	return &Handler{handlers: []routers.Handler{
		health.NewHandler(riskService),
		gates.NewHandler(riskService),
		survival.NewHandler(riskService),
		attribution.NewHandler(riskService),
		alerts.NewHandler(riskService),      // ← 新增
	}}
}
```

**`web-api/routers/register.go` 不用动** —— 它注册的是层聚合 handler，子域是层内部的事。这是这套目录结构最实用的一点。

**⑥ 前端**：新建 `src/app/(console)/risk-alerts/{page.tsx,api/riskAlert.api.ts,components/RiskAlerts.tsx}`，在 `ManagerShell.tsx` 的导航与 `PAGE_TITLES` 里挂上，`LocaleProvider.tsx` 三种语言各补文案。详见 web-development 技能。

---

## C. 加一整个领域层

例：加第 7 层「结算」`service/settlement` + `settlement-api`。

先想清楚：**它在依赖 DAG 里的位置，以及有没有回边。** 有回边就不该是新层，而是某层的子域，或者用快照回写解决。

**① 领域包**

```
service/settlement/
├── settlement.go        Service 接口 + service + New() + toXxxView
├── ports.go             需要别层能力时才建，声明最小接口
├── dto/dto.go
└── internal/repository/{model.go,repository.go}
```

`service` 已经是一个 module，加子目录不需要动 `go.mod`。

**② API 模块**

```
settlement-api/
├── go.mod              module settlement-api；require common, contract, service, gin (+ client 若有下游)
├── go.sum
├── main.go
└── pkg/
    ├── settlement/handler.go   聚合 handler
    └── {bills,invoices}/handler.go
```

`go.mod` 的 replace 块照 `resource-api/go.mod` 抄：

```
replace common => ../common
replace contract => ../contract
replace service => ../service
```

有下游时再加 `replace client => ../client`。

`main.go` 照 `resource-api/main.go`（无下游）或 `task-api/main.go`（有下游）抄，**顶部写一段注释说明这一层是什么、下游依赖是什么、为什么**。这是项目里的成文习惯，六个 main.go 都有。

**③ 注册到 go.work**

```
use (
	...
	./settlement-api
)
```

**④ 接入聚合进程**（`web-api/`）

- `web-api/go.mod` 加 `require settlement-api v0.0.0` + `replace settlement-api => ../settlement-api`
- `web-api/routers/register.go`：

```go
import settlementapi "settlement-api/pkg/settlement"

settlementService := servicesettlement.New(database, /* 下游注入 */)

return []commonrouters.Handler{
	...,
	settlementapi.NewHandler(settlementService),
}
```

- 若新层需要别层能力且签名不匹配，在 `web-api/pkg/local/adapters.go` 加适配器。
- 若别的层需要新层能力，在**那一层**的 `ports.go` 加最小接口。

**⑤ 表设计**：前缀 `zt_settlement_`，在 `server/SCHEMA.md` 加一节 `# 7. settlement-api`。

**⑥ 独立部署时**：`SERVICES.md` 的服务清单表加一行，分配端口（下一个是 9107），`client/settlement.go` 补 HTTP 客户端。

---

## 通用检查

跨三种粒度都要过一遍：

- [ ] handler 在 `{层}-api/pkg/` 下，**不在 `web-api/pkg/`**
- [ ] `service/a` 没有 import `service/b`（要用就走 `ports.go`）
- [ ] Entity 在 `internal/repository/` 下，别的层碰不到
- [ ] 表前缀 = 层前缀，索引 `biz_line` 打头
- [ ] 每个 Service 方法首行校验 `bizLine.Valid()`
- [ ] 每条路由显式 `Require*`
- [ ] `ctx` 从 handler 一路传到 Repository
- [ ] DTO 字段全带 camelCase `json` tag，与前端 class 字段名一致
- [ ] `web-api` 能起、`/healthz` 通、新接口手测过（注意：`client` module 缺失期间 `go build` 整体失败，见 SKILL.md「已知状态」）
- [ ] `server/SCHEMA.md`（新表）/ `server/SERVICES.md`（新层）同步更新
