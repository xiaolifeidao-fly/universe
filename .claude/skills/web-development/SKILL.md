---
name: web-development
description: 掌天瓶控制台前端开发技能。Next.js 14 App Router + React 18 + Ant Design 5 + TypeScript，纯浏览器 Web 控制台（非 Electron）。涵盖 (console) 路由组结构、每个页面自带 api/ 层的归属规则、@/utils/axios + class-transformer 强制封装、业务线 bizLine 贯穿、三语 i18n、manager-* CSS 变量设计系统、Next.js 代理转发到 Go 服务端。适用于新增控制台页面、对接后端接口、改造 mock 页面或调整导航与主题。
license: MIT
version: 1.0.0
---

# 掌天瓶控制台前端

`client/web/` 是掌天瓶的运营控制台，**浏览器 Web 应用**（不是 Electron，没有 IPC 通道），通过 Next.js 的 API 代理转发到 Go 服务端。

## When to Use

- 新增控制台页面（page + api + components [+ hooks]）
- 把 mock 数据页面改造成真实接口对接
- 对接后端接口（`@/utils/axios` 封装）
- 导航、页面标题、i18n 文案调整
- 主题 token / `manager-*` 设计系统相关的样式工作
- 排查代理、鉴权跳转、业务线切换相关问题

## 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 框架 | Next.js 14.1.3 App Router | 页面全部 `"use client"` |
| UI | Ant Design 5.29 + Pro Components 2.8 | Token 主题，见 `src/styles/theme.ts` |
| 语言 | TypeScript 5，`strict: true` | 禁止 `any` |
| HTTP | `@/utils/axios` 的 `getData` / `getDataList` / `getPage` / `instance` | class-transformer 反序列化 |
| 图表 | `@antv/g2` 5.1.15-beta.4 | |
| 国际化 | 自研 `@/i18n/LocaleProvider` + antd locale | zh-CN / en-US / id-ID |
| 样式 | antd Token + `src/app/globals.css` 的 `manager-*` 体系 | **不用 Tailwind**，不用 CSS Modules |
| 代理 | `src/pages/api/[...all].js`（Pages Router 残留，专做代理） | 转发到 `SERVER_TARGET` |
| 端口 | dev/start `7892`；服务端 `http://[::1]:10001` | |

## Reference Navigation

- `references/frontend-architecture.md` — 目录结构与路由组、**API 层归属规则**、axios 三个读函数与写法约束、bizLine 贯穿、鉴权与代理链路、状态管理与 hooks 抽取
- `references/frontend-new-page-guide.md` — 新增页面 / mock 页改造真接口的分步清单
- `references/frontend-design-system.md` — `manager-*` CSS 变量与类名清单、antd theme token、页面骨架模板、表格与 KPI 写法

## 目录结构速查

```
client/web/src/
├── app/
│   ├── layout.tsx              AntdRegistry → AppLocaleProvider → BusinessLineProvider
│   ├── globals.css             manager-* 设计系统（CSS 变量 + 全部业务类名）
│   ├── page.tsx                根重定向
│   ├── login/                  登录（api/ 目前是本地 mock）
│   └── (console)/              ★ 控制台路由组
│       ├── layout.tsx          鉴权守卫 + ManagerShell
│       └── {page}/
│           ├── page.tsx        只做 `return <Xxx />`
│           ├── api/{name}.api.ts   ★ 该页面自己的 API 层
│           ├── components/Xxx.tsx  页面主组件 + 拆出的子组件
│           └── hooks/useXxx.ts     数据获取与操作逻辑（复杂页面才有）
├── components/manager-shell/ManagerShell.tsx   侧栏导航 + 顶栏 + 页面标题
├── business-lines/BusinessLineProvider.tsx     业务线上下文（localStorage 持久化）
├── i18n/LocaleProvider.tsx     三语文案表 + useLocale() + antd ConfigProvider + theme
├── styles/theme.ts             antd ThemeConfig
├── utils/{axios,auth,bizLine,crypto.util,proxy}.ts
└── pages/api/{[...all].js,file/[...all].js}    代理（唯一保留 Pages Router 的原因）
```

## API 层归属（和后端同一个思路）

> **每个页面的 API 层放在该页面目录下的 `api/`，不集中到全局 `src/api/`。**

```
src/app/(console)/device-pool/api/device.api.ts        → /resource/devices*
src/app/(console)/numbers/api/number.api.ts            → /resource/accounts*
src/app/(console)/proxies/api/proxy.api.ts             → /resource/proxies*
src/app/(console)/device-parameters/api/parameter.api.ts
src/app/(console)/dashboard/api/dashboard.api.ts
src/app/(console)/attribution-config/api/attributionConfig.api.ts
src/app/(console)/attribution-analysis/api/attributionAnalysis.api.ts
src/app/(console)/user/api/user.api.ts
```

文件名 `{单数资源}.api.ts`。多个页面要共用同一批请求时，放到调用方更靠上的那个页面目录，或按需新建 `src/api/{domain}.api.ts` —— 但**先确认真的有两个页面在用**，不要预先集中。

这与服务端「handler 归各 `{层}-api/pkg/` 自己」是同一个原则：归属即边界，拆分时零迁移。服务端六层独立部署后，前端**不需要改任何 api 文件** —— 分流在代理层做。

