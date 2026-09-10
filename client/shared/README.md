# client/shared

`client/web`（控制台）和 `client/manager`（管理端）之间**真正与业务无关**的可复用代码。这不是一个独立发布的 npm 包——它就是普通的 TypeScript 源码，被消费方（目前只有 `client/manager`）用 tsconfig 的 `@shared/*` 路径别名直接引入、由消费方自己的 Next.js 编译。

`client/shared/node_modules` 是一个**符号链接**，指向 `client/manager/node_modules`。这不是多余的：Node/webpack/TypeScript 解析 `import "antd"` 这类 bare import 时，都是从被导入文件自己所在目录开始往上找 `node_modules`；`client/shared/**` 下的文件没有这个符号链接就找不到 antd/react 等依赖的实现和类型声明（会报 `Cannot find module`），因为往上遍历到的 `client/`、仓库根目录都没有 `node_modules`（`client/web`、`client/manager` 是各自独立的 app，互不是对方的祖先目录）。

这个符号链接由 `client/manager/scripts/link-shared.js` 在 `npm install` 的 `postinstall` 钩子里自动创建（幂等，已存在就跳过），`.gitignore` 里也排除了它（和 node_modules 一样不进版本库）。正常情况下你不用管它；如果看到 `Cannot find module 'antd'` 这类报错，先确认这个符号链接还在（`ls -la client/shared/node_modules`），没有就手动跑一遍 `node client/manager/scripts/link-shared.js` 或者直接 `cd client && ln -s ../manager/node_modules shared/node_modules`。

## 目录

| 路径 | 内容 | 状态 |
|---|---|---|
| `styles/tokens.css` | `--manager-*` CSS 变量 + 基础 reset + 自托管字体声明 + `.manager-mono` | manager 已用；web 未切换（仍是内联拷贝，数值一致） |
| `styles/galaxy.css` | galaxy 桌面端（Nova / Orbit）的结构与组件类（`.gx-*`） | 两端都在用。**里面一个颜色字面量都没有** —— 调色板由各端 `globals.css` 的 `--gx-*` 提供，两个端才能共用同一份骨架 |
| `theme/managerTheme.ts` | antd `ThemeConfig`（`modernTheme`/`managerTheme`） | manager 已用；web 未切换 |
| `i18n/createLocaleProvider.tsx` | 通用 i18n Provider 工厂（`AppLocale` 类型、`useLocale()`、antd `ConfigProvider` 挂载） | manager 已用；web 未切换（web 自己的 LocaleProvider.tsx 带着几千行文案字典，机制和内容耦合在一起，没有单独抽机制层） |
| `auth/createAuthStore.ts` | 通用登录态存储工厂（token / user 读写） | manager 已用；web 未切换（web 的 AuthUser 字段更多，和「业务方/产研」身份体系耦合） |
| `api/createHttpClient.ts` | 通用 axios 封装工厂（token 注入、信封解包、class-transformer） | manager 已用；web 未切换（web 多了 Codex/Claude 会话线程锁重试钩子） |
| `api/createApiProxyHandler.ts` | 通用 Next.js API 代理工厂（转发到 Go 服务端） | **manager 没有实际引用它**——Next.js 的 Pages API 路由编译配置不认这个目录之外的 TS 源码（`next build` 会报错，`next dev` 不会，是个坑），manager 的 `pages/api/[...all].ts` 是一份同逻辑的独立拷贝，改动要两边同步。这个文件留作参考 / 以后换 App Router route handler 时再验证能不能用上 |

## ⚠️ 第三个 app 会撞车：符号链接只有一个

`client/shared/node_modules` 是**一个**符号链接，指向第一个 `npm install` 的那个 app
（现在是 `client/manager`）。两个 app 的时候没事，第三个（`client/galaxy`）一来就出问题：

`shared/**` 里的裸导入解析到 **manager 的 antd**，而 galaxy 页面里的组件用的是
**galaxy 自己的 antd** —— 两份实例意味着两套 React context。`createLocaleProvider`
里那个 `<ConfigProvider theme={...}>` 于是传不到 galaxy 的 `<Layout.Header>`：
命令条退回 antd 默认的深海军蓝底，配上深色标题，一个字都看不见。同时 SSR 与 CSR
的 cssinjs className 哈希也对不上，开发模式会刷水合告警，包体积多背一份 antd。

试过三条路都不行，记在这里免得重踩：

| 做法 | 结果 |
|---|---|
| `resolve.alias` 把 `antd` 指向本 app 的目录 | 绕过 `package.json` 的 `exports`，`antd/locale/zh_CN` 这类子路径导入解析失败 |
| 顺带 alias `react` / `react-dom` | Next 已经把它们指向捆绑的 react-server 变体，RSC 预渲染崩在 `useContext` |
| 把本 app 的 `node_modules` 插到 `resolve.modules` 最前面 | 同样打挂预渲染 |

**galaxy 当前的绕法**：只放弃 `@shared/i18n/createLocaleProvider`，自己写一份
（`client/galaxy/src/i18n/LocaleProvider.tsx`，约 50 行机制代码）。shared 里其余几个
文件继续用——`managerTheme` 是纯数据、`createAuthStore` 只碰 localStorage、
`createHttpClient` 只碰 axios，**都不渲染 antd 组件**，也就不依赖 React context 的同一性。
判据就是这一条：**shared 里凡是会渲染第三方 UI 组件的文件，第三个 app 都不能直接用。**

纯 CSS 不受这条限制（`tokens.css` / `galaxy.css` 不经过任何 JS 解析，也就不存在
「两份实例两套 context」的问题），所以 galaxy 的设计系统骨架放在这里；它的
**React 层**（`components/ui/`）则按端各存一份 —— 那些文件会渲染 antd 的浮层。

**根治**：把 `client/` 做成 npm workspaces，三个 app 共用一份提升到 `client/node_modules`
的 antd/react，符号链接可以整个删掉。改完之后 galaxy 的 LocaleProvider 可以换回 shared 工厂。

## 为什么 web 还没切过来

这次任务是新建 `client/manager`，要求"不改 web 现有业务代码"。上面每一项在 web 里都有对应的手写实现，且已经被 web 的其它文件直接引用（`ManagerShell.tsx`、各页面组件等），贸然改造有回归风险，所以这次只把**机制**抽成 shared、让 manager 用上，web 保持原样不动。每个文件顶部都留了 `TODO(shared-*)` 注释说明现状。

如果以后要把 web 也切过来去重，建议按依赖风险从低到高排：`theme.ts`（纯数据，零风险）→ `tokens.css`（改 `@import`，验证一次视觉回归即可）→ `createApiProxyHandler`（路由文件替换，行为等价）→ `createAuthStore` / `createHttpClient` / `createLocaleProvider`（都有 web 专属扩展点，需要先给 shared 版本加对应的扩展能力，再逐个替换调用方）。
