# Galaxy Nova / Orbit / Portal

Galaxy 是 npm workspace。Nova（共享端）与 Orbit（使用端）各自拥有 Electron 和 Webview，
页面与 UI 交互都归属于对应端，不再共用根目录的 Next.js 应用。
Portal（门户站）是第三个成员，没有桌面壳 —— 它就是一个网站。

```text
client/galaxy/
├── nova/
│   ├── electron/
│   │   ├── src/main.ts              Nova 主进程入口
│   │   ├── src/preload.ts           启动通用自动暴露器
│   │   ├── src/impl/register.ts     Nova 实现注册表
│   │   ├── src/impl/bridge.impl.ts  BridgeApi 的内部实现
│   │   ├── src/modules/bridge/     Nova 内置 ai-bridge 子进程管理
│   │   ├── ai-bridge/              完整迁入的 bridge 源码、协议、测试和 CLI
│   │   ├── tsconfig.json
│   │   ├── dist/                   自动生成的 JS，不提交
│   │   └── package.json
│   └── webview/                    独立 Next.js / React / antd 共享端 UI
│       ├── src/app/(console)/provider/
│       │   ├── today/              今天：在不在共享、今天赚了多少、今晚几点开始
│       │   ├── share/              共享设置：共享什么、共享多少、什么时候共享
│       │   ├── earnings/           收益：四个积分口径、一周趋势、账本、提现
│       │   ├── records/            使用记录：谁在你机器上跑了什么（匿名化）
│       │   ├── account/            账户：资料、本机节点、解绑、语言
│       │   └── pair/               首次把这台机器接进共享池
│       ├── src/app/login/
│       ├── src/components/ui/      设计系统的 React 层（kit.tsx / icons.tsx）
│       ├── src/components/galaxy/  时段条与周积分柱
│       ├── src/components/shell/   外壳与命令条
│       ├── src/i18n/
│       ├── src/pages/api/          本端 Next.js 服务端代理
│       ├── next.config.mjs
│       └── package.json
├── orbit/
│   ├── electron/
│   │   ├── src/main.ts
│   │   ├── src/preload.ts
│   │   ├── src/impl/register.ts     Orbit 实现注册表，目前为空
│   │   ├── tsconfig.json
│   │   └── package.json
│   └── webview/                    独立 Next.js / React / antd 使用端 UI
│       ├── src/app/(console)/consumer/
│       │   ├── keys/               密钥：额度跟着密钥走，明文只显示一次
│       │   ├── store/              充值：商品 → 额度包 → 充到哪把密钥 + 充值记录
│       │   ├── usage/              使用记录：逐笔扣费 + 账单 / 会话 / 任务 / 申诉
│       │   ├── chat/               对话（占位，见文件顶注）
│       │   └── account/            账户：资料、密钥概况、数据告知、语言
│       ├── src/app/login/
│       ├── src/components/ui/      设计系统的 React 层（kit.tsx / icons.tsx）
│       ├── src/components/shell/   外壳与命令条
│       ├── src/i18n/
│       ├── src/pages/api/
│       ├── next.config.mjs
│       └── package.json
├── portal/                         门户站：未登录也能看的那一面（无 Electron）
│   ├── src/app/(site)/
│   │   ├── page.tsx                首页
│   │   ├── models/                 模型：全部模型 + 单价 + 能力标签
│   │   ├── pricing/                定价：计费口径 + 额度包 + 单价表
│   │   └── contact/                联系我们：留资表单（全站唯一未鉴权写接口）
│   ├── src/components/{site,home,models,pricing,contact}/
│   ├── src/app/globals.css         门户自己的设计系统（.gp-*）
│   └── README.md                   ← 门户的取数、视觉与限制都在这份
├── common/                         @galaxy/common
│   ├── eleapi/base.ts              ElectronApi、@Invoke 元数据
│   ├── eleapi/register.ts          按端选择的 API 契约注册表
│   ├── eleapi/bridge.api.ts        类型化页面调用类
│   ├── eleapi/bridge.model.ts      入参与返回值的共享类型
│   └── electron/
│       ├── main.ts                通用窗口、Next 生命周期、来源校验
│       ├── preload.ts             根据契约自动 exposeInMainWorld
│       └── rpc.ts                 自动注册 IPC 与暴露方法
├── scripts/                        工作区构建、启动、验证工具
└── package.json
```

`webview` 是目录名称，表示 Next.js 渲染应用，不是 Electron `<webview>` 标签。
每端的页面、登录、导航、状态、i18n、样式均在自己的 `webview` 下维护。
Nova 不包含 consumer 路由，Orbit 不包含 provider 路由，访问另一端的页面返回 404。
通用 HTTP/auth 工具和基础设计 token 继续复用项目原有的 `client/shared`。

