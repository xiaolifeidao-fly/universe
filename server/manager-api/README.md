# manager-api

管理端（`client/manager`）的独立 API 服务。

它有**自己的一套账号与权限体系**（`service/manager` / `zt_manager_*`），
和 `client/web`、App 用的业务用户（`service/identity` / `zt_identity_user`）是两套东西：
没有外键、没有数据关联、令牌互不通用。**web 控制台的业务账号登不进管理端，这是有意的。**

分开的理由有两条。一是管理端的处置动作会动真钱——封禁节点、裁决争议（在三本账上记
反向流水）、发算力密钥、改业务线授权；合成一套的话，一个业务账号就能进到这些地方。
二是业务用户那边的授权只有 `role=admin` 一个布尔，配不出「这个人能看池水位但不能封节点」。

管理端**管理业务用户的能力不变**：`/api/users` 那几个接口读写的仍然是
`zt_identity_user`，只是操作它的人换成了管理端账号。同样地，业务线与项目管理
背后还是 `service/bizline` / `service/delivery`。

共享算力池（Galaxy）是第三套账号：共享端 / 使用端的用户在 `zt_galaxy_user`
（`service/galaxy/account`），和前两套都不通。管理端通过 `/api/galaxy/admin/users*`
翻账号、停用、重置密码，通过 `/api/galaxy/admin/provider/type` 把共享端账号设成工作室。
**共享池的运营接口只在这里**：galaxy-api 上原来那组认任务宇宙管理员的 `/api/galaxy/admin/*`
已经删掉，发内测密钥、人工确认到账、门户模型目录与线索一并挪了过来。

## 技术选型（对齐 universe 现有 server，不是照抄 shennong）

`server/` 已经是 Gin + GORM + MySQL + `go.work` 多模块的约定（`web-api`、`app-api` 都是这么写的），shennong 的 `server/manager-api` 用的是它自己那份更早期的 `common`（`vipper` 配置、`GinRouter`、`service/manager_auth`），和 universe 现在的 `common`/`service` 模块形状不兼容，没有照搬。这个模块的分层、启动方式、配置格式、CORS、健康检查全部照 `app-api` 抄（它是仓库里最新的一个独立部署服务范例）。

## 分层

```
manager-api/
├── main.go                装配：开 DB、连 Redis、New 出 manager/identity/bizline/delivery、起 HTTP
├── auth/auth.go           鉴权中间件（挂在 /api 整组上）+ 公开路由白名单
├── routers/
│   ├── router.go          gin 引擎 + CORS + /healthz + /api 分组 + 启动自检
│   └── cors.go            跨域白名单
├── cmd/managerinit/       建表 + 登记资源 + 写入默认角色与默认管理员
└── pkg/
    ├── tokenstore/redis.go    manager.TokenStore 的 Redis 实现（会话 + 反向索引 + ACL 版本号）
    ├── console/handler.go     管理端自己的账号、角色、资源、授权
    ├── users/handler.go       业务用户管理（背后是 service/identity）
    ├── bizlines/handler.go    业务线（空间）管理
    └── programs/handler.go    交付项目管理
```

`service` / `repository` / `dto` 这三层没有在 `manager-api` 里新建——四个子域背后都是 `service/{identity,bizline,delivery}` 现成的 `Service` 接口、`internal/repository` 和 `dto` 包。`manager-api/pkg/{domain}/handler.go` 只做绑参、鉴权、调用、`httpx.JSON` 这四件事，和 `delivery-api/pkg/{identity,bizlines,programs}/handler.go` 是同一套服务，只是换了一套鉴权语义（见下）——这是仓库里所有 API 服务共同的规矩，见 `.claude/skills/backend-development` 技能文档。

### 鉴权：数据驱动，不写在路由上

**路由上不再挂 `httpx.Require*`**，鉴权是一道中间件挂在 `/api` 整组上。
写在路由上的静态声明表达不了「这个角色能看不能改」——那得是配出来的。

每个请求三步：

1. 取令牌 → 从 Redis 读会话（滑动续期）；
2. 按 **`c.FullPath()`（gin 的路由模板，如 `/api/users/:id`）+ HTTP 方法**
   查资源，再查这个人的角色有没有被授权。**查不到资源就拒**——忘了登记是配置疏漏，
   按放行处理等于新接口天生对所有人开放；
3. 写方法（POST/PUT/PATCH/DELETE）再过一道角色的 `writable` 开关。

两道门叠加的理由：只有资源授权配不出「这个角色临时只读」（要逐条撤销写资源），
只有 `writable` 配不出「能改用户、不能封节点」。

唯一的例外是 `super_admin` 角色，它**绕过资源过滤**——一次配错授权就能把所有人
关在门外，必须留一条改回来的活路。

中间件验证通过后会同时往 gin context 里塞一份 `httpx.UserPrincipal`，
所以 `pkg/{users,bizlines,programs}` 里那几处 `httpx.CallerID/CurrentUser`
（审计字段）不用改。

