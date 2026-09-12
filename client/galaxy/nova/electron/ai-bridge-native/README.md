# ai-bridge-native

ai-bridge 的实现主体，Rust，编译成 Node 原生模块（napi-rs）。
Nova 的 Electron UtilityProcess 里那层薄 JS 壳直接 `require` 它，不再另起进程。

进程形态没变：仍然是 `utilityProcess.fork(ai-bridge/desktop-worker)`，崩溃隔离、
`start/stop/restart` 语义和 `BridgeApi` 的 IPC 协议都和以前一样。变的是壳里跑的东西。

**桌面路径已经全部在这里。** `desktop/service.ts` 的 TS 依赖闭包只剩四个文件
（worker、service、config/schema 的 ScopeSchema、core/paths），其余 TS 代码只服务
独立 CLI（`main.ts`）。

## 里面有什么

| 模块 | 对应的 TS |
| --- | --- |
| `config/` | `config/schema.ts` + `config/index.ts`（serde 结构 + 默认值 + 一致性校验） |
| `core/errors` `core/logger` `core/paths` | 同名文件 |
| `core/queue` | `core/queue.ts` 的三层闸门（tokio Semaphore 替 p-queue） |
| `core/request` | `core/request.ts` 的 requestId 与取消信号 |
| `core/proxy` | `core/proxy.ts` 的逐字节透传（reqwest 流 → hyper 流） |
| `auth/` | `auth/{principal,network,token-store,middleware}.ts` |
| `credentials/` | `credentials/*`，含 `toml_lite`（`local-upstream.ts` 里那个轻量 TOML 解析） |
| `modules/{health,relay,admin}` | 同名模块（axum 替 express） |
| `business/` | `business/core` 的类型与工具，以及三种节点 provider：`llm_chat` / `delivery_task` / `video_edit` |
| `pool/` | `modules/pool/*`：Hub 客户端、运行循环、通道闸门、能力探测、模型清单、节点令牌、工具面板、配置改写；远程升级（`upgrade.rs`，TS 侧没有） |
| `app.rs` | `app.ts` 的装配与优雅关闭 |
| `napi_api.rs` | 给 Node 的导出面：`NativeBridge` 与 `parseConfigJson` |

**还留在 Node 的**只剩薄壳那三件事（入参校验、变更串行化、铺配置模板），
见 [`../ai-bridge/README.md`](../ai-bridge/README.md)。

**本机 agent 模块（`agent.*`）已经没有实现了。** 它原来的两个执行器绑死在
`@anthropic-ai/claude-agent-sdk` 和 `@openai/codex-sdk` 上，随 TS 实现一起删除。
`create_bridge` 在 `agent.enabled=true` 时**直接报错**而不是忽略：悄悄按 relay
跑掉一条本该在本机执行命令的请求，这个差别不能默默发生。

## 访问控制

| 层 | 配置 | 说明 |
| --- | --- | --- |
| 监听地址 | `server.host` | 默认 `127.0.0.1` |
| 来源 IP | `auth.ipAllowlist` | CIDR 白名单，空 = 不限 |
| 认证 | `auth.tokens` / `tokenFile` | `Authorization: Bearer` 或 `x-api-key`；进程内只留 sha256 |
| 授权 | token 的 `scopes` | `relay:anthropic` `relay:openai` `agent` `admin` `*` |
| 配额 | token 的 `concurrency` | 单个调用方并发上限，超了 429 |
| admin | `auth.adminLoopbackOnly` | `/admin/*` 只允许本机 |

日志只记 alias / requestId，不记 token 与凭据。

## 端点（relay 模式）

| 路径 | 模块 | scope |
| --- | --- | --- |
| `GET /healthz` `GET /readyz` | health | 无 |
| `POST /v1/messages` `POST /v1/messages/count_tokens` | relay | `relay:anthropic` |
| `POST /v1/responses` `POST /v1/chat/completions` | relay | `relay:openai` |
| `GET /admin/status` `GET/POST /admin/tokens` `DELETE /admin/tokens/:alias` `POST /admin/tokens/reload` | admin | `admin` |

