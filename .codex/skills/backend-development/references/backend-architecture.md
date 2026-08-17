# 服务端架构

## 1. 模块布局（go.work）

`server/go.work` 把 10 个模块编成一个工作区：

```
server/
├── go.work
├── contract/            module contract   —— 唯一的跨领域数据形状，零依赖
├── common/              module common     —— 基础设施（db / httpx / routers）
├── service/             module service    —— 6 个领域包，全部业务逻辑在这里
│   ├── bizline/         第 0 层 业务线注册与能力集
│   ├── resource/        第 1 层 号 · 设备 · IP · 四元绑定
│   ├── task/            第 2 层 指令 · 模板 · 下发 · 端侧拉取
│   ├── risk/            第 3 层 归因 · 评分 · 闸门 · 存活反馈
│   ├── strategy/        第 4 层 策略版本 · 日计划 · 运营准入
│   ├── aisched/         第 5 层 Agent · 场景 · 决策
│   └── orchestration/   第 6 层 时间线引擎 · 远控 · 看板聚合
├── resource-api/        module resource-api   ┐
├── task-api/            module task-api       │ 每个只有 main.go + pkg/{子域}/handler.go
├── risk-api/            module risk-api       │ 路由、装配、引导，无业务逻辑
├── strategy-api/        module strategy-api   │
├── aisched-api/         module aisched-api    │
├── orchestration-api/   module orchestration-api ┘
├── web-api/             module web-api    —— 当前的聚合进程（:10001）
└── client/              module client     —— ★ 尚未实现，跨层 HTTP 客户端
```

模块间依赖方向严格单向：

```
contract  ←  common  ←  service  ←  {层}-api  ←  web-api
   ↑                        ↑
   └────────────────────────┘   （*-api 也直接依赖 contract）
```

`contract` 不依赖任何东西。`service` 不依赖任何 `*-api`。`web-api` 依赖全部。

每个 `*-api/go.mod` 用 `replace` 指向相对路径，新增模块时记得同步 `go.work` 的 `use` 列表和依赖方的 `replace`。

## 2. 6 层业务与依赖 DAG

| 层 | 领域包 | API 模块 | 下游依赖 |
|---|---|---|---|
| 0 | `service/bizline` | 挂在 `resource-api`（`/bizline/*`） | 无 |
| 1 | `service/resource` | `resource-api` | 无 |
| 2 | `service/task` | `task-api` | risk, resource, bizline |
| 3 | `service/risk` | `risk-api` | strategy, resource |
| 4 | `service/strategy` | `strategy-api` | 无 |
| 5 | `service/aisched` | `aisched-api` | 外部 LLM（可缺 → 规则模式降级） |
| 6 | `service/orchestration` | `orchestration-api` | 全部 |

**依赖是有向无环图，没有回边。** 出现回边（比如 resource 要读 risk）时，正确做法不是加 import，而是让上层**回写快照**：`service/risk` 通过 `ScoreSink` 端口把健康分写进 `zt_resource_account.health_score_cache`，resource 只读这份冗余用于列表排序，**任何判断逻辑必须读 risk**。

第 0 层业务线是横切维度而非纵向服务，档案维护挂在 resource-api 下（和设备 / 号一样属于基础主数据）。要独立成服务随时可以拆，`service/bizline` 本来就是独立包。

## 3. contract vs ports：两种不同的解耦

这两个东西职责不同，别混：

**`contract` = 数据形状。** 三个文件：

- `contract/types.go` — 跨层交换的结构体：`Binding`、`Command`、`StepResult`、`TaskLevel`、`DispatchRequest`、`Strategy`、`Decision`、`DecisionRequest`、`AdmissionRequest/Result`、`HealthScore`、`GateResult`、`PoolStats`、`AttrStats`
- `contract/bizline.go` — `BizLine` 类型 + `Valid()`（目前就是 `!= ""`）+ `String()`
- `contract/errors.go` — 哨兵错误 `ErrBizLineRequired`、`ErrNotFound`

判断标准：**这个类型被两个以上的层看见吗？** 是 → `contract`；只有本层用 → `service/{domain}/dto`。

**`service/{domain}/ports.go` = 能力接口。** 调用方声明自己需要什么，接口定义在**调用方**包里（依赖倒置），实现由装配处注入。

`service/orchestration/ports.go` 是最完整的例子：