## 三个成员的分工

| | 是什么 | 谁看 | 端口 |
| --- | --- | --- | --- |
| Nova | 共享端控制台 + 桌面壳 | 出算力的人 | 17898 |
| Orbit | 使用端控制台 + 桌面壳 | 花钱买额度的人 | 17899 |
| Portal | 门户站，纯网页 | **还没注册的陌生人** | 17900 |

门户不接管控制台的任何功能：它回答「你们卖什么、多少钱、怎么接」，
顶栏那个「控制台」按钮把人送去 Orbit（地址由 `NEXT_PUBLIC_CONSOLE_URL` 配）。
门户只打服务端的一组公开路由 `/api/galaxy/portal/*`，不带鉴权、不碰用户维度的数据。

## 视觉与交互

两个端共用一套骨架，只差一组颜色：Nova 暖铜（发光与收益），Orbit 青绿（冷静地花钱）。
门户是第三套 —— 它和控制台是同一个牌子的两副面孔，不是同一套组件（见 `portal/README.md`）。

| 位置 | 内容 |
|---|---|
| `client/shared/styles/galaxy.css` | 结构与组件类（`.gx-*`）。**一个颜色字面量都没有** —— 写了就等于把 Nova 的暖铜偷偷带进 Orbit |
| `<端>/webview/src/app/globals.css` | 这个端的 `--gx-*` 调色板。改色只改这里 |
| `<端>/webview/src/styles/theme.ts` | antd 主题。antd 只负责浮层（Modal / Select / message / Popconfirm），表格与表单都是原生件 —— 原型的密度靠改 antd token 拉不过来 |
| `<端>/webview/src/components/ui/` | 设计系统的 React 层。两端各一份拷贝，和 `utils/format.ts`、`i18n` 一样按端维护 |

字体（Instrument Serif 衬线大数字 + JetBrains Mono 表格数字）自托管在各端
`public/fonts/`，声明在 `client/shared/styles/tokens.css`，不连 CDN —— 桌面应用可能离线。

macOS 上窗口用 `titleBarStyle: 'hiddenInset'`，左栏顶部空出 34px 给三颗按钮，
左栏与命令条整体可拖拽（`-webkit-app-region`）。浏览器里调试时那条空白自动收掉。

## 通信边界

- 界面：桌面壳只 `loadURL` 一个**远端**地址，安装包里不带 Next 服务、不监听端口。
- 业务请求：本端 React 页面 → 本端 axios 封装 → 部署在远端的 Next.js `/api/*` → Galaxy Go API。
- Nova 本机能力：Nova Webview 的 BridgeApi → preload 自动代理 → IPC → BridgeImpl → UtilityProcess 私有通道 → 内置 ai-bridge。
- Orbit 不暴露 bridge，也不注册 bridge IPC。
- common 不负责页面、不接管业务 HTTP、不持有平台登录 token。
- 两端拥有独立 appId、userData、登录态、窗口与本机服务端口（Nova 17898，Orbit 17899）。
- Electron 使用 sandbox、contextIsolation，禁用 nodeIntegration；Nova 的 IPC 校验窗口、frame、来源和接口白名单。

ai-bridge 已从 `galaxy/ai-bridge` 完整迁入 `nova/electron/ai-bridge`。
Nova 启动时创建独立 UtilityProcess，退出时停止任务并回收子进程。首次安装只初始化配置，
不自动开启共享；在 Nova 内完成配对后自动启动共享池节点，已有 Nova 配对在重开应用时恢复。
不依赖系统级 LaunchAgent/systemd，也不再对 Webview 开放 39217 管理端口。

本机配置与节点令牌保存于 Electron `userData/ai-bridge` 下（节点凭据权限 0600），
不自动覆盖或启用原 `~/.config/ai-bridge` 的独立实例。原 CLI、协议中转、agent、共享池、
凭据适配器、业务模块及测试一并保留。Claude/Codex CLI 的登录态继续从本机读取，
相关 CLI/ffmpeg 仍按所用能力自行安装；bridge 自身随 Nova 更新，不提供 git 自升级按钮。

## 界面部署与桌面壳

界面（`<端>/webview`）部署在**远端服务器**上，桌面壳只负责加载它的地址：

```
npm run build:nova      →  .desktop/nova/          要部署到服务器的 Next standalone 包
                           nova/electron/desktop.json  这个安装包默认连哪个地址
npm run package:nova    →  release/nova/           安装包，不含 Next 服务
```

地址的来源，从高到低：

