---
name: backend-development
description: 掌天瓶 Go 服务端开发技能。涵盖 go.work 多模块布局（contract / common / service / *-api）、6 层业务分层与依赖 DAG、领域包 + ports.go 接口注入、API 层按服务归属拆分（当前聚合在 web-api，后续独立部署时 API 不回迁）、GORM Repository + internal 单写约束、统一响应与三类鉴权、跨层调用的本地/远程双实现。适用于新增接口、新增领域模块、拆分独立服务、设计表结构或排查跨层依赖问题。
license: MIT
version: 1.0.0
---

# 掌天瓶 Go 服务端开发

`server/` 是一个 **go.work 多模块仓库**，按「6 层业务 + 6 个可独立部署的 API 服务」组织。

## When to Use

- 新增 / 修改 HTTP 接口（该放哪个 `*-api/pkg/{子域}/`）
- 新增领域模块（`service/{domain}/`）或新增一层
- 把某层从 `web-api` 聚合进程里拆成独立服务
- 设计表结构、写 Repository、加索引
- 处理跨层调用（ports 接口 + 本地/远程双实现）
- 排查「领域包互相 import」这类架构劣化

## 技术栈

| 组件 | 选型 |
|------|------|
| 语言 | Go 1.21（go.work 多模块） |
| Web 框架 | Gin v1.10 |
| ORM | GORM v1.23 + MySQL |
| 配置 | `configs/application.properties`（key=value，`httpx.Boot` 解析） |
| 泛型仓储 | `common/middleware/db.Repository[T]` |
| 统一响应 | `common/middleware/httpx.JSON` / `httpx.Fail` |
| 路由契约 | `common/middleware/routers.Handler` |

## Reference Navigation

`references/` 下每篇 7k-13k 字符，**按需下钻，不要开局先读**：读进来的正文会在本轮之后的每一次模型请求里被重发一遍。常规改动（改已有 handler、加字段、调查询、修 bug）靠本文件的「Key Best Practices」「常用文件索引」和真实代码就够；只有下面对得上号时才打开对应那一篇，且只读相关章节。

**架构与边界（新增一层、跨层调用、领域包依赖出问题时读）：**
- `references/backend-architecture.md` — 模块布局、6 层依赖 DAG、`contract` 与 `ports.go` 的分工、`internal` 单写约束、装配（wire）在哪、本地 vs 远程双实现
- `references/backend-api-service-layout.md` — **API 层归属规则**：为什么 handler 写在 `{层}-api/pkg/` 而不是 `web-api/`，聚合期与独立期分别怎么装配，拆分时改哪几行

**编码规范（新增接口或新增子域时读；改已有接口不用）：**
- `references/backend-api-design.md` — Handler 包结构、路由与鉴权声明、DTO 三件套、统一响应、bizLine 取值、新增接口检查清单
- `references/backend-data-layer.md` — GORM Entity 规范、表命名 `zt_{层}_{实体}`、索引以 `biz_line` 打头、Repository 写法、三条全局表规则

**流程向导（从零新增子域或整层时读）：**
- `references/backend-new-module-guide.md` — 新增一个接口 / 一个子域 / 一整层的分步清单

## 核心分层

两条正交的轴，别混起来看：

```
业务纵向 6 层（依赖 DAG，无回边）
  0 业务线 bizline ── 横切维度，档案挂在 resource 下
  1 资源     resource      ← 无下游
  2 任务     task          → risk, resource, bizline
  3 风控     risk          → strategy, resource
  4 策略     strategy      ← 无下游
  5 AI 调度  aisched       → 外部 LLM（可缺，缺则规则模式）
  6 编排     orchestration → 上面全部

代码横向 3 段
  {层}-api/pkg/{子域}/handler.go   HTTP 入口：绑参、鉴权、调 service、响应
  service/{domain}/{domain}.go     领域逻辑：Service 接口 + 实现，返回 DTO
  service/{domain}/internal/repository/  持久化：Entity + GORM 查询（Go internal 保护）
```

**唯一的跨模块数据形状是 `contract/types.go`**，领域包之间**禁止互相 import**。需要别的层的能力时，在自己的 `ports.go` 里声明最小接口，由 API 的 `main.go` 注入实现。

## API 层归属（本项目最容易搞错的一条）

当前 6 层的 HTTP 服务**聚合在 `web-api` 一个进程里跑**（`:10001`），但**每层的 handler 代码不在 `web-api` 里**，而是各自放在自己的模块下：

```
resource-api/pkg/{bizlines,resources,devices,proxies,contacts,bindings}/handler.go
task-api/pkg/{tasks,templates,commands,agents,executionguard}/handler.go
risk-api/pkg/{health,gates,survival,attribution}/handler.go
strategy-api/pkg/{strategies,lifecycle,admission}/handler.go
aisched-api/pkg/{agents,scenes,decisions}/handler.go
orchestration-api/pkg/{boards,runs,timelines,reviews,remote}/handler.go
```