```go
// BindingReader 第 1 层：解析账号绑定的设备与时区。
type BindingReader interface {
	GetBinding(ctx context.Context, bizLine contract.BizLine, accountID string) (*contract.Binding, error)
	ListBindings(ctx context.Context, bizLine contract.BizLine) ([]*contract.Binding, error)
}

// TaskDispatcher 第 2 层：把编排结果落成实际下发。
type TaskDispatcher interface {
	Dispatch(ctx context.Context, req contract.DispatchRequest) (dto.DispatchOutcome, error)
}
// ScoreReader / StrategyReader / AdmissionChecker / Decider / CloudProvider
// DeviceStatsReader / AttributionReader ...
```

接口方法只用 `contract` 类型和本包 `dto` 类型 —— 这样任何实现方（本地 Service 适配器、HTTP 客户端）都不需要 import 别的领域包。

**接口要小。** `BindingReader` 只有两个方法，尽管 `resource.Service` 有四十多个 —— 编排层只需要读绑定，声明多的部分就是白送的耦合。

## 4. internal 单写约束

```
service/resource/internal/repository/   ← 只有 service/resource 目录树能 import
```

Go 的 `internal` 规则在**编译期**保证：四元绑定表 `zt_resource_binding` 的写入口全在 `service/resource/internal/repository/repository.go` 里，其他任何包（包括 `service/task`、`orchestration-api`、`web-api`）连 import 都做不到。

这条约束跨进程同样有效 —— 独立部署后 task-api 想改绑定，除了调 resource 的 `/resource/binding/acquire`，没有第二条路。

**推论：6 个服务连同一个库，跨层写操作没有分布式事务，所以各层只写自己前缀的表。** 新增领域包时照抄这个结构，别把 Entity 放到 `dto` 或领域包根目录去。

## 5. 领域包内部结构

以 `service/resource/` 为例：

```
service/resource/
├── resource.go        Service 接口 + service 结构体 + New() + 全部方法实现 + toXxxView 转换函数
├── ports.go           （本层需要别的层时才有；resource 无下游，所以没有）
├── dto/dto.go         Page / XxxQuery / XxxView / XxxPage / SaveXxxRequest / XxxOverview
├── internal/
│   └── repository/
│       ├── model.go        GORM Entity + TableName() + Init()
│       └── repository.go   Repository 结构体 + 查询方法 + 内部 Query 结构体
└── cmd/               （预留，目前空）
```

`Service` 是接口，`service` 是私有实现，`New(database *gorm.DB, deps...) Service` 是唯一构造入口：

```go
type Service interface {
	ListAccounts(ctx context.Context, q dto.AccountQuery) (dto.AccountPage, error)
	// ...
}

type service struct{ repo *repository.ResourceRepository }

func New(database *gorm.DB) Service {
	repo := &repository.ResourceRepository{}
	repo.SetDb(database)
	return &service{repo: repo}
}
```

有下游的层，`New` 的参数就是 `ports.go` 里的接口：

```go
// service/task
func New(database *gorm.DB, gate Gate, bindings BindingReader,
	results ResultSink, caps CapabilityReader) Service

// service/orchestration
func New(database *gorm.DB, bindings BindingReader, dispatcher TaskDispatcher,
	scores ScoreReader, strategies StrategyReader, admission AdmissionChecker,
	decider Decider, cloud CloudProvider,
	pools DeviceStatsReader, attrs AttributionReader) Service
```

`Service` 接口里用**注释分组**标出子域，和 `*-api/pkg/` 的子包一一对应：

```go
type Service interface {
	// ---- 号码池 ----
	// ---- 设备池 ----
	// ---- 设备参数模板 ----
	// ---- 代理池 ----
	// ---- 四元绑定：唯一写入路径 ----
	// ---- 绑定只读：供其余各层消费 ----
	// ---- 外部联系人池 ----
}
```

Service 方法体的固定形状：

```go
func (s *service) ListAccounts(ctx context.Context, q dto.AccountQuery) (dto.AccountPage, error) {
	if !q.BizLine.Valid() {                       // 1. bizLine 校验，第一件事
		return dto.AccountPage{}, contract.ErrBizLineRequired
	}
	rows, total, err := s.repo.ListAccounts(ctx, repository.AccountQuery{  // 2. DTO → repo Query
		BizLine: q.BizLine.String(), Stage: q.Stage,
		Offset: q.Offset(), Limit: q.Limit(),
	})
	if err != nil {
		return dto.AccountPage{}, err
	}
	views := make([]dto.AccountView, 0, len(rows))  // 3. Entity → View
	for _, row := range rows {
		views = append(views, toAccountView(row))
	}
	return dto.AccountPage{Total: total, Data: views}, nil
}
```

