# client/manager

掌天瓶**管理端**——和 `client/web`（运营控制台）并列的第二个前端应用。Next.js 14 App Router + React 18 + Ant Design 5 + TypeScript，技术选型和 `client/web` 对齐（细节见下）。

目前只是一个可运行的**骨架**：登录页 + 一个空仪表盘，没有任何真实业务功能。

## 快速开始

```bash
cd client/manager
npm install
cp .env.example .env   # 首次运行需要，SERVER_TARGET 按需改成你本地/联调的 Go 服务端地址
npm run dev
```

打开 http://localhost:7895 ，会跳到登录页；随便填账号密码点登录（登录接口还没接，会弹一句提示，然后放你进 `/dashboard` 看控制台骨架，见下面的 TODO）。

也可以用仓库根目录 `.claude/launch.json` 里注册的 `manager` 配置（如果你用的是能读这个文件的工具）。

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发模式，端口 **7895**（`client/web` 默认 7893，仓库里另配到 7899；`client/app` 默认 7894；7895 没被占用） |
| `npm run build` | 生产构建（`output: "standalone"`，和 web 一致） |
| `npm run start` | 生产模式启动，同样是 7895 |
| `npm run lint` | `next lint` |
| `npm run typecheck` | `tsc --noEmit`（会连带类型检查 `client/shared` 下的文件） |

## 技术栈（对齐 client/web）

| 层级 | web | manager |
|---|---|---|
| 框架 | Next.js 14.1.3 App Router | 相同 |
| UI | antd 5.29 | 相同（去掉了 web 也在用但 manager 目前用不上的 `@ant-design/pro-components`） |
| 语言 | TypeScript 5，`strict: true` | 相同 |
| 样式 | `manager-*` CSS 变量体系，不用 Tailwind/CSS Modules | 相同，token 源头见下 |
| HTTP | `@/utils/axios` 封装（token 注入、信封解包、class-transformer） | 相同模式，核心逻辑来自 `@shared/api/createHttpClient` |
| 国际化 | 自研 `LocaleProvider` + antd locale | 相同模式，机制来自 `@shared/i18n/createLocaleProvider`，文案是全新的一份（只覆盖当前 stub 页面） |
| 代理 | `src/pages/api/[...all].js` 转发到 `SERVER_TARGET` | 相同，`.ts` 版本，核心逻辑来自 `@shared/api/createApiProxyHandler` |

**没有copy的 web 依赖**：`@ant-design/pro-components`、`@antv/g2`（图表）、`@hello-pangea/dnd`/`react-moveable`/`react-selecto`（看板拖拽）、`three`（3D 全景）、`sortablejs`、`xlsx`、`react-diff-viewer-continued`、`react-player`、`jsonwebtoken`、`next-plugin-antd-less` 等——这些都是 web 特定页面（任务看板、全景视图、导出等）在用的重依赖，manager 现在没有对应功能，不需要背着。真要做同类页面时再按需加。

## 目录结构

```
client/manager/
├── src/
│   ├── app/
│   │   ├── layout.tsx              AntdRegistry → AppLocaleProvider
│   │   ├── globals.css             @import 共享 token + manager 自己的骨架样式
│   │   ├── page.tsx                根重定向到 /dashboard
│   │   ├── login/                  登录页（视觉风格照 web 的 LoginHero）
│   │   └── (console)/
│   │       ├── layout.tsx          鉴权守卫（未登录跳 /login）+ ManagerShellStub
│   │       └── dashboard/page.tsx  空仪表盘 stub
│   ├── components/shell/ManagerShellStub.tsx   侧栏 + 顶栏 + 内容区
│   ├── i18n/LocaleProvider.tsx     manager 自己的文案字典（基于 @shared 工厂）
│   ├── styles/theme.ts             re-export @shared/theme/managerTheme
│   ├── utils/{axios,auth}.ts       基于 @shared 工厂的薄封装
│   └── pages/api/[...all].ts       代理（唯一保留 Pages Router 的原因，App Router 没有等价能力）
└── public/fonts/                   自托管字体（和 web 同一批文件，Next.js 静态资源按 app 各放一份）
```

## 和 client/shared 的关系

`@shared/*`（`client/shared/`）放的是 web/manager 之间**真正通用、和业务无关**的机制：design token、antd 主题、i18n 机制、鉴权存储、HTTP 封装、API 代理。**没有改 `client/web` 的任何现有文件**——web 至今用的还是它自己那份手写实现，两边数值/行为目前一致，只是没有切换成从 shared 引用。每个 shared 文件顶部都有 `TODO(shared-*)` 注释说明现状和后续怎么迁移。详见 [`client/shared/README.md`](../shared/README.md)。

`client/shared` 不是一个独立 npm 包（没有自己的 `node_modules`），`next.config.mjs` 里加了一段 `webpack.resolve.modules`，让从 `../shared/**` 发起的 `import "antd"` 之类的 bare import 也能解析到 manager 自己的 `node_modules`——这是让"纯源码目录、非 workspace 包"跨目录复用能工作的关键，别删掉。

## TODO（按大概优先级）

- [ ] 管理端登录接口接入后，把 `LoginFormCard.tsx` 里的本地假 token 逻辑换成真实的 `instance.post("/auth/login", ...)`（代码里已经标好 TODO 注释和参考路径）
- [ ] 权限模型定下来后，扩展 `src/utils/auth.ts` 的 `AuthUser` 类型（目前只有最小公分母字段）
- [ ] 第一个真实业务页面落地时，回头看一眼 `client/web` 的 `ManagerShell.tsx` 和 `frontend-design-system.md`，把分组导航、KPI 卡片骨架等模式按需搬过来（现在 `ManagerShellStub` 是刻意精简过的，只有一个 Dashboard 菜单项）
- [ ] 评估要不要把 `client/web` 也切到 `@shared/*`（消灭两份重复的 token/theme/proxy），见 `client/shared/README.md` 底部的迁移建议顺序
- [ ] 目前 `SERVER_TARGET` 指向和 web 相同的 Go 服务端（`.env.example` 里写死），如果 manager 未来要接自己的后端服务，记得改
- [ ] 没有配 `id-ID`（印尼语）文案，和 web 一样先只做中英文；要加的话照 `src/i18n/LocaleProvider.tsx` 的形状加一个 key 完整的 `id-ID` 字典，并把 `supportedLocales` 加回 `"id-ID"`