| 来源 | 用途 |
|---|---|
| `GALAXY_NOVA_APP_ORIGIN` / `GALAXY_ORBIT_APP_ORIGIN` | 单端覆盖，运维换域名不用重新打包 |
| `GALAXY_APP_ORIGIN` | 两端共用的覆盖 |
| 安装包里的 `resources/desktop.json` | 打包时由 `APP_ORIGIN` 冻结进去的默认值 |
| `http://127.0.0.1:<端口>` | **只在未打包的开发态**回落到本机 `next dev` |

**非本机地址必须是 https，证书错误一律拒绝，界面里不提供改地址的入口。** 这不是洁癖：
Nova 把 `BridgeApi` 整个暴露给渲染进程（`pair` 能把节点绑到任意 Hub、
`startUpstreamLogin` 会在本机拉起命令、`createToken` 会签发能花你订阅的凭据），
页面来自网络之后，能控制那台服务器或能改包的人就能驱动这台机器的 bridge。
Orbit 没这个问题 —— 它的 IPC 注册表是空的（`registerApi` 只给 nova 返回 `[BridgeApi]`）。

启动时壳会先探一次 `<origin>/api/desktop-health` 并核对 `product`，确认这个地址上
跑的确实是这个端的控制台（防的是配错地址，不是防攻击 —— 挡攻击的是上面那三条）；
连不上给「重试 / 退出」，不直接闪退。

`bash start.sh nova|orbit` 就是「用装好的壳打开已部署的控制台」，本机不起任何服务。

## 安装与开发

要求 Node.js 22.12+，在 `client/galaxy` 安装一次依赖，npm workspaces 自动共享依赖安装目录。
依赖声明归各自包，Next.js/React/antd 声明在每端的 webview，Electron 声明在每端的 electron。

```bash
npm install
cp nova/webview/.env.example nova/webview/.env
cp orbit/webview/.env.example orbit/webview/.env
cp portal/.env.example portal/.env
# 分别配置 SERVER_TARGET 与 APP_URL_PREFIX
npm run dev:nova
# 另一个终端
npm run dev:orbit
# 门户站（没有桌面壳，只起 Next）
npm run dev:portal
```

迁移已把原本地 `.env` 复制到两个 webview；已有文件时不需要再复制模板。
根目录旧 `.env` 不再参与运行，后续修改各端 `webview/.env`。

每个模块也可从自身目录运行：

```bash
# 在 nova 或 orbit 目录：启动整端 Electron + Webview
npm run dev
# 在 nova/webview 或 orbit/webview：仅启动本端 Next.js，方便浏览器调试
npm run dev
# 在 nova/electron 或 orbit/electron：启动整端桌面开发环境
npm run dev
```

UI 更改只修改对应 `webview/src`；本机功能修改对应 `electron`。
需要新增两端共用的纯类型、工具或生命周期能力时才放到 common。

## 构建、验证与打包

在 `client/galaxy`：

```bash
npm run typecheck
npm run test:desktop
npm run test:bridge
npm run build:nova
npm run build:orbit
npm run test:standalone
npm run package:nova
npm run package:orbit
```

`npm run build` 按顺序构建两端和门户，每个 webview 自己也可以 `npm run build`。
门户走 `scripts/portal.cjs`，不碰 Electron：`npm run build:portal` 产出
`.desktop/portal`，同样是「要部署到远端服务器」的 Next standalone 包。
Electron 源码全部是 TypeScript，`tsc --noEmit` 检查后由 esbuild 分别捆绑 main / preload
到各端 `electron/dist/*.js`。preload 只保留 Electron 内置模块为外部依赖，支持 sandbox。
`npm run build:electron` 单独编译两端 Electron。开发启动会先编译 Electron；修改 Electron
源码后重启该端，Webview 的 UI 修改由 Next.js 自动热更新。
工作区 `build:<端>` 额外将 standalone 和静态资源整理到 `.desktop/<端>` —— 那是
**要部署到远端服务器**的包，不再进安装包（目录名是历史遗留，没改是因为可能已经
有部署脚本指着它）。`package:<端>` 生成当前平台安装包至 `release/<端>`，
里面只有 Electron 壳和一份 `desktop.json`。

`bash start.sh nova|orbit` 启动已有构建的桌面应用；`bash stop.sh nova|orbit` 只停止受脚本管理的启动器。
`bash package.sh nova|orbit` 等价于对应的桌面打包命令。原 `unpack-release.sh` 仅兼容历史 Web tar 包。