## 强制约束（违反会绕过关键机制）

**① HTTP 一律走 `@/utils/axios`，严禁手写 `fetch`。**

```ts
import { getData, getDataList, getPage, instance, unwrapApiResponse, type ApiResponse } from "@/utils/axios";

// GET —— 三个读函数，自动解 {success,code,data} 信封 + class-transformer 实例化
const page = await getPage(DeviceRecord, "/resource/devices", withBizLine(bizLine, query));
const list = await getDataList(TemplateRecord, "/resource/templates", withBizLine(bizLine));
const one  = await getData(DeviceDetail, "/resource/device/detail", withBizLine(bizLine, { deviceId }));

// POST —— instance + unwrapApiResponse
const response = await instance.post<ApiResponse<null>>("/resource/devices", { bizLine, ...payload });
return unwrapApiResponse(response.data);
```

封装内置了 token 注入、`success===false` 抛错、`not login` 自动跳登录、class-transformer 反序列化。手写 `fetch` 会绕过全部四项。

**② 响应模型用 `class` 且字段带默认值，不用 `interface`。** class-transformer 的 `plainToInstance` 需要真实的类和已初始化的字段。请求入参可以用 `interface`（不参与反序列化）。

**③ 所有接口都要带 `bizLine`。** 用 `withBizLine(bizLine, params)` 拼查询参数，POST 用 `{ bizLine, ...payload }`。服务端每张表都有 `biz_line`，漏了就查不出数据。

**④ 所有页面组件顶部 `"use client"`。** `src/app/layout.tsx` 是唯一的服务端组件。api 文件、hooks、Provider 也都带 `"use client"`。

**⑤ 用户可见文案走 `t()`。** 新页面必须在 `LocaleProvider.tsx` 的 **三种语言** 里都加键。现存页面有直接写中文的（`ManagerShell` 的部分 `PAGE_TITLES`），那是待补的债，不要照抄。

**⑥ 不引入 Tailwind / CSS Modules / styled-components。** 布局用 `globals.css` 的 `manager-*` 类，颜色用 `var(--manager-*)`，微调用内联 `style`。

## 数据存储策略

| 数据 | 位置 | 方式 |
|---|---|---|
| 登录 token | localStorage / sessionStorage（记住我） | `@/utils/auth` 的 `setAuthToken(token, remember)` |
| 当前业务线 | localStorage `zhangtian-bottle-business-line` | `BusinessLineProvider` |
| 语言 | localStorage `zhangtian-bottle-locale` | `LocaleProvider` |
| 侧栏折叠 / 导航展开 | localStorage `zb.sidebar.collapsed` / `zb.nav.closedGroups` | `ManagerShell` |
| 列表查询缓存 | sessionStorage（如 `manager_user_management_cache_v1`） | 页面 hook 内 |
| 临时 UI 状态 | React state | 组件内 |

**所有权威业务数据来自服务端**，前端不做本地持久化业务数据。

## 已知状态

- **20 个 console 页面中只有 8 个接了真实接口**（device-pool、device-parameters、numbers、proxies、dashboard、attribution-config、attribution-analysis、user）。其余 12 个（ai、ai-config、attribution、commands、contacts、device-timeline、exec-guard、growth-strategy、operations-strategy、orchestration、scoring、survival、task-library）仍用组件内 mock / `data.ts`。改造流程见 `references/frontend-new-page-guide.md` §2。
- **登录是本地 mock**：`src/app/login/api/login.api.ts` 硬编码 `admin`/`admin123`，返回固定 token `local-admin-session`。服务端登录接口落地后要替换。
- **服务端鉴权中间件目前是 passthrough**，`instance` 注入的 `token` 头暂时不被校验。
- `ManagerShell` 的 `NAV_GROUPS` 只挂了 4 组 8 个页面，其余 12 个页面靠直接输 URL 或页内跳转访问。
- `src/app/(console)/attribution/` 与 `attribution-config`/`attribution-analysis` 并存，前者是旧版。
- `tsconfig.json` 里的 `@api/*` `@model/*` `@eleapi/*` `@enums/*` 指向 `../common/*`，**该目录不存在** —— 是从 Electron 项目继承的配置。只用 `@/*`。

## 常用文件索引

| 用途 | 路径 |
|---|---|
| HTTP 封装 | `src/utils/axios.ts` |
| 业务线参数拼装 | `src/utils/bizLine.ts` |
| token 读写 | `src/utils/auth.ts` |
| 鉴权守卫 | `src/app/(console)/layout.tsx` |
| 导航 / 页面标题 / 顶栏 | `src/components/manager-shell/ManagerShell.tsx` |
| 三语文案 + theme 挂载 | `src/i18n/LocaleProvider.tsx` |
| antd token | `src/styles/theme.ts` |
| 设计系统 | `src/app/globals.css` |
| 代理转发 | `src/pages/api/[...all].js` |
| 环境变量 | `.env` / `.env.dev`（`SERVER_TARGET`、`APP_URL_PREFIX`） |
| 页面对照原型 | `../../demo/auto_prototype/` + `../../design-qa.md` |