每个模块有一个**聚合 handler**（`{层}-api/pkg/{层}/handler.go`）把子域组合成一个 `routers.Handler`。
`web-api/routers/register.go` 只做两件事：new 出各层 service（本地实现互相直连），然后把 6 个聚合 handler 注册到 `/api`。

> **规则：新增接口一律写进对应的 `{层}-api/pkg/{子域}/`，绝不写进 `web-api/pkg/`。**
> `web-api/pkg/local/` 只放**本地装配适配器**（把 A 层的 Service 适配成 B 层 `ports.go` 要的接口形状），不放业务 handler。
> 这样后续某层独立部署时，API 归属不需要从 `web-api` 回迁，`{层}-api/main.go` 直接就能起。

详见 `references/backend-api-service-layout.md`。

## Key Best Practices

**分层：** Handler 不写业务逻辑（绑参 → 调 service → `httpx.JSON`）；Service 返回 DTO + error；Repository 只做查询，不做判断。领域包之间零 import。

**契约：** 跨层数据形状放 `contract/types.go`；跨层能力用调用方自己的 `ports.go` 接口声明；实现在 `main.go`/`register.go` 注入。

**响应：** 一律 `httpx.JSON(context, data, err)`，成功 `{success:true,code:0,data,message:"请求成功",error:null}`，失败 `{success:false,code:-1,...}` —— 注意**失败也返 HTTP 200**，前端靠 `success` 判定。绑参失败用 `httpx.Fail(context, err.Error())`。

**鉴权：** 每条路由**显式**声明 `httpx.RequireUser()` / `RequireDevice()` / `RequireService()` / `RequireUserOrService()`，不用路径前缀猜。写配置 → User；同步链路内部接口 → Service；只读双用 → UserOrService；远控真机 → 只允许 User。

**业务线：** 每张表都带 `biz_line`，所有接口都要求带上。Handler 里统一 `contract.BizLine(httpx.BizLine(context))`（查询参数 `bizLine` → 头 `X-Biz-Line` → 默认 `whatsapp`），Service 入口 `if !bizLine.Valid() { return contract.ErrBizLineRequired }`。

**端侧不可信：** `/task/poll`、`/resource/heartbeat` 这类端侧接口，必须用凭证认定的 `httpx.CallerID(context)` **覆盖**请求体里的 `deviceID`。

**表设计三条铁律：** 跨层不建外键；跨层引用一律用字符串业务键（`account_id`/`device_id`/`task_id`），自增 `id` 只在层内用；每张表带 `biz_line` 且所有索引以它打头。另有一条只对任务实例成立：运行时快照必须冻结 `template_version` / `strategy_version` / `decision_id`。

**单写约束：** 绑定表只有 `service/resource` 能写 —— 由 `service/*/internal/repository` 的 Go internal 规则在编译期保证，跨进程同样有效。其余层走「申请占用 → 使用 → 释放」。

## 已知状态（写代码前先确认）

- **`server/client/` 模块目前不存在**，但 `task-api` / `risk-api` / `orchestration-api` 的 `go.mod` 已 `replace client => ../client`，且 `main.go` 已在调 `client.NewRisk(...)`、`httpx.Serve`、`httpx.MustRemote`、`httpx.MustServiceToken` —— 这些**都还没实现**。因此 `go build` 在 go.work 下整体失败。
- `common/middleware/httpx` 目前只有 `Boot` / `JSON` / `Fail` / `BizLine` / `CallerID` 四个 `Require*`，且**四个 `Require*` 全是 passthrough 空实现**，鉴权尚未落地。
- 独立部署形态、配置键、鉴权凭证的设计意图在 `server/SERVICES.md`，表设计在 `server/SCHEMA.md` —— 两份文档描述的是**目标态**，实现进度以代码为准。

补齐路径见 `references/backend-api-service-layout.md` 的「拆分为独立服务」一节。

## 常用文件索引

| 用途 | 路径 |
|------|------|
| 跨层数据形状 | `contract/types.go` |
| 泛型仓储 / 全局 DB | `common/middleware/db/repository.go` |
| 启动、响应、鉴权、bizLine | `common/middleware/httpx/httpx.go` |
| 路由契约 | `common/middleware/routers/handler.go` |
| 聚合进程装配 | `web-api/routers/register.go` + `web-api/pkg/local/adapters.go` |
| 聚合进程路由根 | `web-api/routers/router.go`（`/healthz` + `/api` 组） |
| 服务清单 / 端口 / 鉴权设计 | `server/SERVICES.md` |
| 全量表设计 | `server/SCHEMA.md` |
