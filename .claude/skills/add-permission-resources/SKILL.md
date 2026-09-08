---
name: add-permission-resources
description: 当用户要求为本次上下文新增的管理端接口或页面补齐权限资源时使用。用户通常只给 role_id（不给就默认 1），本技能输出插入 zt_manager_resource 与 zt_manager_role_resource 的幂等 SQL，并提示必须同步改的源头文件与缓存失效动作。适用于本仓库 manager-api / client/manager 的权限资源补齐。
license: MIT
version: 1.0.0
---

# 新增管理端权限资源

## 目标

根据当前对话或当前代码改动中新增的管理端接口 / 页面，输出可直接执行的权限资源 SQL：

- `zt_manager_resource` 插入（菜单 / 页面 / 接口）
- `zt_manager_role_resource` 角色绑定
- 让运行中的 manager-api 重新加载权限的一句话

只输出 SQL 和必要的简短说明；不要修改代码，除非用户明确要求落库或改源头文件。

**`role_id` 默认取 `1`**，用户没提就直接用 1，不要反问。

---

## 先看清楚：这个仓库不是 shennong

照搬 shennong 的那份 SQL 会全错，三处硬差异：

| 维度 | shennong | 本仓库 |
|------|----------|--------|
| 表名 | `resource_new` / `role_resource_new` | `zt_manager_resource` / `zt_manager_role_resource` |
| 有效位 | `active = 1` | `status = 'active'` |
| 接口分组 | 有 `api_group` 一层 | **没有**。接口资源一律 `parent_id = 0`，平铺 |
| 接口身份 | 只按 `resource_url` | `(method, resource_url)` 二元组，同路径 GET / POST 是两条资源 |
| 接口 code | 手起 `{domain}:{action}` | **算法生成，不能手起**（见下） |
| 权限判定 | 每请求查库 | 进程内 ACL 缓存，改完库必须让缓存失效 |
| 生成方式 | 全手写 SQL | 接口资源由 `cmd/managerinit` 从真实路由表同步 |

还有一条容易踩：`created_time` / `updated_time` 是 `datetime(3) NULL` 且**没有数据库默认值**（GORM 用 `autoCreateTime` 在应用层填）。手写 SQL 必须自己写 `NOW(3)`，否则落一行 NULL 时间。

---

## 优先走源头，SQL 是兜底

本仓库的接口资源**不该手写**。正常路径是：

```bash
cd server/manager-api && go run ./cmd/managerinit
```

它幂等，可反复跑：按 `code` 冲突更新不重建（重建会换掉资源 id，把所有角色授权作废）、角色与默认管理员已存在就跳过、授权取并集不抹掉后台调过的权限。接口资源直接从 `routers.Routes(engine)` 生成，不会和真实路由分叉。

**只有这两种情况才给 SQL：**

1. 目标环境跑不了 `managerinit`（只有一个数据库连接，比如生产库）；
2. 只补角色绑定，不想连带触发 `managerinit` 的全量授权。

给 SQL 时也要一并说明源头该怎么改，否则下次谁跑一遍 `managerinit`，手写的资源和它生成的会打架。

---

## 资源类型一览

| resource_type | 含义 | parent_id | method | resource_url | page_url | icon |
|---------------|------|-----------|--------|--------------|----------|------|
| `menu` | 菜单分组 | `0` | 空 | 空 | 空 | antd 图标名 |
| `page` | 叶子页面 | `0` 或父 menu 的 id | 空 | 空 | 前端路由 | 顶层页面填，子页面留空 |
| `api` | 单个接口 | 固定 `0` | `GET`/`POST`/… | gin 路由模板 | 空 | 空 |

与 shennong 不同：**顶层页面的 `parent_id` 就是 0**，不需要先造一个 menu。只有确实要收进折叠分组时才建 menu（现在只有「系统设置」这么干）。

前端两处剪枝：没有 `page_url` 的 `page` 不出现在菜单里，没有有效子节点的 `menu` 也不出现。

---

## 页面资源

### 现有页面（勿重复插入）

```text
dashboard          仪表盘        page  parent=0  /dashboard          DashboardOutlined  sort=10
users              用户管理      page  parent=0  /users              TeamOutlined       sort=20
businessLines      业务线管理    page  parent=0  /business-lines     BranchesOutlined   sort=30
programs           项目管理      page  parent=0  /programs           FolderOutlined     sort=40
galaxy             共享算力池    page  parent=0  /galaxy             GlobalOutlined     sort=50
settings           系统设置      menu  parent=0  （无 page_url）      SettingOutlined    sort=90
settingsAccounts   管理端账号    page  parent=settings  /settings/accounts             sort=91
settingsRoles      角色与权限    page  parent=settings  /settings/roles                sort=92
```

新增顶层页面的 `sort_id` 从 `60` 起往上排，别撞进 90 段（那是系统设置的地盘）。

### code 就是 i18n 键

页面 `code` 同时是前端取文案的键：`t("nav." + code)`，查不到才回落到库里的 `name`。所以新增页面必须同步加两处翻译，**改 code 等于改文案键**。