安装包内不含 Next 服务：Electron 直接 `loadURL` 远端地址。部署到服务器的那份
standalone 同样不打入原始 `.env`，仅提取公开的 `SERVER_TARGET` 与 `APP_URL_PREFIX`
到 `.desktop/<端>/runtime.json`，启动环境同名变量可覆盖。

测试包括本机 bridge 白名单/凭据/错误处理，以及两端 standalone 页面、静态资源、
路由分离、Next.js 业务代理的本机模拟验证（验的就是要部署上去的那份包），不操作真实账户。
macOS arm64 可构建未签名 `.app`；Windows/Linux 安装包与真实账户业务流程需在目标环境验收。
发布签名、证书及自动更新服务尚未配置。


## 本机 API 使用方式（参考 Maserati）

页面和普通 API 类一样调用，有完整的参数、返回值类型：

```ts
import { BridgeApi } from "@galaxy/common/eleapi/bridge.api";
const bridgeApi = new BridgeApi();

const state = await bridgeApi.getState();
const result = await bridgeApi.pair({ hubURL, code: pairingCode });
const tools = await bridgeApi.getTools();
```

页面不需要知道 IPC 通道或访问 `ipcRenderer`。`BridgeApi` 是 renderer-safe 的契约兼调用代理，
`BridgeImpl extends BridgeApi` 是主进程的真实逻辑。preload 自动生成 `galaxy_BridgeApi.getState`
等函数，主进程自动注册对应通道。平台业务 API 不参与这个机制，依旧经过 Next.js 代理。

新增本机 API 的步骤：

1. 在 common/eleapi 定义继承 `ElectronApi` 的 API 类，指定 `getApiName()`，公开方法标记
   `@Invoke`，方法体返回 `this.invokeApi<返回类型>("方法名", 参数)`。DTO 同样放在 common/eleapi。
2. 将 API 类加入 `common/eleapi/register.ts` 中对应端的列表；在该端 `electron/src/impl`
   实现继承该类的 Impl，方法使用 `override`，实例加入该端 `registerApiImpl()`。
3. 在 Webview 导入 API 类并调用。无需修改 main/preload，也无需逐个编写 handle/expose。

只暴露契约里带 `@Invoke` 的方法，Impl 的辅助方法、基类工具和任意 HTTP 请求入口都不会
暴露。启动时检查缺失/重复实现并报错；窗口关闭时卸载注册的 IPC handler。
当前按需求实现 Promise 请求/响应方法，尚未增加事件订阅协议。
纯浏览器调试时 `isAvailable()` 为 false，本机管理入口会提示使用 Nova 桌面应用，
本机能力由 Electron 提供。服务端业务页面仍可通过 Next.js 调试。

`npm run test:desktop` 验证自动注册/暴露、调用上下文、来源拒绝、注册冲突回滚、隐藏辅助方法，
`npm run test:bridge` 验证 bridge 生命周期、配对、令牌管理和协议行为。
`npm run typecheck` 同时检查两端 Webview、Electron 和内置 bridge。


## 内置 bridge 管理 API

| 方法 | 用途 |
| --- | --- |
| `ping({ hubUrl? })` / `getState()` | 内置服务状态、配对状态、本机能力探测 |
| `getStatus()` | 执行状态、运行模式、Hub 地址与错误；不返回凭据 |
| `start()` / `stop()` / `restart()` | 启停 relay 或共享池任务；配对成功后自动启动 pool |
| `pair({ hubURL?, code, displayName? })` | 向 Hub 兑换配对码，节点令牌仅保存本机 |
| `startUpstreamLogin(provider)` | 按固定命令表启动 Claude/Codex 登录 |
| `getTools()` / `upgradeTool(tool)` | 工具版本与升级；内置 bridge 随 Nova 更新 |
| `listTokens()` / `createToken(input)` / `revokeToken(alias)` / `reloadTokens()` | 本机 relay 调用凭据管理；只有创建时返回一次明文 |

这些方法没有端口、任意路径或任意命令参数。管理 API 不再透过本机 HTTP 转发。
对外的 Anthropic/OpenAI/agent 协议属于原 bridge 的业务接口，在 relay 模式启动时仍由
原 HTTP 模块提供并保留 token/scope 鉴权；它们不等同于 Webview 的管理 API。

运行 `npm run test:bridge` 执行迁移后的 bridge 测试，`npm run test:desktop` 验证 preload
自动注册机制。构建 Nova 时先编译 ai-bridge ESM 包，再构建主进程和 Webview。
打包会携带 bridge 及其运行依赖；worker 从应用资源内加载，不依赖源码目录。
工作区 `.npmrc` 沿用 bridge 原有的 `legacy-peer-deps` 设置以保持其可选 SDK 的安装兼容性。
