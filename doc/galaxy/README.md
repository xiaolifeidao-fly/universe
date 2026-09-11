# Galaxy 共享算力池

把订阅用户的闲置算力（Claude / Codex 订阅、本机 GPU / ffmpeg 等）汇聚成公共共享池，由平台统一鉴权、调度、计量与结算，供其他用户按需付费使用；同一套通道同时承载中转站、任务宇宙、视频养号等多种业务形态。

| 文档 | 内容 | 读者 |
|---|---|---|
| [需求.md](需求.md) | 背景目标、角色、业务模式、功能与非功能需求、约束、验收、分期、待决策 | 产品、研发、测试 |
| [架构.md](架构.md) | 分层、三种原语、连接模型、控制面/数据面、供给模型、上下文模型、适配器架构、代码布局、部署、安全、演进 | 研发、架构评审 |
| [设计.md](设计.md) | 统一信封、通道协议、消费者 API、放置算法、额度引擎、计量结算、上下文账本、Redis / MySQL 设计、适配器接口、节点侧设计、错误码、安全、可观测、参数、测试、实施顺序 | 研发、测试 |

三份文档共用同一套术语（见需求文档第 2 节），设计文档中的每个协议字段、表、key 都能在架构文档里找到它所属的层。已拍板的决策与仍待定事项见需求文档第 16 节。

相关代码：

- 节点侧：`galaxy/ai-bridge/`（现有中转能力）与 `galaxy/business/*`（契约与节点 provider，待建）
- 服务端：`server/service/galaxy/`、`server/galaxy-api/`（待建）
- 现有参照：`server/app-api/pkg/commands/`（命令通道）、`server/app-api/pkg/redisqueue/`（Redis 唤醒）、`delivery-task-planner/delivery_bridge/remote_worker.py`（节点长轮询 Worker）

## 实现状态（2026-09-07）

P0 / P1 / P2 的骨架都已落地并自测通过。

**P0 验证供给**

| 步骤 | 落点 | 状态 |
|---|---|---|
| 1 契约与 kind 注册 | `server/contract/galaxy.go`、`galaxy/ai-bridge/src/business/` | 完成 |
| 2 共享池核心 | `server/service/galaxy/`（contribution / quota / placement / unit / billing / ops） | 完成 |
| 3 节点通道与消费者面 | `server/galaxy-api/pkg/{agent,consumers,providers,admin,redisctl}` | 完成 |
| 4 中转站适配器 | `adapters/{core,relay}`，两族 usage 解析器 + golden | 完成 |
| 5 节点 pool 模式 | `galaxy/ai-bridge/src/modules/pool/` + CLI `ai-bridge pool …` | 完成 |
| 6 端到端与可观测 | 传输层联调测试 + `/metrics`（设计第 14 节的全部指标） | 完成 |
| 7 抽检与积分账本 | 影子重放、结构签名比对、信誉扣分与自动摘除 | 完成 |

**P1 打通消费**

| 内容 | 落点 | 状态 |
|---|---|---|
| 额度商品、订单、支付回调 | `service/galaxy/order.go`，`zt_galaxy_{package,order}`；回调验签 `pkg/payments` | 完成（只有 HMAC 一种签名法） |
| 争议工单 | `service/galaxy/dispute.go`，`zt_galaxy_dispute`；裁决成立走三本账反向流水 | 完成 |
| 密钥续期换发 | `RenewKey`：新密钥继承余额与允许范围，旧密钥立刻作废 | 完成 |
| session 原语 | `service/galaxy/session.go`：硬亲和、跨节点迁移、回合幂等 | 完成 |
| 上下文账本 | `zt_galaxy_ledger_{session,turn,checkpoint}` + `contextDelta` 回合级同步 | 完成 |
| delivery 适配器 | `adapters/delivery` + 节点 `planner-bridge.ts` | 完成 |
| 抽检与信誉 | 每贡献每日 ≤1% 影子重放，累计两次伪造自动摘除 | 完成 |

