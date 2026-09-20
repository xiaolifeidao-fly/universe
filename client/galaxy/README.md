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
│   │   ├── src/modules/toolchain/  自带的 node / npm，和给子进程补的 PATH
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
│   │   ├── src/impl/register.ts     Orbit 实现注册表：只有 ClientConfigImpl
│   │   ├── src/impl/clientconfig.impl.ts  「使用」按钮：写本机 Claude Code / Codex 配置
│   │   ├── src/modules/clientconfig/ 改配置文件的纯逻辑与 node --test 用例
│   │   ├── tsconfig.json
│   │   └── package.json
│   └── webview/                    独立 Next.js / React / antd 使用端 UI
│       ├── src/app/(console)/consumer/
│       │   ├── keys/               密钥：有效 / 无效分栏，「使用」一键接到本机客户端 + 手动接入命令
│       │   ├── models/             模型广场：模型、单价、挂在模型下的套餐（按积分标价）
│       │   ├── store/              购买：用积分买套餐 → 签发或充进已有密钥 + 购买记录
│       │   ├── points/             积分：余额、流水、分享链接与各模型返现比例、邀请的人
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
│   ├── eleapi/update.api.ts        壳自己的版本更新，两端都注册
│   └── electron/
│       ├── main.ts                通用窗口、Next 生命周期、来源校验
│       ├── preload.ts             根据契约自动 exposeInMainWorld
│       ├── rpc.ts                 自动注册 IPC 与暴露方法
│       └── update/                electron-updater 的状态机、更新地址与它的实现
├── assets/icons/                   两个端的应用图标母版（nova.svg / orbit.svg）
├── scripts/                        工作区构建、启动、验证工具
└── package.json
```

`webview` 是目录名称，表示 Next.js 渲染应用，不是 Electron `<webview>` 标签。
每端的页面、登录、导航、状态、i18n、样式均在自己的 `webview` 下维护。
Nova 不包含 consumer 路由，Orbit 不包含 provider 路由，访问另一端的页面返回 404。

账号也按端分开，而且和任务宇宙（web 控制台）的账号无关：Nova 的登录、注册、改密码打
`/api/galaxy/provider/auth/*`，Orbit 打 `/api/galaxy/consumer/auth/*`，登录态分别存在
`galaxy_provider_auth_*` / `galaxy_consumer_auth_*`。两端是两批人，同一个用户名在两端可以各是一个账号，
一端的令牌调另一端的接口是 `not login`。共享端注册出来一律是散户，工作室只能由运营在管理端设。
设计见 `doc/galaxy/README.md` 的「账号体系」。
通用 HTTP/auth 工具和基础设计 token 继续复用项目原有的 `client/shared`。

## 三个成员的分工

| | 是什么 | 谁看 | 端口 |
| --- | --- | --- | --- |
| Nova | 共享端控制台 + 桌面壳 | 出算力的人 | 17898 |
| Orbit | 使用端控制台 + 桌面壳 | 花钱买额度的人 | 17899 |
| Portal | 门户站，纯网页 | **还没注册的陌生人** | 17900 |

门户不接管控制台的任何功能：它回答「你们卖什么、多少钱、怎么接」，
顶栏那个「控制台」按钮把人送去 Orbit（地址由 `GALAXY_CONSOLE_URL` 配，运行时读）。
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

### 应用图标

两枚图标是一对：同一块圆角底板、同一颗白色核心，只差一个动作。Nova 是向外发光的新星
（把算力发出去），Orbit 是绕着核心转的卫星（绕过来取用）。颜色直接取各端 `globals.css`
里的 `--gx-accent` 一族 —— Nova 暖铜、Orbit 青绿，隔着 Dock 也能一眼分开。

母版只有 `assets/icons/<端>.svg` 这一份，别的全是它的产物。改图标只改这份 SVG，然后：

```bash
npm run icons
```

`scripts/build-icons.cjs` 借工作区里已有的 Electron 光栅化（不引图形库、不依赖本机装没装
ImageMagick），一次生出下面这些；产物都进版本库，打包机不必再跑一遍。

| 产物 | 给谁 |
|---|---|
| `<端>/electron/build/icon.icns` | macOS 安装包。这份是内缩到 824 见方 + 落影的变体，满幅方块进 Dock 会比邻居大一圈 |
| `<端>/electron/build/icon.ico` | Windows 安装包与 exe |
| `<端>/electron/build/icons/*.png` | Linux AppImage |
| `<端>/electron/assets/icon.png` | Windows/Linux 的窗口与任务栏图标（macOS 用的是安装包里的 .icns） |
| `<端>/webview/src/app/icon.svg`、`apple-icon.png` | 浏览器页签、加到手机主屏（后者满幅直角，圆角由系统自己切） |

字体（Instrument Serif 衬线大数字 + JetBrains Mono 表格数字）自托管在各端
`public/fonts/`，声明在 `client/shared/styles/tokens.css`，不连 CDN —— 桌面应用可能离线。

macOS 上窗口用 `titleBarStyle: 'hiddenInset'`，左栏顶部空出 34px 给三颗按钮，
左栏与命令条整体可拖拽（`-webkit-app-region`）。浏览器里调试时那条空白自动收掉。

## 通信边界

- 界面：桌面壳只 `loadURL` 一个**远端**地址，安装包里不带 Next 服务、不监听端口。
- 业务请求：本端 React 页面 → 本端 axios 封装 → 部署在远端的 Next.js `/api/*` → Galaxy Go API。
- Nova 本机能力：Nova Webview 的 BridgeApi → preload 自动代理 → IPC → BridgeImpl → UtilityProcess 私有通道 → 内置 ai-bridge。
- Orbit 不暴露 bridge，也不注册 bridge IPC；它只有 `ClientConfigApi`（见下文「Orbit 本机 API」）。
- common 不负责页面、不接管业务 HTTP、不持有平台登录 token。
- 两端拥有独立 appId、userData、登录态、窗口与本机服务端口（Nova 17898，Orbit 17899）。
- 壳的自动更新两端共用一份（`UpdateApi`），地址由控制台在探活那一跳报回来，见「自动更新」。
- Electron 使用 sandbox、contextIsolation，禁用 nodeIntegration；Nova 的 IPC 校验窗口、frame、来源和接口白名单。

ai-bridge 已从 `galaxy/ai-bridge` 完整迁入 `nova/electron/ai-bridge`。
Nova 启动时创建独立 UtilityProcess，退出时停止任务并回收子进程。首次安装只初始化配置，
不自动开启共享；在 Nova 内完成配对后自动启动共享池节点，已有 Nova 配对在重开应用时恢复。
不依赖系统级 LaunchAgent/systemd，也不再对 Webview 开放 39217 管理端口。

本机配置与节点令牌保存于 Electron `userData/ai-bridge` 下（节点凭据权限 0600），
不自动覆盖或启用原 `~/.config/ai-bridge` 的独立实例。原 CLI、协议中转、agent、共享池、
凭据适配器、业务模块及测试一并保留。Claude/Codex CLI 的登录态继续从本机读取；
ffmpeg 仍要自行安装，Claude Code / Codex 则可以由 Nova 自己装（见下一节）；
bridge 自身随 Nova 更新，不提供 git 自升级按钮。

## 自带的 node 与 npm

共享端不需要本机装 Node —— **Nova 里本来就有一个**。Electron 40.10.2 内嵌 Node 24.15.0，
桥接跑在 `utilityProcess` 里用的就是它，页面是远端加载的，主力的 relay 路径全程 HTTP 转发，
一行 node 代码都不经过本机的 node。

要本机 node 的只有一处：账户页「这台电脑」那个工具面板，它要 `npm view` 查最新版、
`npm install -g` 装 / 升 Claude Code 与 Codex，还要 `claude --version` 看装没装
（`ai-bridge-native/src/pool/tools.rs`）。而 macOS 上从 Dock 点开的应用继承的是 launchd 的环境，
PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，nvm 和 homebrew 都不在里面，`/usr/bin/node` 也不存在。
所以 `src/modules/toolchain` 在起桥接子进程之前做三件事，**缺一不可**：

1. 起一个登录且交互的 shell 把用户自己那份 PATH 问回来（nvm 写在 `.zshrc` 里，少了 `-i` 问不出来）；
2. 在 PATH 末尾挂上自带的 `node` / `npm` / `npx` 三个 shim —— `node` 就是
   `ELECTRON_RUN_AS_NODE=1` 起 Nova 自己，npm 是随包分发的一份 JS（落在 `resources/npm`）；
3. 只有在本机确实没有 npm 时，才把 `npm_config_prefix` 指到 `userData/toolchain/global`。

顺序是**本机优先、自带兜底**：本机装了 Node 的人，用 Nova 装出来的 claude 仍然落在他自己的
全局目录里，终端里直接能用。没装的人才用自带的那套，装出来的东西落在 userData 下 ——
所以「登录上游」那条命令会用绝对路径拼（`pool/setup.rs` 的 `login_command_line`），
否则递给 Terminal 只会是 command not found。

node shim 不是可有可无的：包的安装脚本是 `sh -c node install.cjs` 这么跑的，
实测只给 npm 不给 node，`npm install -g @anthropic-ai/claude-code` 会在自己的 postinstall 上
以 127 失败，包装了一半。

npm 由 `electron/build/after-pack.cjs` 在打包时拷进去，**不能走 `extraResources`**：
electron-builder 的过滤器里有一行硬编码，相对路径正好是 `node_modules` 的目录一律丢弃
（`app-builder-lib/out/util/filter.js`），filter 写什么都救不回来 —— 而 npm 那 12MB 依赖
就躺在 `npm/node_modules` 下。这个坑不报错也不警告，包里会躺着一个一跑就
MODULE_NOT_FOUND 的空壳。afterPack 还有一点要紧：它跑在签名之前，签完再塞文件会让
`.app` 的签名失效。

```bash
npm run verify:toolchain                        # 把 PATH 剥成 launchd 那份，验 shim、npm、prefix
node scripts/verify-toolchain.cjs --bundle <Nova.app>   # 验真打出来的包里那份能不能跑
```

**--bundle 那条不是可选的**：开发态用的是仓库里的 `node_modules/npm`，它永远是好的，
验不出打包漏了依赖这类问题。

自带的那个 Node 版本跟着 Electron 走（现在 24.15.0），钉不到某个指定版本；要钉死就得改成
把官方 Node 整包塞进 `extraResources`，代价是每平台 ~110MB 和 macOS 上多一套二进制签名。
另外自带的这个 npm（11.19）默认不跑依赖的 install script，`npm install -g` 之后 postinstall 是跳过的
（Claude Code 实测不受影响，它的 bin 是预编译的原生文件）。

## 界面部署与桌面壳

三个成员共用一个域名，所以各占一段路径：门户在根上，两个控制台挂在自己的 `basePath` 下。

| | 地址 | 本机 |
|---|---|---|
| Portal | `https://<域名>/` | 17900（无 basePath，探活 `/api/health`） |
| Nova | `https://<域名>/nova` | 17898，`http://127.0.0.1:17898/nova` |
| Orbit | `https://<域名>/orbit` | 17899，`http://127.0.0.1:17899/orbit` |

`basePath` 的唯一数据源是 `common/index.js`，next.config.mjs 从那里读，桌面壳与
Webview 也从那里读。nginx 那两条 `location ^~ /nova/`、`/orbit/` **不改写路径**，
所以应用自己必须知道自己挂在哪 —— 这不是可选项。

跟着 basePath 走的东西里，只有三样要手工带前缀，其余（页面跳转、`_next` 静态资源、
`public/` 下的文件）Next 自己会加：

- `<端>/webview/src/utils/axios.ts`：业务请求的 `baseURL` 和未登录跳转，是界面里仅有的两处手拼绝对路径；
- `<端>/webview/src/app/fonts.css`：CSS 的 `url()` 不认 basePath，Next 也不会帮你改写它，
  所以自托管字体要由端自己再声明一遍（**必须排在 tokens.css 之后**，靠「同族最后一条生效」把根路径那组盖掉）；
- 桌面壳：`loadURL` 与健康探测打的是 `origin + basePath`，而「允许跳到哪里」仍按 origin 判断。

门户上那个「控制台」按钮指向 `/orbit/consumer/keys`（`GALAXY_CONSOLE_URL` 可覆盖），
前面那段不能省。这个地址是**运行时**读的：改部署机上的 `runtime.json` 再重启就生效，
不用重新构建（早先它叫 `NEXT_PUBLIC_CONSOLE_URL`，那种写法是构建期内联，
线上出过按钮指着打包机 `127.0.0.1` 的事）。

界面（`<端>/webview`）部署在**远端服务器**上，桌面壳只负责加载它的地址：

```
npm run build:nova      →  .desktop/nova/          要部署到服务器的 Next standalone 包
                           nova/electron/desktop.json  这个安装包默认连哪个地址
                                                       （不给 APP_ORIGIN 就是 defaultOrigin）
npm run package:nova    →  release/nova/           安装包，不含 Next 服务
```

界面那份包自己带了一套发布脚本（`<端>/webview/`，门户是 `portal/`），和 `server/galaxy-api` 那套同形：

| 脚本 | 做什么 |
|---|---|
| `build.sh` | 只构建界面，产出 `.desktop/<端>/`。不编 Electron、不编 Rust 桥接 —— 只跑界面的服务器不该为发一个前端装 Rust 工具链 |
| `package.sh` | 构建 + 打成 `<端>-webview-linux-x64.tar.gz`（含 `start.sh` / `stop.sh`） |
| `unpack-release.sh` | 在服务器上解包。**放在 tar.gz 旁边跑**，把目录整个换掉、只留 `runtime.json` 与 `logs/`。不带参数时服务还在跑就拒绝动手；`--swap` 自己停、换、起，`--stage` 只解包不碰线上 |
| `start.sh` / `stop.sh` | 起停那份 standalone。pid 在 `run/`，日志在 `logs/`。写的是 POSIX sh，`sh start.sh` 掉进 dash 也不会炸 |

解包后就是这几样，没有多余的层级：

```text
<端>-webview-linux-x64/
├── webview/          server.js、.next、public —— 真正跑起来的那个 Next 应用
├── common/           @galaxy/common（代码已经编进 .next，这里只剩包声明）
├── node_modules/     运行时依赖
├── runtime.json      这台机器打哪台 Galaxy API（解包时从 example 生成）
├── README.txt        起停、日志、别 npm install —— 运维只需要看这一页
├── start.sh
└── stop.sh
```

换版本不用先手工 `stop.sh`：

```sh
./unpack-release.sh --swap     # 解到旁边 → stop → 换目录 → start
./unpack-release.sh --stage    # 只解包，线上照跑；晚点再 --swap 换过去
```

「先解包再 stop」这个顺序**直接做是不行的**：解包会把整个目录换掉，`run/*.pid` 跟着一起没，
`stop.sh` 再跑就找不到进程 —— 老进程成了孤儿还占着端口，新的怎么都起不来。`--swap` 就是
把这个顺序做对：先解到旁边的 `.staging-<包名>/`，停下来之后才 `mv` 换目录（同一个盘，瞬间完成），
所以停机窗口里只剩 stop 和 start，解包、校验、盘满都挪到了服务还活着的时候。上一版留在
`<包名>.prev`，回滚就是一条 `mv`；新版本没起来时脚本会把那条命令打出来。`--stage` 把解包
单独拎出来，可以提前很久做，`--swap` 时认出暂存的是同一个包就直接用，不是就重新解一份。
首次部署不自动起 —— 那会儿 `runtime.json` 刚从模板生成，`SERVER_TARGET` 还是打包机的值。

`unpack-release.sh` 是**整个换掉**而不是覆盖解包：tar 只写包里有的文件，上一次留下的
多余文件它一个都不删。踩过的那次是有人在包里 `npm install`，npm 按清单把「多余的」
依赖裁了（包括 `next` —— 它是 Next 自己追踪进来的、清单里没写），再解一次也回不来，
最后表现成 `Cannot find module 'next'`，看上去像包坏了。`start.sh` 现在启动前先看一眼
`node_modules/next` 在不在，不在就直接说「这个目录不是一次干净的解包」。

**部署机上不要 `npm install`。** 依赖已经随包发好了，包根也刻意不带 `package.json` ——
Next 会把工作区那份清单顺带追进 standalone，而它带着 `postinstall`（部署机上没有 `scripts/`）
和 `workspaces`（指向不存在的 `nova/`、`orbit/`），照着它装一次会崩在 postinstall 上，
还会把包里备好的 `node_modules` 搅乱。`build-webview.cjs` 出包时把那份清单删掉了。

Next 的 standalone 本来是按应用在仓库里的相对路径摆的（`client/galaxy/<端>/webview`），
`build-webview.cjs` 把那四层压掉了 —— 包名已经写明是哪个端，部署机上再背着仓库结构
只会让 cd 和看日志多绕路。压平不影响解析：`server.js` 用 `__dirname` 定位自己，
node 找依赖仍是从应用目录逐级往上走，`webview/` → 包根 的层级关系和压平前一样。

`start.sh` 一个文件管两处：解包后的发布目录里 standalone 就在它身边，源码树里则回落到
`../../.desktop/<端>`（门户是 `../.desktop/portal`）。两边跑的都是**要部署上去的那份包**，
不是 `next start` —— 本机验的和线上发的必须是同一个东西。

门户那套完全同形，只有三处不同：包里的应用目录叫 `portal/` 而不是 `webview/`；
它挂在站点根上没有 basePath，所以探活打的是 `/api/health`；默认端口 17900。
构建入口也是同一个 `scripts/build-webview.cjs`（`portal.cjs` 只剩 dev/start 和转调）——
门户不走 `desktop.cjs` 是因为它没有壳，不是因为它的界面要另起一套构建。

默认监听 `127.0.0.1:17898`（Nova）/ `127.0.0.1:17899`（Orbit），正是
`doc/deployment/nginx/www.galaxy.rodeo.conf` 里 `galaxy_nova` / `galaxy_orbit` 两个 upstream
指着的地址 —— 单实例部署不用给任何环境变量。要改用 `PORT` 与 `WEBVIEW_HOST`
（不叫 `HOSTNAME`：bash 自己有个同名变量是机器名，被它顶掉会变成「绑不上」）。

业务代理打哪台 Galaxy API 由 `SERVER_TARGET` / `APP_URL_PREFIX` 决定，`runtime.json` 给默认值、
启动环境的同名变量优先。**发布包里只有 `runtime.example.json`**：真配置留在部署机上，
重新解包不会被打包机的值覆盖。

三个成员打的**不是同一台**服务，兜底值也就不一样：Nova 只调 `/api/galaxy/provider/*`
（galaxy-api `:10004`），Orbit 的 `/api/galaxy/consumer/*` 和门户的 `/api/galaxy/portal/*`
都在 galaxy-consumer-api `:10005` 上。指错了不会 502、也不报错，是后端回一句 Go 默认的
`404 page not found`，看上去像页面丢了 —— 这个坑踩过一次。

注意和工作区根目录那套同名脚本区分：根目录的 `start.sh nova` 是「用装好的壳打开已部署的控制台」，
`<端>/webview/start.sh` 是「在这台机器上把界面跑起来」。

两个壳默认加载的就是线上那两段：**Nova → `https://www.galaxy.rodeo/nova`，
Orbit → `https://www.galaxy.rodeo/orbit`**。域名写在 `common/index.js` 的 `defaultOrigin`
（和 `basePath` 放在一起 —— 它们是同一个地址的两半，抄成两份换域名只会改到一处），
壳加载的地址就是 `defaultOrigin + basePath`。装好就能开，不配任何东西。

地址的来源，从高到低：

| 来源 | 用途 |
|---|---|
| `GALAXY_NOVA_APP_ORIGIN` / `GALAXY_ORBIT_APP_ORIGIN` | 单端覆盖，运维换域名不用重新打包；一台机器上两个端连不同环境也靠它 |
| `GALAXY_APP_ORIGIN` | 两端共用的覆盖 |
| 安装包里的 `resources/desktop.json` | 打包时由 `APP_ORIGIN` 冻结进去的值，发测试环境的包时给它 |
| `common/index.js` 的 `defaultOrigin` | 编译进壳的正式部署地址 `https://www.galaxy.rodeo` |

每一级的空串都当「没配」往下落 —— `export GALAXY_APP_ORIGIN=` 这种导成空值的写法
比不导出常见得多，那时候该用下一级而不是报错。

**开发态连本机 `next dev` 也走环境变量**：`npm run dev:nova` 由 `scripts/desktop.cjs`
注入 `GALAXY_NOVA_APP_ORIGIN=http://127.0.0.1:17898`（已经手动指过的不覆盖）。
这里刻意没有「未打包就自动用本机端口」那条暗门 —— 它会让 `bash start.sh nova`
（壳在本机、界面在远端）也悄悄指向一个没人监听的端口，症状是一个看不懂的连不上。
壳连的是本机还是线上，永远写在环境变量里。

**非本机地址必须是 https，证书错误一律拒绝，界面里不提供改地址的入口。** 这不是洁癖：
Nova 把 `BridgeApi` 整个暴露给渲染进程（`pair` 能把节点绑到任意 Hub、
`startUpstreamLogin` 会在本机拉起命令、`createToken` 会签发能花你订阅的凭据），
页面来自网络之后，能控制那台服务器或能改包的人就能驱动这台机器的 bridge。
Orbit 的面要窄得多：`registerApi` 给它的只有 `ClientConfigApi`，能做的只是把一把 Galaxy 密钥写进本机
Claude Code / Codex 的两个固定配置文件，而且每一次写都要用户在主进程画的系统确认框里点头。
一台被人改过的服务器最多能让用户在框里看到一个奇怪的地址 —— 这正是确认框要把地址摆出来的原因。

启动时壳会先探一次 `<origin>/api/desktop-health` 并核对 `product`，确认这个地址上
跑的确实是这个端的控制台（防的是配错地址，不是防攻击 —— 挡攻击的是上面那三条）；
连不上给「重试 / 退出」，不直接闪退。

`bash start.sh nova|orbit` 就是「用装好的壳打开已部署的控制台」，本机不起任何服务 ——
不给环境变量时打开的就是 `https://www.galaxy.rodeo/nova`（或 `/orbit`）。

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
**代码签名证书仍未配置** —— 这一条现在有实际后果，见下一节。


## 自动更新（两端共用）

界面部署在远端，天天都是最新的；**壳不是**。壳的更新就是这一节：
有新版本弹一次提示，用户点了才下载，下完重启装上。非强制 —— 点「稍后再说」
就什么都不发生，连带宽都不占。

| 在哪儿 | 做什么 |
|---|---|
| `common/eleapi/update.api.ts` / `update.model.ts` | 契约与那一个 `UpdateStatus` 结构。两端都注册（`registerApi`），页面只按 `state` 画 |
| `common/electron/update/runtime.ts` | electron-updater 的事件流收敛成 `UpdateStatus`；不自动下载、下完不自动重启 |
| `common/electron/update/feed.ts` | 更新地址从哪儿来、什么样的地址不收。`node --test` 守着（`npm run test:desktop`） |
| `common/electron/main.ts` | 起更新器、把 `UpdateImpl` 补进实现表 —— **各端的 `impl/register.ts` 里没有它**，更新是壳的能力，不分端 |
| `<端>/webview/src/components/shell/UpdateGate.tsx` | 提示、进度、右下角那个胶囊。挂在 `GalaxyShell` 里，浏览器里整块不画 |

### 更新地址不冻进安装包

地址由**界面那一侧**给：壳启动本来就要探 `<base>/api/desktop-health`，那一跳顺带把
这个端的更新目录带回来（部署机 `runtime.json` 里的 `GALAXY_UPDATE_FEED_URL` + `/<端>`）。

```
runtime.json  GALAXY_UPDATE_FEED_URL = https://<桶>.<endpoint>/<oss.dirPrefix>/desktop
     ↓  /api/desktop-health
桌面壳        https://…/desktop/nova/latest-mac.yml、…/Nova-0.1.1-arm64.zip
```

冻进安装包的话，换一次桶就等于所有老版本永远收不到更新 —— 而更新地址恰恰是那种
「换了之后老包还得能用」的东西。启动环境里的 `GALAXY_<端>_UPDATE_FEED` /
`GALAXY_UPDATE_FEED` 仍然覆盖它（对着本地目录调更新流程时用）。没配就是这个部署
不检查更新，**不是故障**，界面上整块不画。

`electron/package.json` 里那条 `publish.url`（`https://galaxy.invalid/…`）只是为了让
electron-builder 生成 `latest-*.yml`，运行时不会被读到 —— 壳在检查之前一定先
`setFeedURL`。

### 发版

先把版本号抬上去：**壳比的是 `<端>/electron/package.json` 的 `version`**（`app.getVersion()`），
两个端各记各的。忘了改这一行，打出来的包和在架的那一版同号，装出去的客户端一律认为
自己已经是最新的 —— 而且不报任何错。

包传到 OSS 上由运营在管理端做（`/galaxy/desktop-releases`）：把 `release/<端>/` 下的
`latest-*.yml` 和它点名的安装包拖进去，写一段版本说明（会写进清单的 `releaseNotes`，
客户端提示里原样展示），点发布。包一百多兆，浏览器拿签名地址直传 OSS，不经过服务端；
服务端只确认包到了、把清单写到固定路径上 —— **清单写出去的那一刻，全网客户端才会
开始提示更新**。桶那一侧要两条：发布目录公开读、允许管理端那个域名跨域 PUT。

`.blockmap` 不用传：客户端关掉了差量下载（`disableDifferentialDownload`），
省下的那点流量换来的是一条更容易出错、且只在「上一版恰好还在本机缓存里」时才生效的路径。

### macOS 上装不上的那一半

Squirrel.Mac 只接受**签过名**的应用。没有 Developer ID 证书时，包下载得到、装不上：
MacUpdater 会先派发 `update-downloaded`、再在 error 事件里吐
`Could not get code signature for running application`。

所以 runtime 不把它当失败：状态留在 `downloaded`，只把 `manualInstall` 立起来，
界面上的「立即重启」换成「打开安装包」，用户自己拖一次。配上证书之后这条路自然就不走了，
不需要改代码。Windows（NSIS）与 Linux（AppImage）是完整的自动下载 + 自动安装 + 重启。


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

窗口拦掉了 `window.open`，页面要让系统浏览器打开外部地址（账户页下载 ai-bridge 安装包）走另一个契约：

| 方法 | 用途 |
| --- | --- |
| `ShellApi.openExternal(url)` | 交给 `shell.openExternal`；主进程只放行 `http:` / `https:`，其他协议直接拒绝 |

纯浏览器调试时它不可用，页面退回 `window.open`（见 Nova Webview 的 `utils/shell.ts`）。

运行 `npm run test:bridge` 执行迁移后的 bridge 测试，`npm run test:desktop` 验证 preload
自动注册机制。构建 Nova 时先编译 ai-bridge ESM 包，再构建主进程和 Webview。
打包会携带 bridge 及其运行依赖；worker 从应用资源内加载，不依赖源码目录。
工作区 `.npmrc` 沿用 bridge 原有的 `legacy-peer-deps` 设置以保持其可选 SDK 的安装兼容性。


## Orbit 本机 API（2026-09-12）

密钥页的「使用」按钮背后是 `ClientConfigApi`（契约在 `common/eleapi/clientconfig.api.ts`）。浏览器里
`isAvailable()` 为假，页面不画按钮，只给手动接入命令。

| 方法 | 用途 |
| --- | --- |
| `getStatus()` | 这台电脑上 Claude Code / Codex 现在接的地址、密钥末 4 位，以及是不是 Orbit 写进去的那一把（卡片上的「使用中」） |
| `applyKey({ tool, baseUrl, secret, keyId })` | 弹系统确认框，点「写入配置」才写；第一次改写前把原件存成 `<文件>.orbit-backup`，之后不再覆盖它 |

写的是哪两处、改动范围只有多大：

| 客户端 | 文件 | 改什么 |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json`（认 `CLAUDE_CONFIG_DIR`） | `env.ANTHROPIC_BASE_URL`（主机根，不带 `/v1`）、`env.ANTHROPIC_AUTH_TOKEN`，并删掉 `env.ANTHROPIC_API_KEY` —— 两个同时在时原来那把真密钥会跟着请求发到 Galaxy |
| Codex | `~/.codex/config.toml`（认 `CODEX_HOME`） | 顶层 `model_provider = "galaxy"`，整段替换 `[model_providers.galaxy]`（`base_url` 带 `/v1`、`wire_api = "responses"`、`experimental_bearer_token`） |

几条规则：

- **页面不可信。** 路径不从页面来；密钥必须是 `sk-galaxy-` 形状、地址必须是不带账号/查询串的 http(s)，
  过了校验才进 JSON / TOML。明文 http 地址在确认框里单独提示。
- **认不清的文件不写。** settings.json 解析不了、config.toml 在顶层用内联表写了 `model_providers`，都直接报错，
  不按空文件覆盖。TOML 按行改，注释、空行、别的表原样保留（多行字符串里长得像表头的行不算表头）。
- **只对这台电脑成立。** 密钥页顶上那条「这台电脑」写的就是这两个文件的现状；「使用中」只认 Orbit 自己写进去、
  文件里现在还是那一把的密钥，手动改过就不认。
- 改文件的逻辑在 `orbit/electron/src/modules/clientconfig/files.ts`，用例随 `npm run test:desktop` 一起跑。
  写进去的配置对**之后打开**的 Claude Code / Codex 生效，已经开着的要重开。
