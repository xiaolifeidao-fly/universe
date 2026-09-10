# ai-bridge-native

ai-bridge 的 **relay 数据面**，Rust 实现，编译成 Node 原生模块（napi-rs）。
Nova 的 Electron UtilityProcess 里那层薄 JS 壳直接 `require` 它，不再另起进程。

进程形态没变：仍然是 `utilityProcess.fork(ai-bridge/desktop-worker)`，崩溃隔离、
`start/stop/restart` 语义和 `BridgeApi` 的 IPC 协议都和以前一样。变的是壳里跑的东西 ——
配置解析、鉴权、并发闸门、上游凭据与透传从 TypeScript 换成了这个 `.node`。

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
| `app.rs` | `app.ts` 的装配与优雅关闭 |
| `napi_api.rs` | 给 Node 的导出面：`NativeBridge` 与 `parseConfigJson` |

**还留在 Node 的**：`pool`（共享算力池运行循环）、`business`（三种节点 provider）、
`agent`（本机 agent）。前两者计划在第二阶段迁过来；`agent` 的两个 adapter 绑死在
`@anthropic-ai/claude-agent-sdk` 和 `@openai/codex-sdk` 这两个 npm 包上，没有 Rust 对应物，
会一直留在 JS，将来由 Rust 通过回调驱动。

`create_bridge` 在 `mode=pool` 或 `agent.enabled=true` 时**直接报错**而不是忽略：
悄悄按 relay 跑掉一条本该在本机执行命令的请求，这个差别不能默默发生。

## 配置只有一处解析源头

Rust 读 YAML、展开 `${ENV}`、补默认值、做一致性校验；Node 侧拿 `loadConfigJson()`
的结果再用 zod 断言一次类型。两边不一致会立刻炸，而不是各跑各的。
`ai-bridge/test/native-config.test.ts` 把这条约束钉死：同一份 YAML，两个解析器必须
得到同一个对象，并且拒绝同一批坏配置。

## 构建与测试

```bash
npm run build          # cargo build --release --features node，产出 ai-bridge-native.<平台>-<架构>.node
npm run build:debug    # 同上，debug 档
cargo test             # 41 个用例，逐条对着 TS 侧的 test/ 写
```

`node` 是可选 feature：默认关，`cargo test` 才不会去链 Node 宿主才提供的 napi 符号。
`scripts/build.cjs` 会带上它，并把产物按 napi-rs 的命名放到包根目录。

目前只保证 **darwin-arm64**。其它平台的产物按同样命名放进来即可，`index.js` 按
`platform-arch` 找；多平台 CI 还没配。

## 与 TS 实现的已知差异

1. **非 JSON 请求体逐字节转发。** express 的 `json()` 只在 `content-type` 是 JSON 时解析，
   其余情况 `req.body` 是 `{}`，TS 会把 `"{}"` 发给上游、丢掉原始体。这里改成原样转发，
   与「纯透传」的定位一致。JSON 请求体解析失败仍然是 `400 invalid_json`。
2. **`relay_done` 落在流真正结束时。** TS 的 `proxyRelay` 等整条 pipeline 跑完才返回，
   Rust 拿到响应头就返回、流在后面走完，所以日志改挂在流的收尾上；
   客户端中途断开会记 `relay_client_closed`，被取消会记 `relay_error`。
   并发名额同样在那一刻才归还（名额跟着流走），语义与 TS 一致。
3. **`stop()` 会掐断在跑的流。** TS 用 `server.closeAllConnections()`，这里用一个
   贯穿所有请求的取消信号，优雅期（`server.shutdownTimeoutMs`）一过就下发 503。
4. **TLS 根证书走系统信任库**（rustls + native-roots），不再需要 `NODE_EXTRA_CA_CERTS`
   才能连 mkcert 这类私有 CA 签发的 Hub。
