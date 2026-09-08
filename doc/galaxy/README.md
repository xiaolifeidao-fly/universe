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

节点侧：

```bash
cd galaxy/ai-bridge && npm run build
node dist/main.js pool probe          # 看本机有什么能力（只列出，不申报）
node dist/main.js pool pair <配对码>  # 换取长期节点令牌
node dist/main.js start               # mode=pool 时加入共享池，不监听任何端口
```

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
  跨实例的 rid 路由没做。
- **P3 老命令通道迁移**：`zt_delivery_command` 原地运行，没有迁到 session / job。
- **`client/` 的 npm workspaces**：`client/shared` 靠一个符号链接解析裸导入，第三个
  app 一来就会拿到别人的 antd 实例。galaxy 眼下的绕法是自己写一份 i18n Provider，
  根治要把 `client/` 做成 workspaces。详见 `client/shared/README.md`。