**P2 开放与扩展**

| 内容 | 落点 | 状态 |
|---|---|---|
| job 原语 | `service/galaxy/job.go`：租约过期换机器重跑、进度、取消 | 完成 |
| videofarm 适配器 | `adapters/videofarm` + 节点 `ffmpeg-local.ts` | 完成 |
| 数据引力与资源需求过滤 | `Filter` 按 `kind.placement.requires` 比对节点资源 | 完成 |
| 产物直传 | 节点向 Hub 申请 presigned PUT，字节不经 Hub | 完成 |

跑起来：

```bash
cd server/galaxy-api && cp configs/application.example.properties configs/application.properties
# 改 sqlconn / redis.addr 后建表并写入默认定价与额度包
go run ./cmd/galaxyinit && go run .
```

用脚本托管时是 `./redev.sh`（停 → 编 → 起），不是 `./start.sh`：后者只在二进制
**不存在**时才编译，改完代码直接 start 会把上一版产物再跑一遍 —— 进程时间变了、
二进制没变，看着像重启过了。同样的三件套 app-api / manager-api / web-api 都有。

节点侧：桥接已经整体迁到 Rust（`client/galaxy/nova/electron/ai-bridge-native`），
那棵 TypeScript 实现删除了。同一份 Rust 有两个入口：

| 入口 | 给谁 | 身份 | 接入方式 |
|---|---|---|---|
| **Nova 桌面端**（`.node`，Electron 私有通道驱动） | 普通用户，自己的电脑 | 一次性配对码 | 只有 poll |
| **`ai-bridge` 命令行**（`src/bin/ai-bridge.rs`） | 专业用户，服务器上无人值守 | 长期接入密钥 `gpk-…` | poll 或 export |

```bash
cd client/galaxy && npm run build:electron   # 出 .node 并编 Electron
npm run package:nova                          # 打包；也可以 npm run dev:nova 直接跑

cd client/galaxy/nova/electron/ai-bridge-native
node scripts/build-cli.cjs                    # 本机的 ai-bridge 发布包 → client/galaxy/release/ai-bridge
```

「共享哪几种能力、给多少额度」无论哪个入口都在 Galaxy 控制台里定：Hub 每次
hello / 心跳下发生效配置，节点照着建通道。命令行的部署说明见
`ai-bridge-native/deploy/README.md`，两种接入方式的设计见下一节。

## 节点接入方式：poll 与 export（2026-09-11）

在节点长轮询（poll）之外加了第二种接入方式：节点把自己暴露在一个公网地址上，
Hub 主动回连（export）。

**两者只在「活是怎么到节点手上的」这一步不同。** hello、心跳、进度、终态回报、
产物上传全部照旧由节点主动出站；放置、租约、计量、失败语义、结算一行没改。

```
poll    节点 ── POST /agent/v1/next（长轮询）────────▶ Hub     领活
        节点 ── POST /agent/v1/units/{id}/stream ────▶ Hub     回流
export  Hub  ── POST {endpoint}/node/v1/execute ────▶ 节点    送活，字节在同一条响应里回来
             （exportdispatch 替节点调 service.Next 领活，领完送上门）
共用    节点 ── hello / heartbeat / progress / complete ▶ Hub
```

| 部件 | 落点 |
|---|---|
| 接入方式与回连信息 | `zt_galaxy_node.{access_mode, endpoint_url, endpoint_secret, endpoint_status, endpoint_error, endpoint_checked_at}`，迁移 `server/migrations/20260911_galaxy_node_access_mode.sql` |
| 接入密钥 | `zt_galaxy_provider_key`、`service/galaxy/providerkey.go`；控制台 `GET/POST /api/galaxy/provider/access-keys`、`POST …/access-keys/revoke` |
| 自助注册 | `POST /agent/v1/register` → `service/galaxy/access.go` 的 `RegisterNodeByKey` |
| Hub 回连派单器 | `galaxy-api/pkg/exportdispatch`：每台 export 机器一个领活循环，外加每分钟一次回连探测 |
| 节点 export 服务 | `ai-bridge-native/src/pool/export.rs`：`/node/v1/{health, execute, cancel}` |
| 命令行 | `ai-bridge-native/src/bin/ai-bridge.rs`：`init / register / run / status`；发布包 `scripts/build-cli.cjs`，CI 的 `cli` 任务出五个平台 |
| 控制台 | Nova「账户」页：机器列表显示接入方式与回连状态；「接入密钥」卡片签发 / 吊销并给出命令 |