### page_url 必须对得上真实路由

`page_url` 是 `client/manager/src/app/(console)/` 下的实际路由。不存在的路由会让人点进 404。

### icon 走白名单

`icon` 存 antd 图标名，前端在 `MENU_ICONS` 里查组件，查不到就不显示图标（不报错）。现有白名单：

```text
DashboardOutlined  TeamOutlined  BranchesOutlined  FolderOutlined
GlobalOutlined     SettingOutlined  SafetyCertificateOutlined  KeyOutlined
```

要用白名单外的图标，得先改 `ManagerShellStub.tsx`，光写进库里不生效。

### SQL 模板

```sql
-- 顶层页面（大多数情况用这个）
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, '{code}', '{页面名}', 'page', '', '', '/{实际路由}', '{图标名}', {排序}, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = '{code}');

-- 挂在菜单下的子页面：parent_id 用子查询取，不要硬编码数字 id
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM zt_manager_resource WHERE code = '{父菜单 code}' AND status = 'active'),
       '{code}', '{页面名}', 'page', '', '', '/{实际路由}', '', {排序}, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = '{code}');

-- 需要新建菜单分组时（page_url / resource_url / method 全空）
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, '{menuCode}', '{菜单名}', 'menu', '', '', '', '{图标名}', {排序}, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = '{menuCode}');
```

> 存在性判断只比 `code`，不带 `status`：`uk_mgr_resource_code` 是全表唯一索引，带上 status 的话，一条被停用的同 code 记录会让插入撞唯一键报错而不是安静跳过。
>
> `FROM DUAL` 是 MySQL 里「不读表但要 WHERE」的写法。`INSERT ... SELECT` 的子查询引用目标表在 MySQL 里是允许的（1093 是 UPDATE / DELETE 的限制），不用套派生表。
>
> 菜单和它的子页面要**分两条语句、按先后顺序执行**：同一条语句里子查询取不到刚插的 id。

---

## 接口资源

### code 是算的，不是起的

`code` 必须与 `manager.APIResourceCode(method, path)` 的结果**逐字一致**，否则 `SyncAPIResources` 下次会按算出来的 code 再插一套新资源，手写的那批变成没人指向的孤儿，表面上权限还在、实际全空。

算法（`server/service/manager/routes.go`）：

```text
code = "api." + lower(method) + "." + path去掉首尾斜杠、"/"换".", 删掉 ":" 和 "*"
```

对照：

```text
GET    /api/users                  → api.get.api.users
GET    /api/users/:id              → api.get.api.users.id
POST   /api/users/:id/delete       → api.post.api.users.id.delete
GET    /api/manager/accounts       → api.get.api.manager.accounts
POST   /api/manager/roles/:id/resources → api.post.api.manager.roles.id.resources
```

注意路径里的 `/api` 前缀**也在 code 里**，所以是 `api.get.api.users` 这种看着重复的形状 —— 这是对的，别"修"。

其余固定值：`name` 写成 `"{METHOD} {path}"`（与同步逻辑一致）、`parent_id = 0`、`sort_id = 0`、`page_url` / `icon` 留空。

### resource_url 存路由模板

存 gin 的**路由模板**（`/api/users/:id`），不是具体请求路径，否则每个 id 都要在表里占一行。中间件 `Authorize` 传的也是模板。

### 同路径不同方法不合并

`(method, resource_url)` 是接口资源的身份。只按 URL 分的话同一路径的 GET 和 POST 分不开，而那正是只读角色最该分开的地方。每个方法各一条资源。

### SQL 模板

```sql
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.{method小写}.{路径点分}', '{METHOD} {path}', 'api', '{METHOD}', '{path}', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.{method小写}.{路径点分}');
```

### 现有 manager-api 路由（勿重复插入）

```text
POST /api/auth/login                        POST /api/auth/logout
GET  /api/auth/me                           POST /api/auth/password
GET  /api/current-user-menus

GET  /api/manager/accounts                  GET  /api/manager/accounts/:userId
POST /api/manager/accounts                  POST /api/manager/accounts/:userId/password
POST /api/manager/accounts/:userId/status   POST /api/manager/accounts/:userId/delete
GET  /api/manager/accounts/:userId/logins

GET  /api/manager/roles                     POST /api/manager/roles
POST /api/manager/roles/:id/delete          GET  /api/manager/roles/:id/resources
POST /api/manager/roles/:id/resources

GET  /api/manager/resources                 POST /api/manager/resources
POST /api/manager/resources/:id/delete

GET  /api/users        GET  /api/users/:id        POST /api/users
POST /api/users/:id    POST /api/users/:id/password   POST /api/users/:id/delete

GET  /api/programs     GET  /api/programs/:id     POST /api/programs   POST /api/programs/:id

GET  /api/bizlines     POST /api/bizlines         POST /api/bizlines/delete
GET  /api/bizlines/members   POST /api/bizlines/member/permission   POST /api/bizlines/member/remove
```

`OPTIONS` / `HEAD` 和 `/healthz` 不登记（同步逻辑会跳过）。

---

## 角色绑定