客户端连接方式（在 Nova 里签一个调用凭据之后）：

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_AUTH_TOKEN=<token> claude
```

Codex 在 `~/.codex/config.toml` 里把 `base_url` 指到 `http://127.0.0.1:8787/v1`、
`wire_api = "responses"`，令牌通过 `env_key` 提供。

## 共享算力池（pool 模式）的边界

两种模式互斥：`relay` 监听 `127.0.0.1:8787` 给本机或同事的客户端用；
`pool` 把算力贡献给共享池。pool 模式下又分两种接入方式（`pool.accessMode`）：

- `poll`（默认，Nova 客户端唯一的方式）：**不监听任何端口**，只主动出站连 Hub；
- `export`（独立部署的命令行才用）：在 `pool.export.host:port` 上开
  `/node/v1/{health,execute,cancel}`，Hub 拿公网地址 + 回连密钥主动送活。
  hello、心跳、终态回报仍然主动出站。

- **探测 ≠ 贡献。** 探测只告诉 Hub 这台机器有什么，共享哪几种、共享多少由主人
  在控制台定，Hub 每次 hello / 心跳下发一份生效配置，节点照着建通道。
- **poll 不监听端口。** pool 模式下 `server.*`、`auth.*`、`relay.*`、`admin.*` 全不生效，
  poll 接入的进程只有出站连接，攻击面就是「主动连了谁」。export 多出来的那个端口
  只认回连密钥（等时比较），每条响应都带 `X-Galaxy-Node` 自证头；密钥默认自动生成在
  `<runtimeDir>/export-secret`（0600）。
- **凭据不出本机。** 上游订阅登录态只在这台机器读取，Hub 与消费者永远拿不到。
- **上游跟着本机正在用的走。** provider 不写 `baseURL` 时，Claude 按 managed-settings /
  `~/.claude/settings.json` / 环境变量里的 `ANTHROPIC_BASE_URL`，Codex 按
  `~/.codex/config.toml`。每次请求重新读，改完不用重启。
- **不留消费者内容。** 每个工作单元一个临时目录，单元结束后整个删掉；
  日志只记 requestId 与贡献 id。
- **节点侧自校验。** Hub 是路由权威，但派下来的单元必须落在本机申报的 kind /
  provider / 模型范围内，否则节点自己拒掉（原则 8）。
- **节点令牌明文存在 `<runtimeDir>/node-token.json`（权限 0600）。**
  它必须能在重启后原样出示给 Hub，存哈希等于每次重启都要重新配对。

## 独立部署（`ai-bridge` 命令行）

同一个包里还有一个可执行文件 `src/bin/ai-bridge.rs`，给服务器上无人值守的节点用：
接入密钥自助注册、poll / export 两种接入、三个平台的服务模板。完整说明见
[`deploy/README.md`](deploy/README.md)。

```bash
cargo build --release --bin ai-bridge            # 本机
node scripts/build-cli.cjs [--target <triple>]   # 连同部署说明与服务模板打成发布包

# 在 macOS 上出 Linux 包（不用 Docker）：zig 当交叉编译器，按 glibc 2.17 链接，老发行版也能跑。
# 先装一次：brew install zig && cargo install cargo-zigbuild
node scripts/build-cli.cjs --target x86_64-unknown-linux-gnu --zig
```

`.node` 与命令行必须分开编：napi 的符号要 Node 宿主提供，所以 `scripts/build.cjs`
只编库（`--lib --features node`），命令行不带 node 特性。

## 远程升级（`pool/upgrade.rs`）

独立部署的命令行可以在控制台上远程升级；随 Nova 分发的 bridge 不行 —— hello 里报
`distribution: "nova"`，真收到指令也只回「请更新 Nova」。

- **信任根是 `release-keys.txt`**：编译期嵌进二进制的 Ed25519 发布公钥。节点先验签名（覆盖版本、
  平台、整包 sha256）再下载，下载完再比 sha256；Hub 下发的地址和校验值都不单独可信。
  文件里一把公钥都没有的构建不能远程升级，hello 的 `upgradeBlocker` 会说原因。