几条要记住的规则：

- **接入密钥 vs 配对码。** 配对码一次性、10 分钟有效，前提是有人同时看着两块屏幕；
  接入密钥长期有效，写进服务器配置，`ai-bridge run` 每次启动都先用它重新注册 ——
  令牌被撤、库重建、公网地址变了，重启一次就自己回来。明文只在签发时返回一次，
  库里存 sha256；签发和注册都要求当前条款版本的同意记录。
- **注册沿用同一条节点记录。** 带上本机上一次的 nodeId，Hub 校验属于同一主人后只换令牌、
  不新建。控制台**解绑过**的 nodeId 拒绝注册 —— 否则解绑会被下一次自动重启悄悄抵消；
  确实要重新接入得在那台机器上执行 `ai-bridge register --fresh`。封禁的直接拒。
- **名下可以同时在线多台机器，但同一台电脑只能配对一次。** 配对码兑换时带上本机上一次的
  nodeId：那条节点还在线就拒绝（先在控制台解绑再配）；已离线或解绑过就放行，配成后旧记录
  自动退役。别的机器在线与否不影响配对 —— 以前是「名下只能一台在线」，机房服务器一在线，
  主人的笔记本就配不回来。接入密钥这条路本来就不受限，专业用户部署一排机器正是它存在的理由。
- **回连密钥由节点生成**，注册与每次 hello 时上报（公网地址会变，只报一次会让 Hub
  拿着失效地址一直回连不上）。Hub 存明文 —— 它是客户端，要出示。它不进任何视图与日志，
  控制台只看得到回连地址。
- **SSRF 的闸是 `X-Galaxy-Node`。** 回连地址是提供者自己填的：节点的每一条响应（含错误响应）
  都必须带自证头，对不上的响应一个字节都不转发给消费者。链路本地地址（169.254/16、fe80::/10）
  两端都直接拒绝；私网地址放行 —— 自建部署里 Hub 与节点同在内网是常态。
- **回落优先于拒绝。** export 声明不成立（缺 publicURL、地址不合法、密钥太短）时按 poll 接入；
  Hub 在 hello 响应里回 `accessMode`，节点据此同时去长轮询，活不会掉在地上。
  例外是端口被占用：那会造成「地址通但没人应答」的假象，节点直接启动失败。
- **回连健康和在线是两件事。** 心跳是节点主动出站的，端口没映射照样心跳正常；控制台分开显示，
  「在线但回连失败」就是去查防火墙。派单成功时结论不变不写库，探测每分钟刷新一次时间。
- **派不出去立刻收交汇点。** 连不上、自证头不对、节点拒单，都先 `FailUnit` 再收掉交汇点，
  消费者那边马上走改派，而不是干等 30 秒 attach 时限。节点回 409 / 5xx 可改派，其余 4xx 不改派。
- **只支持单实例 Hub。** 回流的字节只能交给持有消费者连接的进程，而队列跨实例共享。
  派单器领到一个消费者连在别处的单元时判可改派的失败交还通道层；刻意不让节点按请求里
  给的地址反连推流 —— 那等于让拿到回连密钥的人指挥节点把自己的令牌发往任意地址。

三种原语的消费者接口：