### 接口资源不手写

`cmd/managerinit` 遍历 `engine.Routes()` 生成接口资源，按 code 幂等 upsert。
手写清单和真实路由迟早分叉，而分叉的后果是「登录用户一律 403」——一个看起来像
bug 的配置故障。进程启动时还会再比对一次，把没登记的路由打进日志：

```
manager-api: 3 条路由未在资源表登记，登录用户一律访问不到（跑 cmd/managerinit 补齐）：
  POST /api/users/:id/delete
```

### 令牌在 Redis，所以 Redis 是启动硬依赖

用外部存储而不是无状态签名令牌，图的是**即时吊销**：撤权、禁用、改密必须当场生效，
不能等令牌自然过期。另有 `manager:user:{id}:tokens` 反向索引，用来按人踢掉全部会话——
只删当前令牌的话，那个人另一台机器上还开着。

连不上 Redis 时进程直接退出，不起一个每个登录请求各失败一次的服务；
运行中 Redis 不可用时鉴权**拒绝**，不降级放行。

## 接口

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/healthz` | 无 | 健康检查 |
| POST | `/api/auth/login` | 无 | 管理端账号登录，返回 token（Redis 里的随机串，不携带信息） |
| POST | `/api/auth/logout` | 会话 | 删除当前令牌 |
| GET | `/api/current-user-menus` | 会话 | 按角色过滤的资源树，前端导航由它驱动 |
| GET/POST | `/api/manager/accounts*` | 资源授权 | 管理端账号 CRUD、分配角色、重置密码、禁用 |
| GET/POST | `/api/manager/roles*` | 资源授权 | 角色 CRUD 与授权 |
| GET/POST | `/api/manager/resources*` | 资源授权 | 资源 CRUD |
| GET | `/api/auth/me` | 会话 | 当前用户 + 角色 + **`writable`**（前端只读开关的唯一来源） |
| POST | `/api/auth/password` | 会话 | 改自己的密码，改完踢掉自己全部会话 |
| GET | `/api/users?pageIndex=&pageSize=&keyword=&role=&persona=&status=` | 资源授权 | 用户分页列表 |
| GET | `/api/users/:id` | 资源授权 | 用户详情 |
| POST | `/api/users` | 资源授权 | 新建用户 |
| POST | `/api/users/:id` | 资源授权 | 更新用户 |
| POST | `/api/users/:id/password` | 资源授权 | 管理员重置某用户密码 |
| POST | `/api/users/:id/delete` | 资源授权 | 删除用户（不能删自己，`service/identity` 内置这条保护） |
| GET | `/api/bizlines` | 资源授权 | 全部业务线（含已停用），管理员视角，不做可见性过滤 |
| POST | `/api/bizlines` | 资源授权 | 新建或更新业务线（`code` 已存在即更新） |
| POST | `/api/bizlines/delete` | 资源授权 | 删除业务线 |
| GET | `/api/bizlines/members?code=` | 资源授权 | 业务线成员列表 |
| POST | `/api/bizlines/member/permission` | 资源授权 | 设置成员读写/管理权限 |
| POST | `/api/bizlines/member/remove` | 资源授权 | 移除成员 |
| GET | `/api/programs?bizLine=` | 资源授权 | 某业务线下的项目列表 |
| GET | `/api/programs/:id` | 资源授权 | 项目详情（内部会先按项目 ID 反查所属业务线） |
| POST | `/api/programs?bizLine=` | 资源授权 | 新建项目 |
| POST | `/api/programs/:id` | 资源授权 | 更新项目 |

## 默认管理员与「必须改初始密码」

`managerinit` 建出来的默认管理员是 `must_change_password=true`。中间件把这个判断
放在资源检查**之前**（否则超级管理员会绕过去，初始密码永远留在库里），只放行
`/auth/me`、`/auth/password`、`/auth/logout` 三条自助路由。

`client/manager` 的外壳拿到 `mustChangePassword=true` 会**强制弹出改密弹窗且不给关**——
带着初始密码的账号除了改密什么都调不动，关掉弹窗只会得到一个点什么都失败的页面。
改完之后后端会删掉这个人的全部会话，前端据此跳回登录页。

（注意这里和 `httpx.requireChangedPassword` 无关：那个函数未导出、且把
`/api/auth/me`、`/api/auth/password` 两条路径写死在里面，只能整个 `Require*` 一起用。
管理端自己写中间件，反而没有那个路径耦合。）

## 启动前

基于 [`configs/application.example.properties`](configs/application.example.properties) 在运行目录创建 `configs/application.properties`：

- `sqlconn` 填和 `web-api`/`app-api` **相同**的连接串（同一个库；管理端账号是独立的
  一套表，共用一个库只是因为它们本来就在同一个实例上）
- `redis.addr` **必填**，管理端的登录令牌存在这里，连不上进程直接退出
- `auth.token_secret` 只给 `service/identity` 用（`/api/users` 那几个页面读写的是业务用户）。
  管理端自己的登录不用它
- `manager.cors_origins` 填 `client/manager` 部署后的来源；本地开发默认 `http://localhost:7895`
- `auth.default_username`/`auth.default_display_name`/`auth.default_password`：
  给下面的初始化命令用