```sql
INSERT INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT {role_id}, r.id, NOW(3)
FROM zt_manager_resource r
WHERE r.status = 'active'
  AND r.code IN (
    '{资源编码1}',
    '{资源编码2}'
  )
  AND NOT EXISTS (
    SELECT 1 FROM zt_manager_role_resource rr
    WHERE rr.role_id = {role_id} AND rr.resource_id = r.id
  );
```

### role_id = 1 是超级管理员，绑了也是白绑

默认建库顺序（`managerinit` 依次建 `super_admin` / `operator` / `viewer`）下 `id=1` 就是 `super_admin`，而它在 `checkRoute` 里**第一条规则直接放行**，根本不查资源表。所以给 role 1 的绑定幂等无害，但也不解决任何 403。

用户给 1 就照给 1 生成，同时用一句话点明：想让授权真的生效，要绑到 `operator`（默认 id=2）或 `viewer`（默认 id=3）。`viewer` 只该拿 GET 接口 —— 给它写接口虽然有 `writable` 兜底拦得住，但后台上看到的授权范围会和实际能力不一致，配起来容易误判。

不确定 id 时先查：

```sql
SELECT id, code, name, writable, status FROM zt_manager_role ORDER BY id;
```

### 绝不 DELETE 再 INSERT

资源按 `code` 冲突更新、不重建。重建会换掉资源 id，把 `zt_manager_role_resource` 里指向它的授权全部作废 —— 一次例行的重新初始化就能把所有人的权限清空。

---

## 跑完 SQL 还差一步：让 ACL 缓存失效

权限判定走**进程内缓存**，一致性靠 Redis 里的版本号。直接改库不会碰这个版本号，manager-api 会拿着旧缓存继续跑，新资源与新授权**不生效**。

SQL 末尾必须附上二选一：

```bash
redis-cli INCR manager:acl:version
```

键名是 `{manager.redis_namespace}:acl:version`。当前 `server/manager-api/configs/application.properties` 没有配这个 key，走默认 namespace `manager`，所以键就是 `manager:acl:version` —— 改过配置的环境要按实际值来。或者干脆重启 manager-api。

---

## 源头改动清单（新增页面时一并说明）

只写库不改代码，下次跑 `managerinit` 或换环境就丢：

1. `server/manager-api/cmd/managerinit/main.go`
   - `pages` 加一条 `SaveResourceRequest`
   - 若挂在菜单下，`pageParents` 加一条映射
   - 日常运营该看得到就把 code 加进 `operatorPages`（系统设置类**不要**加 —— 能改权限的角色和超管就没区别了）
2. `client/manager/src/i18n/LocaleProvider.tsx` — `nav.{code}` 的 zh-CN 与 en-US 两份文案
3. `client/manager/src/components/shell/ManagerShellStub.tsx` — 用了白名单外的图标才需要改 `MENU_ICONS`；顺带看 `FALLBACK_PAGE_TITLES` / `FALLBACK_NAV` 要不要跟
4. `client/manager/src/app/(console)/{路由}/page.tsx` — 页面本身

新增**接口**时源头不用改：`SyncAPIResources` 从路由表自动生成，`managerinit` 与 manager-api 启动都会跑一次自检，漏登记的会打日志（`N 条路由未在资源表登记`），不阻断启动。

---

## 输出规则

1. 必须幂等：`INSERT ... SELECT ... WHERE NOT EXISTS`，反复执行不出错、不改已有行。
2. `status` 一律 `'active'`；时间列显式写 `NOW(3)`。
3. `role_id` 用户没给就用 `1`，不要反问；同时提示超管绕过资源过滤这件事。
4. `parent_id` 通过子查询按父级 `code` 取，不要硬编码数字 id。
5. 接口资源的 `code` 按 `APIResourceCode` 算，不要自创命名；同路径不同方法各建一条。
6. 页面 `sort_id` 顶层从 60 起递增，别占 90 段；接口 `sort_id` 一律 0。
7. SQL 之后必须附 ACL 缓存失效的那一句，否则用户会以为 SQL 没生效。
8. 优先建议 `go run ./cmd/managerinit`；只在跑不了它的环境下才把 SQL 当主方案。

---

## 当前仓库参考

```text
server/manager.sql                                    表结构
server/service/manager/internal/repository/model.go   模型与字段说明
server/service/manager/routes.go                      APIResourceCode 算法、SyncAPIResources
server/service/manager/permission.go                  checkRoute 三条规则、ACL 缓存
server/service/manager/manager.go                     SuperAdminCode / Status* / Resource* 常量
server/manager-api/cmd/managerinit/main.go            pages / pageParents / operatorPages
server/manager-api/routers/router.go                  路由装配与启动自检
server/manager-api/pkg/{子域}/handler.go              各子域路由
client/manager/src/components/shell/ManagerShellStub.tsx  菜单渲染、MENU_ICONS 白名单
client/manager/src/i18n/LocaleProvider.tsx            nav.{code} 文案
```

生成 SQL 时优先从当前对话上下文判断新增了哪些接口 / 页面；不确定就去读对应 handler 的 `RegisterHandler`，接口清单以那里为准。