```
relay     POST /v1/messages | /v1/responses | /v1/chat/completions      同步流式，响应即结果
session   POST /v1/delivery/sessions            开会话
          POST /v1/delivery/sessions/{sid}/turns 提交回合 → 202
          GET  /v1/delivery/sessions/{sid}/turns/{seq}/events  SSE，可按 seq 断线重连
          GET  /v1/delivery/sessions/{sid}/context             业务层上下文全量
job       POST /v1/videofarm/jobs               提交任务 → 202
          GET  /v1/videofarm/jobs/{id}          进度与产物
          GET  /v1/videofarm/jobs/{id}/events   SSE
```

每次调用的响应头都带 `X-Galaxy-Request-Id`，值就是那一次执行的 `unitId`。
消费者拿它订阅事件、排障、提申诉 —— 三段（消费者 / Hub / 节点）看到的是同一个串。

控制台另有一组**按人**过滤的只读接口（`/api/galaxy/consumer/{sessions,jobs,disputes}`）。
它们和上面那套按 `sk-` 密钥授权的接口是两条路：控制台拿的是用户令牌，而一个人
名下通常有好几把密钥，范围由令牌解析出的密钥集合决定，请求里的 `keyId` 只能在
这个集合内收窄。

支付渠道回调在 `POST /galaxy/payments/{channel}/callback`，**不带用户鉴权** ——
打过来的是渠道的服务器，身份由报文签名证明。路径里的 `{channel}` 是渠道码，
`galaxy-api/pkg/payments` 的 `Registry` 按它分发到**这个渠道自己的**验签器：
不做任何回退，找不到就拒。回退到「默认渠道」意味着拿 A 的密钥去验 B 的通知，
A 哪天泄露 B 跟着失守。一个已验签渠道都没配时这条路由整个不注册。

到账另有两条不经收银台的路，都不走验签：

| 路径 | 认谁 | 用途 |
|---|---|---|
| `POST /api/galaxy/consumer/orders/pay` | 平台管理员 | 线下转账、渠道回调丢了要补单 |
| `POST /api/galaxy/consumer/orders/pay/sandbox` | 订单本人 | 内测期把购买链路跑通 |

沙箱那条的安全边界靠三件事撑着，缺一件它就是个免费发额度的接口：渠道必须在
`galaxy.payment.sandbox_channels` 里被显式标成沙箱；订单必须是调用者自己的
（不是就回 `ErrNotFound`，连「这单存在」都不告诉他）；履约仍走同一套幂等状态机。
沙箱渠道**不接受任何外部回调** —— 从公网 POST 到它的回调路径上会被 `Registry` 挡掉。
控制台按 `GET /api/galaxy/consumer/payments/channels` 渲染收银台，沙箱渠道在那里
带着 `sandbox: true`，界面必须把它标出来：不标的话，运营看着订单变成已到账，
会以为钱真的进来了。

额度商品的维护在运营后台的「额度包」页签，接口是 `GET /api/galaxy/admin/packages`
（列**全部**，含已下架）与 `POST /api/galaxy/admin/packages/save`（只认平台管理员）。
它原来挂在 `/api/galaxy/consumer/packages/save`，靠一个中间件在消费者路由组里把门 ——
运营动作和封禁、裁决放在一起才对得上。消费者侧仍只有只读的
`GET /api/galaxy/consumer/packages`，固定 `listedOnly=true`。

保存是**整行覆盖**不是打补丁，所以前端的编辑框一律用当前值预填；商品码建了不能改
（历史订单按它记录买的是什么）；没有删除，只有下架 —— 删了的话，引用这个码的
历史订单就查不到自己买的是什么了。改价改量不影响已经下过的单：额度与价格在
下单那一刻就快照进订单了。

指标在 `/metrics`（Prometheus 文本格式，无鉴权，按部署侧决定谁能访问）。

## 界面

三类角色落在两个应用，不是三个：

| 角色 | 落点 | 页面 |
|---|---|---|
| 提供者、消费者 | **`client/galaxy`**（新建，:7898） | `/provider/{overview,contributions,records}`、`/consumer/{keys,billing,usage,workloads}` |
| 平台运营 | `client/manager` 的 `/galaxy` | 池水位 / 节点与贡献 / 抽检 / 争议工单 / 额度包 / 结算汇总 六个页签 |