- **runner 只管时机和上报**：心跳收到指令 → 按 id 去重、一次一个 → 报 `downloading` →
  `installing` → `restarting`；装好之后停止领新活（心跳把通道报成 paused、export 入口回 503）
  并通过 `restart_requested()` 交棒。进程主人（`src/bin/ai-bridge.rs`）接着
  `drain_for_restart(120s)` → `stop()` → exec 新文件（PID 不变）。
- **换文件在 `SelfUpdater`**：临时目录建在可执行文件旁边（同一个文件系统，rename 才原子），
  系统 `tar` 解包，先试跑 `<新文件> version`，旧文件留 `.old`，换失败还原。
  可执行文件所在目录必须对运行服务的用户可写。
- **发版**：`scripts/release-sign.cjs`（keygen / sign / verify）；`build-cli.cjs` 设了
  `AI_BRIDGE_RELEASE_KEY` 时顺手签。完整流程见 [`deploy/README.md`](deploy/README.md)「发布与签名」。

`src/pool/upgrade.rs` 的测试对着真 tar 包、本地 HTTP 跑下载 / 验签 / 试跑 / 替换，
还有一组 Node 签名脚本生成的向量；`tests/pool_upgrade.rs` 用假 Hub + 假升级器跑上报顺序、
去重、排空与交棒。

## 已知边界

- Claude 订阅 OAuth 的使用受 Anthropic 产品条款约束，HTTP 转发不保证订阅账号一定
  被上游接受；桥接不合成 Claude Code 身份，只透传真实客户端请求。
- relay 不自动重试上游 429/5xx，原样交给客户端处理。
- pool 模式把个人订阅席位按量共享出去，属于账号共享，被封的是**你的**账号。

## 配置只有一处解析源头

Rust 读 YAML、展开 `${ENV}`、补默认值、做一致性校验。桌面服务不再自己解析配置。
`ai-bridge/test/native-config.test.ts` 把 Rust 与 zod 两个解析器钉在一起：
同一份 YAML 必须得到同一个对象，并且拒绝同一批坏配置。

## 构建与测试

```bash
npm run build          # 编本机，产出 ai-bridge-native.<平台>-<架构>.node
npm run build:debug    # 同上，debug 档
cargo test             # 集成用例在 tests/（原先逐条对着 TS 侧的 test/ 写），export 回连与命令行各有一组

# 交叉编译。macOS 上从 arm64 编 x64 开箱即用（Apple 工具链自带两边），
# 想出 macOS 通用包就两片都要。
node scripts/build.cjs --target x86_64-apple-darwin
```

`node` 是可选 feature：默认关，`cargo test` 才不会去链 Node 宿主才提供的 napi 符号。
`scripts/build.cjs` 会带上它，并把产物按 napi-rs 的命名放到包根目录。

测试里最值钱的一组是 `tests/pool_runner.rs`：它起一个假 Hub，把「领活 → 打上游 →
上行推流 → 报终态」整条链路真的跑一遍，包括节点侧的白名单自校验和长轮询的停机。
TS 侧从来没有这条覆盖。

`index.js` 按 `platform-arch` 挑产物，缺哪一片那个平台就起不来（报错里会列出包里
现有哪几片）。Nova 的 electron-builder 声明了 mac / win / linux 三个目标，所以四片
都得有：

| 平台 | 从哪来 |
| --- | --- |
| darwin-arm64 / darwin-x64 | 本机就能编，见上面的 `--target` |
| win32-x64 / linux-x64 | 只能在对应 runner 上出 —— rustls 底下的 `ring` 要各自的 C 工具链，macOS 上连 `cargo check` 都过不去 |

`.github/workflows/ai-bridge-native.yml` 把这四片都编出来传成工件，本机架构那几片
还会跑一遍 `cargo test`。拿回来的 `.node` 直接放进这个目录即可。

**这个 workflow 还没有真跑过**（仓库此前没有任何 CI）。

## 打包形态的验证

