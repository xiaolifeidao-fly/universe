# API 层归属与服务拆分

本篇回答一个问题：**新写的 handler 该放哪个目录**，以及**从聚合进程拆成独立服务时要动什么**。

## 1. 现状：一个进程，六份 API 代码

跑起来的进程只有一个：`web-api`，监听 `:10001`，路由根 `/api`。

但**API 代码不在 `web-api` 里**。`web-api` 只有 100 行左右的装配和引导：

```
web-api/
├── main.go                    gin.SetMode → httpx.Boot("web-api") → routers.New → :10001
├── routers/router.go          engine + /healthz + /api 组 + 遍历注册
├── routers/register.go        new 出 6 层 service，返回 6 个聚合 handler   ← 唯一的装配点
├── pkg/local/adapters.go      本地装配适配器（不是 handler）
├── internal/config/           （空）
├── configs/*.properties
└── {start,stop,build,redev}.sh
```

真正的 handler 分散在 6 个 `*-api` 模块里：

```
resource-api/pkg/
├── resource/handler.go     ← 聚合 handler：把下面 6 个子域组合成一个 routers.Handler
├── bizlines/handler.go        /bizline/*
├── resources/handler.go       /resource/accounts, /resource/account, ...
├── devices/handler.go         /resource/devices, /resource/device/detail, /resource/heartbeat, ...
├── proxies/handler.go         /resource/proxies, ...
├── contacts/handler.go        /resource/contacts, ...
└── bindings/handler.go        /resource/binding/*, /resource/bindings

task-api/pkg/{task,tasks,templates,commands,agents,executionguard}/
risk-api/pkg/{risk,health,gates,survival,attribution}/
strategy-api/pkg/{strategy,strategies,lifecycle,admission}/
aisched-api/pkg/{aisched,agents,scenes,decisions}/
orchestration-api/pkg/{orchestration,boards,runs,timelines,reviews,remote}/
```

每层的聚合包名 = 层名（`pkg/resource`、`pkg/task`、`pkg/risk`…），子域包名 = 复数资源名。

## 2. 为什么这么放

`resource-api/pkg/resource/handler.go` 的注释把理由写清楚了：

> 实际 API 按资源类型拆在各自的子包中。这样资源服务未来独立部署或继续拆分时，
> API 归属不需要从 web-api 回迁，也不会形成一个不断增长的 Handler。

三个收益：

1. **拆分时零迁移。** `resource-api/main.go` 已经写好了，独立部署就是 `go build ./resource-api` 加起进程，handler 代码原地不动。
2. **不长成巨型 Handler。** 一层十几个接口塞一个文件，半年后没人敢改。按资源类型拆，一个文件对应一个前端页面组。
3. **归属即边界。** 「这个接口属于哪一层」在目录上就是确定的，不靠约定。

**唯一必须遵守的规则：**

> 新增接口 → 写进 `{对应层}-api/pkg/{子域}/handler.go`。
> `web-api/pkg/` 下**只允许**放 `local/` 装配适配器，不放任何 handler。

判断层归属：看这个接口读写哪个表前缀（`zt_resource_*` → resource-api，`zt_task_*` → task-api，以此类推），或者看它调哪个 `service/{domain}`。

## 3. 聚合 handler 的写法

`{层}-api/pkg/{层}/handler.go` 是个纯组合器，没有业务：

```go
// Package resource 负责资源服务的 HTTP 入口组合。
package resource

type Handler struct {
	handlers []routers.Handler
}

func NewHandler(resourceService resource.Service, bizLineService bizlineservice.Service) *Handler {
	return &Handler{handlers: []routers.Handler{
		bizlines.NewHandler(bizLineService),
		resources.NewHandler(resourceService),
		devices.NewHandler(resourceService),
		proxies.NewHandler(resourceService),
		contacts.NewHandler(resourceService),
		bindings.NewHandler(resourceService),
	}}
}

func (h *Handler) RegisterHandler(group *gin.RouterGroup) {
	for _, handler := range h.handlers {
		handler.RegisterHandler(group)
	}
}

var _ routers.Handler = (*Handler)(nil)
```