**为什么提供者与消费者合成一个应用**：它们常常是同一个人的两副面孔（我贡献算力 /
我买算力用）。侧栏分「我贡献的」「我使用的」两组，不做角色切换开关 —— 强行二选一
只会让人为了看另一半反复退出登录。

**为什么不并进 `client/web`**：web 是内部产研的交付控制台（身份锁在
`product_research` persona，delivery-api 里三十多处 `RequireProductResearch()`），
而 Galaxy 是准备对外开放的双边市场（需求文档 P2）。塞进去等于将来要么拆出来、
要么给外部用户开内部控制台的门。另外它是另一个服务（galaxy-api `:10004`）、
另一套凭证，依赖重量也对不上（web 背着 three / g2 / dnd / xlsx，这里一个都不用）。

**运营后台的接口由 manager-api 自己出**（`manager-api/pkg/galaxy`），底层直接复用
`service/galaxy`，浏览器不碰 galaxy-api。

一度是在代理层按 `/api/galaxy/*` 前缀分流到 `GALAXY_TARGET` 的，但那条路在鉴权上
走不通：管理端有自己的一套身份（`zt_manager_*` + Redis 会话里的不透明随机串），
而 galaxy-api 认的是 `service/identity` 签的 JWT —— 这是 manager-api 刻意不挂
`httpx.SetUserAuthenticator` 的结果，不是配漏了。浏览器拿管理端令牌直连过去，
每个请求都被判成 `not login`，前端拦截器一看到这四个字就清 token 跳登录页，
症状是「点进共享算力池就被踢出来」。

换成「代理层换票」或「manager-api 拿服务凭证转发」也能通，但那是在两个进程之间
搬一份本来就同库同表的数据：账在同一个 MySQL、控制面在同一个 Redis，manager-api
两样都连得到，中间那一跳不承载任何东西。所以 `galaxy-api/pkg/admin` 和
`manager-api/pkg/galaxy` 是同一个领域服务的两个装配方 —— 前者给业务身份的控制台
管理员，后者给管理端的角色体系（权限判定统一在 `manager-api/auth` 那道中间件上，
写方法还要再过一次角色的 writable 开关）。前端 api 文件的路径两边一致，没有变。

`galaxy.ControlPlane` 的 Redis 实现因此从 `galaxy-api/pkg/redisctl` 挪到了
`service/galaxy/redisctl`：两个装配方都要用它，谁都不该去 import 对方那个可执行
模块。领域包 `service/galaxy` 本身仍然不认识 Redis，依赖方向没有变。

**新增的运营路由必须跑一次 `cd server/manager-api && go run ./cmd/managerinit`**：
管理端的接口资源表是按真实路由表生成的，没登记的路由登录用户一律访问不到
（超级管理员例外，`checkRoute` 对超管直接放行）。manager-api 启动时会把未登记的
路由逐条打出来。

```bash
cd client/galaxy && npm install && npm run dev   # :7898
cd client/manager && npm run dev                 # :7895，/galaxy 是运营页
```

测试：`go test ./...`（各模块）与 `npm test`（ai-bridge）。覆盖的关键路径是
额度窗口与有效座位数、放置的硬过滤与打分、Lua 的原子性与幂等（miniredis）、
两族 usage golden、消费者与节点之间的字节对拷与失败语义、事件日志的不重不漏、
session 的异步提交与断开幸存、抽检签名的抗噪声、指标注册表的并发与格式。

## 实现中对设计的修正

写代码时发现下面这些地方按文档原样做会出问题，实现取了另一种做法。**以本节为准**，
三份设计文档的对应段落尚未回改。