Entity ↔ DTO 用**手写转换函数**（`toAccountView(row *repository.ResourceAccount) dto.AccountView`），不用反射拷贝库 —— 冗余字段、快照字段、需要计算的字段都在这里显式处理。

## 6. 装配（wire）在哪

**领域包里没有任何装配代码。** 装配点只有两处：

**聚合期 —— `web-api/routers/register.go`：**

```go
func registerHandlers(database *gorm.DB) []commonrouters.Handler {
	resourceService := serviceresource.New(database)
	bizLineService  := bizline.New(database)
	strategyService := servicestrategy.New(database)
	riskService := servicerisk.New(database,
		strategyService,                                   // 直接满足接口
		local.StrategyWriter{Service: strategyService},     // 需要适配器抹平签名
		local.ScoreSink{Service: resourceService},
	)
	taskService := servicetask.New(database, riskService, resourceService, riskService, bizLineService)
	// ... orchestrationService

	return []commonrouters.Handler{
		resourceapi.NewHandler(resourceService, bizLineService),
		taskapi.NewHandler(taskService),
		riskapi.NewHandler(riskService),
		strategyapi.NewHandler(strategyService),
		aischedapi.NewHandler(aischedService),
		orchestrationapi.NewHandler(orchestrationService),
	}
}
```

注意 `riskService` 被当成两个不同端口传给 `taskService`（Gate 和 ResultSink）—— 一个实现满足多个小接口是正常的。

**独立期 —— `{层}-api/main.go`：**

```go
func main() {
	database := httpx.Boot(serviceName)

	token := httpx.MustServiceToken(serviceName)
	riskClient     := client.NewRisk(httpx.MustRemote(serviceName, "risk"), token)
	resourceClient := client.NewResource(httpx.MustRemote(serviceName, "resource"), token)
	bizLineClient  := client.NewBizLine(httpx.MustRemote(serviceName, "resource"), token)

	handler := taskapi.NewHandler(task.New(database, riskClient, resourceClient, riskClient, bizLineClient))
	httpx.Serve(serviceName, handler.RegisterHandler)
}
```

**同一个 `task.New`，同一个接口，换的只是实现。领域代码一行都不用改。**

## 7. 本地适配器（web-api/pkg/local/adapters.go）

聚合装配时，A 层的 Service 方法签名常常和 B 层 `ports.go` 声明的不完全一致（参数展开成结构体、返回值换成本层 DTO）。这时写一个薄适配器：

```go
type ScoreSink struct{ Service resource.Service }

func (adapter ScoreSink) SyncScore(ctx context.Context, bizLine contract.BizLine,
	accountID string, score float64, grade string) error {
	return adapter.Service.SyncScore(ctx, resourcedto.SyncScoreRequest{
		BizLine: bizLine, AccountID: accountID, Score: score, Grade: grade,
	})
}
```

现有适配器：`StrategyWriter`、`ScoreSink`、`TaskDispatcher`、`ScoreReader`、`AdmissionChecker`、`PoolStatsReader`、`AttrStatsReader`。

**适配器只做形状转换，不做业务判断。** 一旦你想在适配器里写 if，说明这段逻辑属于某一层的 Service。

`web-api/pkg/local/` 是这类适配器的**唯一**去处；handler 不进这个目录。

## 8. 配置与启动

`httpx.Boot(serviceName)` 从**进程工作目录**下的 `configs/application.properties` 读 `sqlconn`，开 GORM 连接，并 `db.SetDatabase(database)` 存进全局。

```
web-api/configs/application.properties       生产
web-api/configs/application_dev.properties   开发
```

格式是 `key=value` 的 properties（`#` / `;` 注释），不是 YAML —— `SERVICES.md` 里写的 YAML 是目标态。

`db.SetDatabase` + `db.GetRepository[R]()` 提供了一套全局单例仓储缓存，但**领域包目前走的是显式注入**（`repo.SetDb(database)`），新代码沿用显式注入，别依赖全局。

`web-api` 硬编码监听 `:10001`，运维脚本在 `web-api/{start,stop,build,redev}.sh`，日志落 `web-api/logs/`。

## 9. 架构劣化的四个信号

1. `service/a` 里出现 `import "service/b"` —— 改成 `ports.go` 接口 + 装配注入。
2. handler 里出现 `if` 业务判断或直接碰 repository —— 下沉到 Service。
3. `contract` 里出现只有一层用的类型 —— 移到该层 `dto`。
4. 某层直接 SQL 写别的层前缀的表 —— 走对方的 Service / HTTP 接口。