`NewHandler` 的参数是**领域 Service 接口**，不是 `*gorm.DB` —— 谁 new service 由装配点决定，handler 不关心是本地实现还是 HTTP 客户端。

新增子域时，改这个文件的列表就是全部注册工作；`web-api/routers/register.go` 不用动。

## 4. 两种运行形态

### 形态 A：聚合（当前）

```
                    web-api :10001
   ┌──────────────────────────────────────────────┐
   │  /api                                        │
   │   ├── resourceapi.NewHandler(resourceSvc,…)  │
   │   ├── taskapi.NewHandler(taskSvc)            │
   │   ├── riskapi.NewHandler(riskSvc)            │
   │   ├── strategyapi.NewHandler(strategySvc)    │
   │   ├── aischedapi.NewHandler(aischedSvc)      │
   │   └── orchestrationapi.NewHandler(orchSvc)   │
   │                                              │
   │  service 之间用本地实现直连（+ local 适配器） │
   └──────────────────────────────────────────────┘
```

跨层调用是**同进程函数调用**，零网络开销，无分布式事务问题（同一个 `*gorm.DB`）。

### 形态 B：独立部署（目标）

```
resource-api :9101   task-api :9102   risk-api :9103
strategy-api :9104   aisched-api :9105   orchestration-api :9106
```

跨层调用变成 HTTP，实现由 `client` module 提供：

```go
riskClient := client.NewRisk(httpx.MustRemote(serviceName, "risk"), token)
taskSvc    := task.New(database, riskClient, resourceClient, riskClient, bizLineClient)
```

`client/assert.go` 应有编译期断言，保证 HTTP 实现与本地实现签名一致。

**代价（`SERVICES.md` 已记录）：** `task-api` 每次下发要跨进程调 resource 取绑定、调 risk 过闸门 —— 两次网络往返落在同步链路上。成为瓶颈时把某个依赖换回本地实现即可（改 main.go 一行），领域代码不动。

## 5. 拆分为独立服务：待补齐的东西

`{层}-api/main.go` 已经全部写好了，但依赖的东西还不存在。按此顺序补：

**① `server/client/` 模块（不存在）**

```
client/
├── go.mod                     module client；require contract, service, common
├── assert.go                  编译期断言：var _ task.BindingReader = (*Resource)(nil) 等
├── resource.go                NewResource(baseURL, token) → 实现 task/orchestration 需要的读接口
├── task.go                    NewTask(...)
├── risk.go                    NewRisk(...)      → 同时满足 task.Gate 和 task.ResultSink
├── strategy.go                NewStrategy(...)  → 同时满足 risk.StrategyReader/Writer、orch.StrategyReader/AdmissionChecker
├── aisched.go                 NewAISched(...)
└── bizline.go                 NewBizLine(...)   → 端侧能力集，地址复用 resource
```

每个客户端方法把参数编成请求打到对方的 HTTP 接口，解 `{success,code,data,message,error}` 信封，`success==false` 时返 error。请求头带 `X-Service-Token`，需要业务线时带 `X-Biz-Line`。

同步链路上的接口（`/risk/gate/check`、`/risk/results`、`/aisched/decide`、`/strategy/calibration/apply`）必须设超时，并把 `ctx` 传进 `http.NewRequestWithContext`。

补完后同步 `go.work` 的 `use` 列表加上 `./client`。

**② `httpx` 缺的四个函数**

```go
func Serve(serviceName string, register func(*gin.RouterGroup)) // 建 engine + /healthz + /api 组 + 读 service.port.<name> + 优雅关闭
func MustRemote(serviceName, downstream string) string          // 读 service.url.<downstream>，缺则 panic
func MustServiceToken(serviceName string) string                // 读 service.token，缺则 panic
func MustAgentSecret() string                                   // 读 agent.secret，缺则 panic
func DeviceToken(secret, deviceID string) string                // HMAC-SHA256(device_id, agent.secret)
```