```bash
# 在 client/galaxy 下。不需要 electron-builder，Node < 22.12 的机器也能跑。
npm run verify:bridge

# 有真包时直接验它 —— 这是最终形态，比模拟的那棵树更可信。
node scripts/verify-bridge-packaging.cjs --bundle release/nova/mac-arm64/Nova.app
```

打包后的桥接从 `app.asar.unpacked` 里跑（`runtime.ts` 会把路径里的 `app.asar` 换掉），
模块解析只在 unpacked 这棵真实目录树上逐级向上找，**不会**退回 `app.asar` 里。
留在 asar 里的运行时依赖在开发机上会被仓库的 `node_modules` 兜住，装到 `/Applications`
就直接 `MODULE_NOT_FOUND`。这个脚本按 `asarUnpack` 把那棵树搭到系统临时目录里
（摘掉仓库这层兜底）再真跑一次启停，同时守住「cargo 的 target 别进包」。

不带参数时它按 `asarUnpack` 自己拼一棵树；带 `--bundle` 时直接把真包里的
`app.asar.unpacked` 搬到临时目录再验，顺带检查 `asarUnpack` 声明的依赖是不是真的
都被解出来了。

### 为什么 cargo 的产物在包外

`.cargo/config.toml` 把 `target-dir` 指到了 `client/galaxy/.cargo-target/`。这不是洁癖：
这里是一个 npm workspace 包，`node_modules` 里有它的软链，而 cargo 的 `target` 有
三万多个文件、3.6 GB。实测把它留在包里会同时坏两件事 ——

- electron-builder 在 `searching for node modules` 那步满核扫十分钟，撞上 600s 超时；
- 扫完之后**整个 target 被打进 App**（实测桥接部分 3365 MB）。

而 `build.files` 里那些 `!node_modules/...` 的排除项对「从 workspace root 收上来的
依赖」一条都不生效（`src`、`scripts`、`Cargo.toml` 照样进包），所以不能靠它。
真正管用的就是把产物放在任何 `node_modules` 都够不到的地方，再用上面那个脚本的
体积检查兜底。

## 与 TS 实现的已知差异

1. **非 JSON 请求体逐字节转发。** express 的 `json()` 只在 `content-type` 是 JSON 时解析，
   其余情况 `req.body` 是 `{}`，TS 会把 `"{}"` 发给上游、丢掉原始体。这里改成原样转发，
   与「纯透传」的定位一致。JSON 请求体解析失败仍然是 `400 invalid_json`。
2. **`relay_done` 落在流真正结束时。** TS 的 `proxyRelay` 等整条 pipeline 跑完才返回，
   Rust 拿到响应头就返回、流在后面走完，所以日志改挂在流的收尾上。
   并发名额同样在那一刻才归还（名额跟着流走），语义与 TS 一致。
3. **`stop()` 会掐断在跑的流，并且永远成功。** 前者对应 TS 的
   `server.closeAllConnections()`；后者是新的 —— 配置文件被删了或改坏了，
   正是最需要它停下来的时候，不该因为读不到配置而停不下来。查询接口仍然照实报错。
4. **TLS 根证书走系统信任库**（rustls + native-roots），不再需要 `NODE_EXTRA_CA_CERTS`
   才能连 mkcert 这类私有 CA 签发的 Hub。
5. **`video.edit.render` 的 `cpu.seconds` 报的是真实值。** TS 用 `process.cpuUsage()`，
   那只统计 Node 自己，而 ffmpeg 跑在子进程里，算出来一直接近 0。这里用
   `RUSAGE_CHILDREN`。（这条能力目前不被探测，控制台也不展示。）
6. **工具面板里 ai-bridge 的版本由 Node 传进来。** 桌面版随 Nova 分发，没有独立升级
   通道；TS 里那条 `git rev-parse` 的路径只对独立 CLI 有意义，没有移植。
7. **`local_resources().diskFreeGB` 仍然报的是空闲内存**，与 TS 一致。字段名和取值
   对不上是既有行为，改了会让 Hub 看到的口径突变，等确认 Hub 怎么用它再动。