| 位置 | 文档写法 | 实际做法与原因 |
|---|---|---|
| 设计 2.1 节点令牌 | token 以 sha256 落盘，明文只在内存 | **明文落盘（0600）+ 指纹进日志**。哈希无法出示给 Hub，按文档做的话节点每次重启都要重新配对，与「长期 node token」矛盾。防护对齐 `~/.codex/auth.json` 的做法 |
| 架构 11.2 代码布局 | 节点侧契约与 provider 放 `galaxy/business/` | **放 `galaxy/ai-bridge/src/business/`**，内部结构与文档一致。ai-bridge 作为插件是整目录分发的（`rsync` 只同步 `ai-bridge/`），依赖兄弟目录会装出一个跑不起来的插件 |
| 设计 8 节 `node:seats:{cid}` | SET | **ZSET，score = 座位过期时刻**。SET 没有成员级 TTL，座位到期收不回来，一个走掉的消费者会永久占着位置 |
| 设计 8 节 `contrib:{cid}.quotaLeft` | 一个 JSON 字段 | **按单位展开成 `limit:`/`used:`/`left:` 三组 hash 字段**。放置与结算都要在 Lua 里改单个维度，HINCRBY 一个字段是原子的，读改写一个 JSON 串不是 |
| 设计 6.2 「抽检判定伪造 → 追回」 | 只说了追回 | **追回不抹原始流水，而是在三本账上各记一笔反向的**（`refund` / `clawback` / `baddebt`，幂等键加 `:dispute` 后缀）。抹掉原始记录对不出「这笔钱进来过又出去了」，事后没法审 |
| 设计 S-09 争议工单 | 未说明受理期限与粒度 | **工单钉在 `(unitId, attempt)` 上，且只受理 7 天内的执行**。结算幂等键就是这两个，重跑过的单元每次尝试各自结算，只钉 unitId 会让一次退款退掉两次的钱；不设期限则提供者的积分永远处在「随时可能被追回」的状态，提现结不了账 |
| 需求 S-09 后台 | 未说明运营用哪种身份 | **新增 `httpx.RequirePlatformAdmin()`**，galaxy 的处置动作（封禁、裁决、发密钥、人工确认到账）改用它。原有的 `RequireAdmin()` 除管理员外还要求 `product_research` 身份 —— 那是交付工作台的门，共享池的运营不在那个身份体系里，沿用它等于把唯一能处置的人挡在门外 |
| 设计 13 节 requestId | 「消费者 ← Hub ← 节点三段同一值」 | **实现补了 `X-Galaxy-Request-Id` 响应头**。原先消费者侧根本拿不到这个值，也就无从申诉、无从追问某一次调用 |
| 设计 4.2 步骤 4 `q:wait` | Redis ZSET 等待队列 | **进程内等待**。P0 单实例，等待发生在持有消费者连接的那个进程里；放进 Redis 也没有第二个实例去唤醒它。队列深度仍作为指标暴露 |
| 需求 C-05 / 设计 4.2 步骤 4 | 候选为空一律排队至多 `maxWaitMs` | **只在「有贡献忙完就能接」时排队**：并发占满、额度被在途请求预留着（含已绑定的那台忙着）。车道里没人、模型没人提供、离线 / 暂停 / 排空 / 限流 / 时段外、额度真用完、座位都被别人绑着，这些在十秒里变不了，立刻 `503 no_capacity`。原先照样挂满 10 秒才回同一个 503（`Waitable`） |
| 设计 4.4 `w5·reputation` / 6.2 信誉列 / 8 节 `contribution.reputation` | 信誉挂在贡献上，只写了扣分 | **提供者分散户 / 工作室，信誉按身份跟着账号或设备走，按天回升**。贡献 id 带 nodeId、每配一次对就是新 nodeId，挂在贡献上等于解绑重配就清零。注册默认是散户，信誉跟着账号（名下机器共用一份）；管理端可以把账号设成工作室（`zt_galaxy_provider`，接口 `POST /api/galaxy/admin/provider/type`），信誉改为跟着设备：节点在 hello 里报设备指纹（sha256，原始硬件 id 不出本机：Linux 取 `/etc/machine-id`，macOS / Windows 取主板 UUID，都没有才用运行目录里的随机 id），每台机器各算各的，换账号再配也是同一份；没报指纹的老节点拿节点当设备。扣分同时记在账号和设备两份上（`zt_galaxy_reputation`），读哪份看当下身份，所以改身份不清零。指纹是节点自报的，工作室这层伪造风险留给后续的接口加签与指纹管控。库里存「上次结算的分数 + 时刻」，此刻的分数按 `galaxy.reputation_recovery_per_day`（默认 0.05）现算，扣分和回升在同一条 upsert 里结算。心跳每 15 秒把分数写进快照 —— 原先只有 hello 时写，一直在线的机器派单时用的是它上次重连那一刻的分数。迁移 `server/migrations/20260911_galaxy_provider_reputation.sql` |
| 需求 S-09「节点信誉与封禁」/ 设计 6.2「追回 + 封禁」 | 封禁挂在节点记录上（`zt_galaxy_node.banned`） | **封禁跟着设备走，和散户 / 工作室无关**。每配一次对就是一个新 nodeId，配对闸也不看封禁的节点，只封节点记录的话，被封的机器解绑重配、换个账号再配就回来了。报过设备指纹的节点，封禁记在指纹上（`zt_galaxy_machine_ban`），同一台设备上的每条记录一起封、一起解；解封不删行，也不替主人把贡献打开。请求路径仍然只看 `zt_galaxy_node.banned`，鉴权不为它多查一张表：封禁 / 解封时带这个指纹的节点一起改，新配出来的记录在 hello 报上指纹时补标并被拒（401 `node_unauthorized`，和鉴权拦下时同一个回应），在那之前它一行贡献都没有。hello 报上来的指纹和记录上的不一样（令牌被拷到了被封的机器上）也拒，但不标那条记录。没报过指纹的老节点只能封节点那一行。指纹是节点自报的，挡的是正常客户端重配、换账号，挡不住改过的客户端。代码 `service/galaxy/ban.go`，迁移 `server/migrations/20260911_galaxy_machine_ban.sql` |
| 设计 10.1 `ExtractUsage` | Adapter 上的独立方法 | **并入 `EventWriter.Usage()`**。流式响应的用量是边对拷边解析出来的，没有一个「事件都收齐了」的时刻可以事后调用 |
| 设计 10.1 `Writer(ctx, unit)` | 只给工作单元 | **同时给已解析的 Input**。Parse 阶段的决定（例如 Hub 是否注入过 `stream_options.include_usage`）要一直影响到写回 |
| 设计 1.1 WorkUnit.inputs | relay 只有 `body` | **加一个 `headers` 载荷**，装白名单内的客户端协议头（`anthropic-version`、`x-stainless-*` 等）。丢掉它们上游行为就与直连不一致，验收里的逐字节比对过不了 |
| 设计 2.7 贡献 id | 主人起的短名 | **Hub 侧扩成 `nodeId:短名`**。两台机器都叫 `claude-main` 是常态，而队列、额度、绑定都以 cid 为主键，必须先消歧；节点看到的仍是自己的短名 |
| 设计 8 节 Redis | 未说明部署形态 | **多键 Lua ⇒ 单机 / 主从**。上 Cluster 需要先给 cid 与 rid 加同一个 hash tag，或把脚本拆成贡献侧与请求侧两段并接受中间的窗口 |
| 非功能需求·吞吐 | ≥ 500 节点长轮询 | **Redis 连接池必须大于同时长轮询的节点数**（默认 600）。领活用 BLPOP，每个在轮询的节点独占一条连接，池子小了表现为「节点连得上但永远领不到活」 |
| 待决策 O-02 业务空间 | 单元携带真实 `biz_line` | **单独一列 `space`**。让 `biz_line` 多值会让「所有索引以 biz_line 打头」这条对池内表失效；业务空间是统计维度，不是隔离维度 |
| 设计 13 抽检签名 | 「结构相似度」 | **只比事件类型集合与 JSON 键路径，不比出现次数**。次数取决于回答长短，把它算进去会让一个短回答和一个长回答看起来结构不同 —— 抽检的错杀代价是摘掉一台诚实的机器 |
| 设计 3.2 会话事件 | 未说明断线重连 | **事件带 seq，支持 `Last-Event-ID` / `fromSeq` 续读**。回合跑几分钟，消费者中途断开是常态；先回放数据库再接实时流，不重不漏 |
| 设计 2.9 turn 幂等 | 「节点返回已有结果不重跑」 | **幂等在 Hub 做，不在节点**。`(sid, seq)` 上的唯一键在派单之前就占住，节点根本不会收到第二份 —— 交给节点意味着并发的两次提交真的会跑两遍 |
| 架构 T-01 / 需求 P-15 | 节点只主动出站，Hub 永不主动连节点；pool 模式不监听端口 | **新增 export 接入方式：Hub 主动回连节点的公网地址，节点为此监听一个端口**。poll 仍是默认、也是 Nova 客户端唯一的方式。差异只在「领活」一步（见「节点接入方式」），出站链路与全部失败语义不变 |
| 需求 P-16 配对 | 配对码是唯一的接入凭证 | **加一条长期接入密钥（`gpk-…`）自助注册的路**，给无人值守的服务器。签发与注册同样要求当前条款版本的同意记录；解绑过的机器不会被自动接回。配对码也不再要求「名下只能一台在线」，改为同一台电脑只能配对一次（按本机上一次的 nodeId 认） |