`SERVICES.md` 明确要求：**下游地址、`service.token`、`agent.secret` 缺失时服务启动即失败**，不能等第一次业务调用才炸在链路里。

**③ 鉴权中间件（目前 4 个 `Require*` 全是 passthrough）**

| 调用方 | 凭证 | 校验方式 |
|---|---|---|
| 控制台用户 | `Authorization: Bearer <token>` | 读 Redis `auth:token:*`，复用 web-api 的登录，本侧不做登录 |
| 端侧 App | `X-Device-Id` + `X-Device-Token` | `HMAC-SHA256(device_id, agent.secret)`，无状态 |
| 跨层服务 | `X-Service-Token` | 与 `service.token` **定长比较**（`hmac.Equal`），client 自动带上 |

`CallerID(context)` 落地后必须返回**凭证认定**的身份（当前是读 `X-User-ID` 头 + 默认 `local-console`，这是占位实现）。

选 HMAC 派生而非查库，是因为 `/task/poll` 是全系统调用量最大的接口，每次回查设备表会让鉴权本身成为瓶颈。吊销靠轮换 `agent.secret`，或业务层按 `device_id` 拉黑。

**④ 配置扩展**

当前 `configs/application.properties` 只有 `sqlconn` 等少量键，`httpx.Boot` 是个手写的 properties 解析器。要支持 `service.port.*` / `service.url.*` / `service.token` / `agent.secret` / `redis.*`，要么扩展 properties 键（`service.url.risk=http://...`），要么切到 Viper + YAML（`SERVICES.md` 假设的是 YAML）。**先定这一件，再写 ② ③**，否则会写两遍。

**已知边界（`SERVICES.md` 记录）：** `service.token` 是部署内单一共享密钥，能证明「调用来自集群内」，不能区分是哪一层在调。要做到按层最小权限得换成每服务一份密钥或 mTLS。内网部署够用，对外暴露前需升级。

## 6. 拆某一层的操作清单

以拆 `resource-api` 为例（它无下游，最简单，应该第一个拆）：

1. 确认 `resource-api/pkg/` 下 handler 齐全，且没有任何接口漏在 `web-api` 里。
2. `resource-api/configs/application.properties` 就位（或共享配置目录），`service.port.resource-api=9101`。
3. 补 `httpx.Serve`。
4. `go build -o bin/resource-api ./resource-api` 起进程，验 `/healthz` 与几个业务接口。
5. `web-api/routers/register.go` 里**移除** `resourceapi.NewHandler(...)`，其余层对 resource 的依赖从 `resourceService` 换成 `client.NewResource(...)`。
6. 前端网关（`client/web` 的 `SERVER_TARGET` / `src/pages/api/[...all].js` 代理）按前缀分流到新端口，或在 nginx 层做。
7. `web-api/go.mod` 移除 `resource-api` 的 require/replace（若不再直接引用）。

先拆无下游的层（resource、strategy），最后拆 orchestration（依赖最多）。

## 7. 前端侧的对应关系

前端 API 层也是**按页面各自归属**的（`src/app/(console)/{page}/api/{name}.api.ts`），和后端「API 归各层自己」是同一个思路。

前端目前统一走 `/api/*`，由 Next.js 的 `src/pages/api/[...all].js` 代理到 `SERVER_TARGET`。后端拆分后前端**不需要改任何 api 文件** —— 分流在代理层做。这是把代理保留在前端而非让浏览器直连各服务的原因。

路径前缀与层的对应（前端排查时用）：

| 路径前缀 | 层 | 独立后端口 |
|---|---|---|
| `/bizline/*` | 0 | 9101（挂 resource） |
| `/resource/*` | 1 | 9101 |
| `/task/*` | 2 | 9102 |
| `/risk/*` | 3 | 9103 |
| `/strategy/*` | 4 | 9104 |
| `/aisched/*` | 5 | 9105 |
| `/orchestration/*` | 6 | 9106 |