初始化（幂等，可以反复跑）：

```bash
cd server/manager-api && go run ./cmd/managerinit
```

它建表、按真实路由表登记接口资源、写入三个默认角色（`super_admin` / `operator` /
`viewer`）、创建默认管理员并绑上 `super_admin`。已存在的账号不会被重置密码，
已有的角色授权不会被抹掉（授权取并集）。

### 只用 SQL 初始化

变更以 SQL 形式提交给 DBA、或者在远端库上手工执行的话，两份文件按顺序跑：

```sql
-- 1. 建表
source server/manager.sql
-- 2. 角色、资源、超级管理员、授权
source server/manager_seed.sql
```

**第二份不要手改**——里面的接口资源是从真实 gin 路由表导出的，手改会和代码分叉，
而分叉的现象是「登录用户一律 403」。改了路由之后重新生成：

```bash
cd server/manager-api && go run ./cmd/managerseed -password '你的初始密码' > ../manager_seed.sql
```

`managerseed` 不连数据库、不读配置：路由表是把 handler 注册一遍拿到的（服务实例传
nil，注册阶段只把接口存下来不会调用它们），密码哈希当场用 bcrypt 算。
它和 `managerinit` 共用同一份资源编码算法，所以两条路建出来的数据一致。

仓库里那份 `manager_seed.sql` 的初始密码是 `Manager@2026`，**账号是「必须改密」
状态**，首次登录会被强制要求改掉。不想让这个密码进版本库的话，用上面的命令
自己生成一份，别提交。

## 本地运行

```bash
cd server/manager-api
go run .
```

默认监听 `:10003`（`web-api` 概念上是 `:10001`、实际部署配的 `:8691`；`app-api` 是 `:10002`），可用 `MANAGER_API_ADDR` 环境变量覆盖。也可以用 `./start.sh` / `./stop.sh` / `./redev.sh`（改完代码重新编译重启），行为和 `app-api` 的同名脚本一致。

```bash
curl http://127.0.0.1:10003/healthz
curl -X POST http://127.0.0.1:10003/api/auth/login -H "Content-Type: application/json" -d '{"username":"admin","password":"admin123"}'
curl http://127.0.0.1:10003/api/auth/me -H "token: <上面拿到的 token>"
curl "http://127.0.0.1:10003/api/users?pageIndex=1&pageSize=20" -H "token: <token>"
curl "http://127.0.0.1:10003/api/bizlines" -H "token: <token>"
curl "http://127.0.0.1:10003/api/programs?bizLine=<某业务线编码>" -H "token: <token>"
```

## 验证

**已验证**：`go vet` / `go test` 全绿；权限判定的十条规则有单测覆盖（超级管理员绕过、
未登记路由默认拒绝、同一路径的 GET 与 POST 分得开、`writable` 是第二道门、
没有角色一律拒、路由模板匹配而不是具体路径、祖先菜单补齐）；中间件层另有五条
（登录接口公开、无令牌被拒、领域层收到的是路由模板、`httpx.UserPrincipal` 投影、
Bearer 头解析）。`client/manager` typecheck 与 build 通过。

**未验证**：本机没有 MySQL 和 Redis，`managerinit` 与端到端登录没有真跑过。
下面这几条要在有库有 Redis 的环境里过一遍：

1. `go run ./cmd/managerinit`，确认六张表、三个角色、接口资源数量、默认管理员；
2. 启动 `manager-api`，看日志里的**未登记路由自检**是空的；
3. 用默认管理员登录 → 强制改密弹窗 → 改完跳回登录页 → 新密码能进；
4. 建一个 `viewer` 角色的账号 → 菜单在、13 处写控件全部消失；手输 `/users` URL
   仍进得去页面，但接口 403（前端守卫只挡菜单点击，**后端才是真正的门**）；
5. 撤掉某角色对 `/galaxy` 页面的授权 → 该用户菜单里 galaxy 消失；
6. 禁用某账号 → 它已登录的会话**立刻**失效；
7. 用 web 控制台的业务账号登管理端 → 登不进去。

## TODO

- [ ] 项目管理目前只有核心的 list/get/create/update；`delivery-api/pkg/programs` 还有的 Git 配置、云同步配置、迁移项目、里程碑/模块 CRUD、成员分配没有对应路由，需要时照 `delivery-api/pkg/programs/handler.go` 的形状加
- [ ] 资源表里的菜单/页面目前由 `managerinit` 写死；后台的资源 CRUD 接口已经有了，
      但还没有一个像样的「新建菜单」表单（现在得直接调接口）
- [ ] 登录失败次数限制的字段已经在 `Config` 里（`MaxLoginFail` / `LoginFailWindow`），
      但还没接上——`zt_manager_login_record` 已经在记失败了，缺的是读它的那一步
