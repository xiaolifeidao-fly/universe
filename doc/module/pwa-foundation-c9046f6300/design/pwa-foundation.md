# 移动 PWA 基础设计

## 交付范围

`client/app` 是独立的 Next.js、React、TypeScript PWA，不依赖或导入 `client/web` 的组件、样式、请求层或构建文件。当前前置命令中心已提供 `/api/commands`；移动业务管理、登录和推送端点属于后续任务，本基础工程为它们保留了明确边界。

## 体验原则

- 触摸优先：主操作最小高度 44 px，底部固定主导航，按钮与图标都有可访问名称。
- 移动稳健：页面使用 `dvh`、刘海安全区、可换行的长文本和固定尺寸导航；表单可在软键盘打开后滚动。
- 状态清晰：联网状态、加载、空态、错误、离线壳与未来能力未接入状态均有独立界面。
- 视觉系统：使用独立的 `--app-*` token。主色为深青绿，信息状态使用蓝绿，风险使用珊瑚色，背景与卡片使用中性灰白，避免缩小 PC 控制台的密集表格布局。

## 信息架构

底部导航固定为“概览、项目、活动、设置”。项目页包含列表、详情和编辑模式，后续移动管理任务可在不改变底部导航的前提下添加需求、任务和依赖子流程。活动页只向服务端命令中心请求 `/api/commands`，从而保持 PWA 不直接访问本地 Python bridge 的约束。

## 状态与请求边界

- `src/api/client.ts` 是独立请求层，默认请求同源 `/api`；可用 `NEXT_PUBLIC_APP_API_BASE_URL` 指向独立 `app-api`。认证请求会携带 `token` 和 `X-Biz-Line`。
- 会话仅保存在 localStorage 或 sessionStorage；最近访问路由只保存在 sessionStorage，用于重新打开 PWA 后恢复位置。
- 路由组 `(workspace)` 统一使用认证守卫。会话失效后回到登录页。
- 没有将项目、需求或任务等权威业务数据持久化到客户端。`NEXT_PUBLIC_APP_PREVIEW=true` 仅为人工审阅列表、详情、编辑模式提供样例数据，部署环境必须保持其默认 `false`。

## PWA 交付

- `public/manifest.webmanifest` 声明 standalone 模式、应用名称、主题和 192/512 图标。
- `public/sw.js` 缓存应用壳、同源静态资源和已浏览页面；离线导航回退到 `/offline`，API 请求不缓存。
- 安装引导支持 Chromium 的原生安装提示，并对 iOS Safari 提示“分享 -> 添加到主屏幕”。

## 后续对接

移动业务 API 任务需要实现 `POST /api/auth/login`、项目/需求/任务/依赖 REST API 和推送订阅端点，然后以服务端返回为唯一数据源替换预览模式。会话、命令、导航和空错误状态组件可直接复用。

## 已知文档差异

执行桥提供的主需求路径 `doc/module/pwa-foundation-c9046f6300/文档.md` 在当前工作树中不存在。本设计依据已确认的总体需求 [需求大纲](../../../requirements/req-1788249230973/需求大纲.md) 和前置任务协议 [command-protocol.md](../../command-center-169a8d1f48/design/command-protocol.md) 实施；未创建或改写缺失的主需求文档，避免覆盖其可能的延迟同步内容。