## 尚未实现

- **接一个真实的支付渠道**：多渠道的骨架已经落地（`galaxy.PaymentVerifier` /
  `PaymentDirectory` 两个端口 + `pkg/payments` 的 `Registry` 按渠道码分发 +
  未鉴权的 `POST /galaxy/payments/{channel}/callback`），领域侧会核对金额与币种
  再履约，控制台能列出渠道让人选。但**目前只有 HMAC-SHA256 这一种签名法**，
  真实渠道要接微信 V3（SHA256-RSA + APIv3 密钥解 `resource`）或支付宝 RSA2
  （表单参数排序后验签），得在 `pkg/payments` 里各加一个 `PaymentVerifier`
  实现，装配时多注册一个 `payments.Channel`，领域层一行不用改。
  在那之前内测走沙箱渠道（`galaxy.payment.sandbox_channels`），
  它只在控制台里由本人点击到账，绝不能带进生产。
- **节点 provider 的真实对接**：`delivery-task` 的节点侧是一套进程协议
  （stdin 收 JSON、stdout 吐 NDJSON），delivery-task-planner 那边还没有对应的
  `--stdio` 入口；`ffmpeg-local` 只做了 concat + 缩放/帧率，特效与字幕没接。
- **多实例**：`streamURL` 已经按实例地址下发，但等待队列还在进程内（见下表），
  跨实例的 rid 路由没做。export 回连同样只支持单实例（见「节点接入方式」）：
  要么让派单器只领本实例的单元，要么在实例之间转发回流字节。
- **ai-bridge 命令行的服务化**：Windows 上用的是登录时启动的计划任务，不是真正的
  Windows 服务（那要实现 SCM 应答）；CI 的 Linux 包在 Ubuntu 22.04 上编，依赖
  glibc ≥ 2.35（在 macOS 上用 `build-cli.cjs --zig` 交叉编译可以降到 2.17），
  没有出 musl 静态版本。
- **P3 老命令通道迁移**：`zt_delivery_command` 原地运行，没有迁到 session / job。
- **`client/` 的 npm workspaces**：`client/shared` 靠一个符号链接解析裸导入，第三个
  app 一来就会拿到别人的 antd 实例。galaxy 眼下的绕法是自己写一份 i18n Provider，
  根治要把 `client/` 做成 workspaces。详见 `client/shared/README.md`。
