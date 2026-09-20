# 表设计

> 现状：本文只写**已经落地**的表。6 层业务（resource / task / risk / strategy / aisched /
> orchestration）的表随各层实现逐节补进来，别把目标态写在这里当既成事实。

## 全局三条铁律

1. **跨层不建外键。** 各层独立发版，外键会把 DDL 变更耦合死。层内可以建，跨层靠业务键关联，由应用层保证。
2. **跨层引用默认使用稳定业务键**（如 `item_key` / `account_id` / `device_id`）；交付项目是例外，所有 `zt_delivery_*` 与项目授权均使用 `zt_delivery_program.id` 的 `BIGINT program_id`。
3. **每张表带 `biz_line`，所有索引以它打头。**

推论：**各层只写自己前缀的表**（`zt_delivery_*` 只有 `service/delivery` 能写，由
`service/delivery/internal/repository` 的 Go internal 规则在编译期保证）。

命名：表 `zt_{层}_{实体}`（实体单数），唯一键 `uk_{缩写}_{实体}`，索引 `idx_{缩写}_{实体}_{用途}`。

---

## 业务线 `zt_bizline_*`（缩写 `bizline`）

业务线定义是控制台项目、阶段、模块、任务和快照数据的横切范围。项目新建和编辑时的
业务线选择器读取已启用的定义；编辑后换业务线会把该项目的整套交付数据一起迁移。

| 表 | 作用 |
|---|---|
| `zt_bizline_def` | 业务线编码、显示名和启用状态 |
| `zt_bizline_capability` | 业务线声明的端侧能力集 |

**建表：** 直接执行 [`server/bizline.sql`](bizline.sql)，或从 `server/web-api` 执行
`go run service/bizline/cmd/bizlineinit`。两者都会幂等初始化 `whatsapp`，后续通过业务线
维护功能新增或启用的记录会自动出现在项目表单的选择项里。

---

## 共享算力池 `zt_galaxy_*`（缩写 `gx`）

Galaxy 把订阅用户的闲置算力汇聚成公共共享池，由平台统一鉴权、调度、计量与结算。
设计见 [`doc/galaxy/`](../doc/galaxy/README.md)。

共享池按**平台维度**运行，不按空间隔离：池内表的 `biz_line` 固定为 `galaxy`。
任务宇宙等按空间运行的业务接进来时，其 `unit` 行携带适配器解析出的真实空间。

**供给单元是贡献，不是节点**——座位、额度、队列、绑定、限流全部以 `cid` 为主键。
一台机器（节点）可以有多个贡献，同机两个贡献的额度互相独立。

**账号是 Galaxy 自己的，和下面 `zt_identity_*`（任务宇宙）无关，而且两端各一张表。**
共享端（提供者，Nova）和使用端（消费者，Orbit）是两批人，各注册各的，令牌互不通用；
池内表里所有 `owner_user_id` / `user_id` / `provider_user_id` 存的都是这两张表的 `user_id`
（共享端 `pu_…`，使用端 `cu_…`，从任务宇宙迁过来的是 `pu_legacy_<原 id>` / `cu_legacy_<原 id>`）。
两张表的列一模一样——分表不是为了让两端长得不一样，是为了它们在库里没有交集：**查账号必须
先说清是哪一端**，漏掉端的查询查不出东西，而不是把另一端的人捞出来。运营不在这套账号里：
共享池的运营接口全在 manager-api，认的是 `zt_manager_*`。

| 表 | 作用 |
|---|---|
| `zt_galaxy_provider_user` | 共享端账号。用户名在本端内唯一；`token_version` 签进令牌，改密码、重置、停用都加一 |
| `zt_galaxy_consumer_user` | 使用端账号。列与共享端那张相同；积分、邀请码、订单都挂在这批账号上 |
| `zt_galaxy_provider` | 共享端账号的身份：散户 / 工作室。没有行就是散户，只有运营能设成工作室 |
| `zt_galaxy_node` | 提供者的一台机器；`token_hash` 存节点令牌的 sha256，撤销即置空 |
| `zt_galaxy_pairing_code` | 一次性配对码，10 分钟有效，只对已记录条款同意的提供者签发 |
| `zt_galaxy_contribution` | 贡献：kind + provider + 模型白名单 + 座位 + 挂机时段 + 信誉 |
| `zt_galaxy_quota_grant` | 授权行 `(cid, unit, limit, window, reset_at)`；额度以 Hub 为权威 |
| `zt_galaxy_quota_window` | Redis 计数器的分钟级快照，供对账与控制台展示 |
| `zt_galaxy_seat_binding` | 座位绑定留痕；权威在 Redis（带 TTL），这里供审计 |
| `zt_galaxy_unit` | 工作单元：一次请求 / 一个回合 / 一个任务的权威记录 |
| `zt_galaxy_unit_event` | 单元事件流；只记结构化事实，不记 body 与凭据 |
| `zt_galaxy_meter_record` | 计量流水，幂等键 `(unit_id, attempt, unit)`，对账以它求和为准 |
| `zt_galaxy_usage_mismatch` | 节点自报与 Hub 解析的偏差超阈值的记录，累计影响信誉 |
| `zt_galaxy_consumer_key` | 算力密钥：鉴权按 sha256 查；`secret_cipher` 是明文的 AES-GCM 密文（加密密钥在配置 `galaxy.key_cipher_secret`，不进库），给「一键使用」和运营转交取回；带有效期、冻结期与允许范围 |
| `zt_galaxy_consumer_balance` | 密钥的单位余额 |
| `zt_galaxy_consent_record` | 提供者加入同意与消费者数据告知确认；两者都是硬前置 |
| `zt_galaxy_price` | 「kind × 模型 × 单位 → 单价」表。两个价：`price` 向使用者收、`provider_price` 结给共享者，差额是平台毛利，都按每百万单位的微分存。`model_id` 空串是**该 kind 的兜底价**，取价先找模型自己的行、按单位找不到才回落。`provider_share` 是老口径，只在 `provider_price` 为 0 时回落。**除唯一键外没有别的索引**：取价靠 `uk_gx_price` 的前缀，所以计费路径一定要带 `kind`，`ORDER BY` 也一定要和索引同向（全升序）—— 见 `ListEffectivePrices` 的注释 |
| `zt_galaxy_artifact` | 产物元数据；字节在 OSS，服务端只签 presigned URL |
| `zt_galaxy_credit_account` | 提供者积分账户。存**微积分**（1,000,000 = 1 积分 = ¥1），和使用者那本 `points_account` 同一口径 |
| `zt_galaxy_consumer_ledger` / `zt_galaxy_provider_ledger` / `zt_galaxy_platform_ledger` | 双账本 + 平台抽成与坏账 |
| `zt_galaxy_payout` | 提现申请。账本只记受理那一笔，待打款/驳回这段状态在这张表上 |
| `zt_galaxy_audit_probe` | 抽检记录：以 Hub 自有账号影子重放，比对结构相似度 |
| `zt_galaxy_package` | 额度商品：多少钱换多少额度、密钥有效期多久；`model_id` 绑定模型目录里的模型，分享返现按它的比例算 |
| `zt_galaxy_order` | 订单。支付与履约分两步，回调只推到 `paid`，履约幂等；`pay_method` 区分积分与支付渠道，积分购买的扣分、推到已付、签发在同一个事务里 |
| `zt_galaxy_ledger_session` | 有状态会话：钉在哪个贡献、跑到第几回合、工作区在哪个 commit |
| `zt_galaxy_ledger_turn` | 回合摘要。`(sid, seq)` 是幂等键，重复提交不重跑 |
| `zt_galaxy_ledger_checkpoint` | 节点侧 CLI 的高保真快照，绑 CLI 版本 |
| `zt_galaxy_dispute` | 争议工单。`(unit_id, attempt)` 唯一，同一次执行只能有一张 |
| `zt_galaxy_model` | 门户与使用端模型广场的模型目录（怎么讲清楚这个模型），不参与计价也不参与派单；为空时回落到 `galaxy.models` 声明的清单。`referral_bps` 是分享返现比例（万分之一），NULL 走默认 |
| `zt_galaxy_lead` | 门户「联系我们」线索。**全站唯一被未鉴权接口写入的表**，字段一律短、按 IP 限流、`ip`/`user_agent` 不进任何对外视图 |
| `zt_galaxy_points_account` | 使用者积分余额（1 积分 = ¥1，存微积分）。和提供者的 `credit_account` 是两本账 |
| `zt_galaxy_points_ledger` | 积分流水：运营充值 / 买套餐 / 分享返现。和余额变动同一个事务写，`txn_id` 幂等；管理端的充值明细就是 `type=recharge` 的行 |
| `zt_galaxy_referral` | 使用者的邀请码与邀请人。注册时和账号一起建，之后邀请人不可改；老账号打开分享页时补码 |
| `zt_galaxy_setting` | 运营随时要改、改完不该重启的开关，目前只有默认返现比例 `referral.default_bps` |
| `zt_galaxy_bridge_release` | 已发布的 ai-bridge 安装包（一个版本一个平台一行）。字节在 OSS，这里只有 sha256 与 Ed25519 发布签名；节点只装验得过签名的包，下架不删行 |
| `zt_galaxy_provider_referral` | 共享端的邀请码与邀请人。和使用端的 `zt_galaxy_referral` 是两张表、两套码：两端是两批人，码混在一个命名空间里会「查得到但返错人」 |
| `zt_galaxy_desktop_release` | 桌面客户端（Nova / Orbit）的发版记录，一个端 × 一个平台通道 × 一个版本一行。存的是要写到 OSS 上的 `latest-*.yml` **原文**；没有 sha256 与发布签名 —— 包一百多兆，字节不经服务端（浏览器拿签名地址直传），校验值在清单里。客户端走 electron-updater 直接读 OSS，不打服务端任何接口 |

**建表：** 两条路等价。`cd server/galaxy-api && go run ./cmd/galaxyinit` 走 AutoMigrate，
并顺带写入 `llm.chat` 的默认定价；或者直接执行 `server/galaxy.sql`（只建表，定价表是空的，
请求会因为「未定价」只计量不计费）。与 delivery 一致，建表不做成进程启动的副作用。

`galaxy.sql` 不是手写的，是让 GORM 自己走一遍建表流程抄下来的
（`service/galaxy/internal/repository/ddldump_test.go`，`GALAXY_DDL_OUT=... go test -run TestDumpDDL`），
所以先跑 SQL 再跑 galaxyinit 不会被 ALTER。它因此刻意不写 COLUMN COMMENT、不加多余 DEFAULT ——
AutoMigrate 会把「库里有、模型里没有」判定为差异改回去，字段说明放在 `--` 行注释里。
表清单的唯一出处是 `repository.models()`，`TestGalaxySQLCoversEveryTable` 守着两者不漂。

已经建过库的环境走增量：`server/migrations/20260907_galaxy_dispute.sql`、
`server/migrations/20260910_galaxy_payout.sql`，以及 `server/migrations/` 下其余 `*_galaxy_*.sql`。
`20260911_galaxy_user.sql` 建两张账号表、把老数据从任务宇宙账号迁过来，
并把这份脚本上一版建的两端共用表 `zt_galaxy_user` 里的行按端搬进新表（旧表不删，确认无误后手工 DROP），
**要在发新版 galaxy-api 和 manager-api 之前跑**。
`20260912_galaxy_points_referral.sql` 加积分、邀请、配置三类表和密钥 / 套餐 / 订单 / 模型的新列，同样**先于发版**：
新版使用端注册在同一事务里写 `zt_galaxy_referral`，表不在注册整个失败。
`20260912_galaxy_bridge_release.sql` 给 `zt_galaxy_node` 加十个升级相关的列并建安装包表，
`20260912_galaxy_provider_referral.sql` 建共享端邀请表并给供给侧账本加 `related_user_id`。
这两个**必须先于新版 galaxy-api 发布**：节点行的那十列在每次 hello / 心跳的查询里，
缺列会让**所有机器**连不上（不是少一个功能，是整个池子掉线）。

`20260919_galaxy_price_model.sql` 给价目表加 `model_id` 并把唯一键换成
`(biz_line, kind, model_id, unit, effective_from)`，让同一个 kind 下每个模型能各自定价。
存量行一律落成兜底价（`model_id = ''`），行为和跑之前完全一样。
**必须先于发版跑**，而且比下面那条更硬：新版的取价、保存、删除都带 `model_id`，
缺列会让 `zt_galaxy_price` 上每一次读写都报 1054 —— 也就是**全站不计费、不结算**
（`record` 取价失败直接返错）。`model_id` 是 `NOT NULL DEFAULT ''`：MySQL 的唯一索引不拦 NULL，
这一列可空的话「同 kind 同单位同生效时刻」能插进两行，取价先拿到哪行全看运气。

`20260919_galaxy_provider_price.sql` 给价目表加 `provider_price` 并按老算式回填，
把上游价从「对外价 × 分成比例」变成一个独立的数。**要先于发版跑**，
但缺列不会让池子掉线：请求路径上少一列只会让 `provider_price` 读成 0、结算自动回落老口径，
真正会挂的是管理端价目表的保存（写入语句里带了这个列名，报 1054）。
回填之后每一笔结算的金额和跑之前一样（取整差最多 1 微分 / 百万单位），不需要重算历史账。

`20260918_galaxy_desktop_release.sql` 建桌面客户端的发版表（热更新）。它**不必先于发版**：
表不在只是管理端那一页报错，两个客户端与共享池完全不受影响 —— 客户端读的是 OSS 上的清单，
不经过服务端。同一批的 `20260918_manager_desktop_release_menu.sql` 给管理端补那一页的菜单资源，
接口资源在 `server/manager_galaxy_resources.sql` 里（跑 `managerinit` 也一样）。

**2026-09-12 同一批还改了供给侧账本的量纲**（不需要迁移脚本，但要确认一次）：
`zt_galaxy_provider_ledger.amount` 从「计量数（token 数）」改成「微积分」，
`galaxy.payout_rate` 从「多少积分兑一块钱 = 100」改成「多少微积分兑一块钱 = 1,000,000」。
定价表为空的部署不会有历史 settle 行（`record` 在未定价时根本不写账本），发版前核对一次：

```sql
SELECT COUNT(*) FROM zt_galaxy_provider_ledger WHERE biz_line = 'galaxy' AND type = 'settle';
```

不是 0 的话，那些老行记的是 token 数、和新写进去的积分混在一个列里，收益页的合计会偏大；
按 `zt_galaxy_meter_record` 与当时的 `zt_galaxy_price` 重算一次再上线。

**抽检表的隐私取舍：** `zt_galaxy_audit_probe` 会**短期保留**被抽中那次请求的原文
（比例上限 1%/贡献/日），因为不留原文就无法重放比对；但节点的响应只保留**结构签名**
（出现过哪些事件类型 / JSON 键路径），不保留响应内容。比对一跑完就把原文清空，
超过 24 小时没跑的也一并清空 —— 保留它的唯一理由是「还要重放一次」，理由消失就该删。

**争议工单为什么钉 `(unit_id, attempt)` 而不只钉 `unit_id`：** 结算幂等键就是这两个 ——
重跑过的单元每次尝试各自结算过一遍，只钉 `unit_id` 会让一次「支持申诉」把两次的钱
都退掉。追回也不抹原始流水，而是在三本账上各记一笔反向的（`refund` / `clawback` /
`baddebt`，幂等键加 `:dispute` 后缀）：抹掉原始记录就对不出「这笔钱进来过又出去了」，
事后没法审。`detail` 是申诉人自述且限长 512 —— 请求内容平台本来就不留存，
界面上也明确劝阻粘贴。

**业务空间放在 `space` 而不是 `biz_line`：** 共享池按平台维度运行，池内表的
`biz_line` 固定 `galaxy`，所有索引以它打头。任务宇宙这类按空间运行的业务，
其空间记在 `zt_galaxy_unit.space` 与 `zt_galaxy_ledger_session.space` 里
（对应待决策 O-02）。这样既能按空间回查，又不会让池内的索引因为多值 `biz_line` 而失效。

**为什么额度计数器不在 MySQL：** 放置路径上要读写「已用 + 已预留」，这是每请求
两次以上的高频写。它们在 Redis（`quota:{cid}:{unit}:{窗口}`），MySQL 只保存分钟级
快照与流水；两者定期对账，对不上以 `meter_record` 求和为准。

---

## 管理端身份与权限 `zt_manager_*`（缩写 `mgr`）

登录**管理端**（`client/manager` / `manager-api`）的人，与下面 `zt_identity_*` 那套
**业务用户**是两套账号，没有外键、没有数据关联、令牌互不通用。分开的理由：管理端的
处置动作会动真钱（封禁节点、裁决争议、发算力密钥、改业务线授权），合成一套的话，
一个 web 控制台的业务账号就能进到这些地方；而且业务用户那边只有 `role=admin`
一个布尔，配不出「这个人能看池水位但不能封节点」。

| 表 | 作用 |
|---|---|
| `zt_manager_user` | 管理端账号；bcrypt 密码，平台级、不带 `biz_line` |
| `zt_manager_role` | 角色；`writable` 是角色级的读写总开关 |
| `zt_manager_resource` | 受控资源树：菜单 / 页面 / **接口**，接口的身份是 `(method, 路由模板)` |
| `zt_manager_user_role` / `zt_manager_role_resource` | 两组关联 |
| `zt_manager_login_record` | 登录留痕，成功与失败都记 |

**授权是两道门叠加，写操作两道都得过**：先按 `(method, FullPath)` 查资源授权，
再查角色的 `writable`。只有资源授权配不出「这个角色临时只读」（要逐条撤销写资源）；
只有 `writable` 配不出「能改用户、不能封节点」。`resource_url` 存的是 **gin 的路由
模板**（`/api/users/:id`）而不是具体请求路径，否则每个 id 都要在表里占一行。

**接口资源不手写，从真实路由表生成**（`managerinit` 遍历 `engine.Routes()`）。
手写清单和路由迟早分叉，而分叉的后果是「登录用户一律 403」——一个看起来像 bug
的配置故障。进程启动时还会再比对一次，把没登记的路由打进日志。

**未登记的路由默认拒绝**，不是默认放行：忘了登记是配置疏漏，按放行处理等于新接口
天生对所有人开放。唯一的例外是 `super_admin` 角色，它绕过资源过滤——一次配错授权
就能把所有人关在门外，必须留一条改回来的活路。

**令牌在 Redis 里**（`manager:token:*`，滑动过期），另有 `manager:user:{id}:tokens`
反向索引，撤权 / 禁用 / 改密时按人踢掉全部会话。所以 Redis 是 manager-api 的启动
硬依赖。表里刻意没有 `token_version`——那是无状态签名令牌的撤销手段，这里用不上。

新环境两步：[`server/manager.sql`](manager.sql) 建表，
[`server/manager_seed.sql`](manager_seed.sql) 写入角色、资源、超级管理员与授权。
只建表不灌数据的话表是空的，谁也登不进去。

也可以用 `cd server/manager-api && go run ./cmd/managerinit` 一步做完（直接写库）。
两条路等价：seed SQL 由 `cmd/managerseed` 从同一份路由表生成，
接口资源不会和代码分叉。

---

## 控制台身份与授权 `zt_identity_*`（缩写 `identity`）

| 表 | 作用 |
|---|---|
| `zt_identity_user` | 控制台用户、超级管理员角色与登录凭证版本 |
| `zt_identity_user_biz_line` | 用户可见业务线；`is_manager=1` 表示业务线管理员 |
| `zt_identity_user_program` | 用户可见项目；`is_manager=1` 表示项目管理员 |

业务线管理员同时拥有该业务线所有项目的可见与管理权限；项目管理员只管理被授权的项目；
普通成员只能查看被授权项目并新增模块或里程碑。超级管理员由 `zt_identity_user.role=admin`
识别，不受两张授权表限制。新环境执行 [`server/identity.sql`](identity.sql)；存量环境执行
[`migrations/20260817_identity_scope_managers.sql`](migrations/20260817_identity_scope_managers.sql)。

---

## 交付推进 `zt_delivery_*`（缩写 `dlv`）

**这一层不在 6 层业务 DAG 里，是管理面，零下游依赖。**

它回答的是「这个能力建到哪一步了」；`service/task`（`zt_task_*`）回答的是「这条催收指令下发了没有」；
`service/orchestration`（`zt_orch_*`）回答的是「今天发了多少条、设备在不在线」。
三者都叫「任务/看板」，**表前缀是唯一的归属判据**。

数据来源是 `solution/yinni-ai-solution/yinni-分析/assets/tasks.json` 与
`11-任务看板.html`，每一列都能指到原型页面上的一个字段。

| 表 | 作用 | 原型出处 |
|---|---|---|
| `zt_delivery_program` | 交付项目（印尼业务 = 一行） | `meta` |
| `zt_delivery_cloud_sync_file` | 已同步聊天、需求、设计、测试、原型、执行产物与附件的 OSS 对象索引；正文只在私有 OSS；`owner_kind` / `owner_key` / `stage` 记这份文档属于哪条需求或任务的哪个阶段，未识别出归属时留空 | 原型没有 |
| `zt_delivery_stage` | 推进阶段（现状 / 第一步 … 终局） | `stages[]` |
| `zt_delivery_module` | 能力模块 + 权重（数据回传 30% …） | `modules[]` |
| `zt_delivery_time_plan` | 时间计划：项目的交付时间窗口，对应一条从基准分支切出的发布分支（默认 `release/{截止日期}`） | 原型没有 |
| `zt_delivery_requirement` | 需求：项目与任务之间的一层；含可选的计划开始/结束时间；专业模式可在任务拆解确认后生成关联 HTML 原型；需求测试用例与总体测试报告独立保存 | 原型没有 |
| `zt_delivery_requirement_event` | 需求自身的变更流水；与任务流水按时间聚合为需求时间线 | 原型没有 |
| `zt_delivery_requirement_planning_session` | 需求拆解会话目录（聊天列表）；对话正文在执行器自己的会话缓存里，这里只存 `thread_id` | 原型没有 |
| `zt_delivery_requirement_planning_batch` | 需求拆解批次：一次「拆解并写入任务」算一批，任务进度按批次成行展示 | 原型没有 |
| `zt_delivery_item` | 推进任务，看板主体；`requirement_key` 指向所属需求，`planning_batch_key` 指向来源拆解批次（非必填）；测试用例可与研发并行生成，`prototype_task` 仅保留历史兼容；`last_run_*` / `total_run_duration_ms` / `run_count` 记执行耗时 | `tasks[]` |
| `zt_delivery_item_execution_session` | 任务与外部执行器会话的通用绑定及独立状态；`run_started_at` / `run_finished_at` 是一轮运行的边界，耗时按这两个时刻结算后累加到任务上 | 原型没有，供自动执行引擎使用 |
| `zt_delivery_item_dependency` | 任务依赖有向边（前置 → 后置），`source_side` / `target_side` 持久化两端连接边框 | 任务面板依赖连线 |
| `zt_delivery_item_event` | 流水：状态流转 / 进度改动 / 进展评论；事件中冻结 `requirement_key`，供需求时间线回溯 | 原型没有，看板的价值主要在这 |
| `zt_delivery_snapshot` | 每日进度快照，趋势与三维图历史 | 原型没有 |
| `zt_delivery_command` | 用户提交的远程命令、租约、取消请求和最终结果；数据库权威 | 移动端远程执行 |
| `zt_delivery_command_event` | 命令审计与 SSE 游标事件流 | 移动端远程执行 |
| `zt_delivery_command_worker` | 按用户和业务线登记的插件及最近心跳 | 移动端远程执行 |
| `zt_delivery_command_worker_workspace` | Worker 已配置的项目工作目录映射，不保存绝对路径 | 移动端远程执行 |

### 隔离维度

`program_id` 是 `zt_delivery_program.id` 的数值主键；所有项目范围接口、交付子表和项目授权均据此关联并解析项目归属的 `biz_line`。`program_code` 仅用于展示、新建项目和导入幂等，不能用于项目范围关联。
第二个甲方 / 第二个国家进来是**加一行 program**，不是拷一套表。`biz_line` 仍保留在每张交付表上，
用于按业务线浏览、统计和与全局数据模型保持一致。

### 云端同步 OSS 配置

项目管理员启用“云端同步”后，本机桥接把选中的文件发送给服务端；服务端使用以下
`web-api/configs/application.properties` 配置写入**私有**阿里云 OSS，数据库仅保存对象键和校验元数据：

```properties
oss.enabled=true
oss.dirPrefix=universe/delivery
# 可填写完整 URL；省略协议时服务端默认使用 HTTPS。
oss.endpoint=oss-cn-hangzhou.aliyuncs.com
oss.bucketName=your-private-bucket
oss.accessKeyId=your-access-key-id
oss.accessKeySecret=your-access-key-secret
# app-api 的 OSS 短时签名下载地址有效期，单位为秒。
oss.expireTime=600
# 当前服务端同步直接上传并受控读取，预留给未来异步上传回调 / 临时令牌场景。
oss.callbackUrl=
oss.tokenExpireTime=300
```

存量库须执行 [`migrations/20260823_delivery_program_cloud_sync.sql`](migrations/20260823_delivery_program_cloud_sync.sql)。
旧版已写入数据库正文的记录不会被迁移脚本删除；在 OSS 配置完成后点击“立即同步”即可安全地重新上传，
后续数据库记录只保留对应的 `object_key`。

索引一览：

```
PRIMARY KEY      (id)                            uk_dlv_program_code      (program_code)
uk_dlv_stage     (biz_line, program_id, stage_key)      idx_dlv_stage_seq    (biz_line, program_id, seq)
uk_dlv_module    (biz_line, program_id, module_key)     idx_dlv_module_seq   (biz_line, program_id, seq)
uk_dlv_time_plan (biz_line, program_id, plan_key)       idx_dlv_time_plan_end (biz_line, program_id, end_at)
idx_dlv_requirement_time_plan (biz_line, program_id, time_plan_key)
uk_dlv_item      (biz_line, program_id, item_key)       idx_dlv_item_board   (biz_line, program_id, stage_key, status)
                                                        idx_dlv_item_module  (biz_line, program_id, module_key, status)
uk_dlv_planning_batch   (biz_line, program_id, batch_key)
idx_dlv_planning_batch_req (biz_line, program_id, requirement_key, seq)
idx_dlv_item_planning_batch (biz_line, program_id, planning_batch_key)
uk_dlv_planning_session (biz_line, program_id, requirement_key, executor_type, thread_id)
idx_dlv_planning_program (program_id, requirement_key)
uk_dlv_item_exec (biz_line, program_id, item_key, executor_type)
uk_dlv_exec_external (biz_line, executor_type, external_session_id)
idx_dlv_exec_status (biz_line, program_id, status)
uk_dlv_item_dep  (biz_line, program_id, predecessor_item_key, successor_item_key)
idx_dlv_item_dep_pre (biz_line, program_id, predecessor_item_key)
idx_dlv_item_dep_suc (biz_line, program_id, successor_item_key)
idx_dlv_event_item (biz_line, program_id, item_key)     idx_dlv_event_time   (biz_line, program_id, created_time)
uk_dlv_snapshot  (biz_line, program_id, stat_date, module_key)
```

### 三条本层特有的约束

**① 阶段用 `stage_key` 不用数组下标。**
原型里任务的阶段是 `stage: 0..4`，即 `stages[]` 的下标 —— 中途插一个阶段，所有任务的归属整体错位。
落库统一成 `stage_key`（导入时由 `idx` 生成 `s0..s4`），排序另用 `seq`。

**② 任务更新必须带 `version`（乐观锁）。**
原型的保存是整份 `tasks.json` 覆盖写（`save-server.js` 的 `POST /api/save`），
多人同时开着看板必然互相吃掉改动。落库后改成**单条 PATCH + 版本比对**：
`UPDATE ... WHERE item_key = ? AND version = ?`，0 行即冲突，返回
`contract.ErrVersionConflict` 让前端刷新，**不做静默合并**。

**③ 任务依赖是无环有向图。**

- `predecessor_item_key -> successor_item_key` 表示后者等待前者
- 一对多表示并行分叉，多对一表示汇合
- 自依赖、跨项目依赖和任何环形依赖都由 service 拒绝
- 删除任务时在同一事务里清理所有入边和出边

**④ 进度与成熟度的口径在 service 层定死，前端不许自己再算。**

- `status = done` → 进度按 100 计（库里存的是多少都一样）
- `status = dropped` → 不计入任何统计（分子分母都不进）
- 模块进度 = 该模块非 dropped 任务的平均进度
- **整体成熟度 = Σ(模块 weight × 模块进度) / Σweight**，没有任务的模块不参与加权
  （它的 0% 是「没登记」不是「没做」，算进去会把成熟度压虚）

原型页面把 `weight` 显示出来了却没参与计算，`overview.plainProgress` 保留那个未加权的数用于对照，
**对外汇报以 `maturityScore` 为准**。

**⑤ 执行会话与任务状态相互独立。**

- 一个任务可绑定多个 `executor_type`，但每种类型只保留一个当前会话
- 执行器宿主先创建会话，再用 `external_session_id` 绑定；服务端不生成平台会话
- 会话状态为 `pending/running/completed/blocked/closed`，不替代任务的 `todo/doing/done/blocked/dropped`
- 会话更新必须带独立的 `version`，扩展信息只能放在不超过 8KB 的 JSON 对象 `metadata`

**⑥ 拆解批次 ≠ 执行批次。**

- `zt_delivery_requirement_planning_batch`（拆解批次）回答「这批任务是哪一轮拆解写进来的」，写入时定型，之后不变
- `zt_delivery_execution_batch`（执行批次）回答「这一次批量/串行跑了哪些任务、结果如何」，一批任务可以被执行无数次
- 任务对拆解批次是弱引用：`planning_batch_key` 非必填，批次被删也不影响任务

**⑦ 用户命令中心由数据库裁决领取，Redis 不保存命令正文。**

- `zt_delivery_command` 是用户提交、租约、取消请求、重试次数、最终结果的唯一权威记录；Redis 只保存不含参数的短时 `command_id` 唤醒提示，丢失提示时 Worker 仍可回退查询数据库。
- 同一 `(biz_line, user_id, idempotency_key)` 只对应一条命令。并发重试返回同一记录，不能产生第二次本地执行。
- 领取以 `UPDATE ... WHERE state = 'pending' AND cancel_requested = false` 原子完成；只有更新成功的 Worker 持有随机 `lease_token`，续租、活动和最终回传都必须同时匹配该 token 与 `worker_id`。
- `pending`、`leased` 或 `running` 都以两分钟为恢复窗口。未领取命令会重新发送最多三次领取通知后进入 `timed_out`；失联租约低于三次领取尝试时回到 `pending`，否则进入 `timed_out`。每次转变都会写入 `zt_delivery_command_event`，重新调度会再次发送 Redis 唤醒提示。
- Worker 仅登记已配置本机工作目录的 `(biz_line, program_id)` 映射。绝不上传、保存或下发本机绝对路径；领取查询只会返回同一用户、同一业务线、同一项目且能力匹配的命令。
- 命令行与事件行是可再生的执行痕迹，不是账本：只读快照类命令（会话快照、Git 只读、用量）终态一小时后清理，其余命令保留一个月，事件行随命令一并删除。手机端会话页每几秒就落一条快照命令，不清理的话这两张表会无上限地涨。

### 建表

两条路，结构完全一致，走哪条都行。

**① 直接跑 SQL：** [`server/delivery.sql`](delivery.sql)，交付域表的 DDL 都在里面。

```bash
mysql -h <host> -P <port> -u <user> -p <database> < server/delivery.sql
```

这份 DDL 刻意不写 `COLUMN COMMENT`、也不给字段加模型里没有的 `DEFAULT`，整型统一
`bigint` —— GORM 的 AutoMigrate 会把「库里有、模型里没有」判成差异并 `ALTER` 掉，
对齐之后先跑 SQL 再跑下面的导入命令，不会互相打架。字段说明写成 `--` 行注释。

**② 让导入命令建：** 项目暂时没有独立迁移机制，建表 + 导入原型数据由一个命令完成，重复执行幂等：

```bash
cd server/web-api
go run service/delivery/cmd/dlvimport -program indonesia -bizline whatsapp \
  -file ../../../solution/yinni-ai-solution/yinni-分析/assets/tasks.json
```

已有交付表升级到 `program_id` 全局唯一时，先执行
[`migrations/20260813_delivery_program_global_id.sql`](migrations/20260813_delivery_program_global_id.sql)。脚本会先列出
重复项目键；结果非空时必须先合并或重命名，确认无重复后再执行其中的 `ALTER TABLE`。

已有需求表升级到支持拆解上下文时，执行
[`migrations/20260814_delivery_requirement_context.sql`](migrations/20260814_delivery_requirement_context.sql)。
该脚本会补齐 `stage_key`、`module_key` 和 `kind`，并可安全重复执行。

已有需求与任务表升级到支持 HTML 原型时，依次执行
[`migrations/20260815_delivery_requirement_prototype.sql`](migrations/20260815_delivery_requirement_prototype.sql)
和 [`migrations/20260815_delivery_requirement_html_prototype.sql`](migrations/20260815_delivery_requirement_html_prototype.sql)。
两份脚本均可安全重复执行；`prototype_task` 是旧数据兼容字段，新流程不会再创建这种任务。

已有需求表升级到支持需求级测试用例、总体测试报告及其聊天会话目录时，执行
[`migrations/20260816_delivery_requirement_testing.sql`](migrations/20260816_delivery_requirement_testing.sql)。
该脚本可安全重复执行；它会补齐测试字段、索引和 `zt_delivery_requirement_testing_session` 会话目录表。

已有库升级到时间计划时，执行
[`migrations/20260831_delivery_time_plan.sql`](migrations/20260831_delivery_time_plan.sql)。
该脚本可安全重复执行；它建 `zt_delivery_time_plan` 并给需求表补可为空的 `time_plan_key`。
**存量需求不回填计划** —— 猜出来的排期比空着更难纠正。

时间计划这一层的三条约束：

- **一条分支只能挂一个计划。** 同一个项目里两个计划共用一条分支时，「这条分支代表哪一批需求」
  就没有答案了，两边的合并记录也会互相覆盖，所以 service 层直接拒绝。
- **服务端不执行任何 Git 命令。** 建分支、回合基线、合并需求分支、回推基线全部发生在本机桥接的
  项目工作目录里（`/v1/codex/git/merge-preview` 与 `/v1/codex/git/merge`）；服务端只在浏览器
  回报成功后记录 `base_synced_at` / `requirement_merged_at` / `base_published_at` 三个时间点，
  不复核合并结果对不对。
- **需求对计划是弱引用。** 删计划只把需求的 `time_plan_key` 清空，已经建出来的分支一概不动 ——
  删排期不是删代码。

已有交付表升级到支持需求拆解批次时，执行
[`migrations/20260827_delivery_planning_batch.sql`](migrations/20260827_delivery_planning_batch.sql)。
该脚本可安全重复执行；它会建 `zt_delivery_requirement_planning_batch` 并给任务表补
可为空的 `planning_batch_key`。**存量任务不回填批次** —— 猜出来的归批比空着更难纠正，
面板会把它们显示在「未归批次」一行里。

已有需求表升级到支持计划时间段时，执行
[`migrations/20260817_delivery_requirement_planned_period.sql`](migrations/20260817_delivery_requirement_planned_period.sql)。
该脚本可安全重复执行；它会补齐可为空的 `planned_start_at`、`planned_end_at` 两列。

已有需求表升级到支持「是否拆解任务」开关时，执行
[`migrations/20260818_delivery_requirement_split_tasks.sql`](migrations/20260818_delivery_requirement_split_tasks.sql)。
该脚本可安全重复执行；它补齐的 `split_tasks` 默认为 `TRUE`，存量需求维持原有的多任务拆解行为。

已有需求表升级到支持「每个任务生成需求大纲」开关时，执行
[`migrations/20260818_delivery_requirement_task_outline.sql`](migrations/20260818_delivery_requirement_task_outline.sql)。
该脚本可安全重复执行；它补齐的 `generate_task_outline` 默认为 `FALSE`，存量需求只保留需求级大纲。

已有项目表升级到项目级 Git 能力时，执行
[`migrations/20260820_delivery_program_git_enabled.sql`](migrations/20260820_delivery_program_git_enabled.sql)。
该脚本可安全重复执行；Git 默认关闭，启用时项目设置必须提供默认基准分支，仓库地址仅作可选记录。

已有项目表升级到 Git 聊天记录归档开关时，执行
[`migrations/20260824_delivery_program_git_chat_sync.sql`](migrations/20260824_delivery_program_git_chat_sync.sql)。
该脚本可安全重复执行；开关默认关闭。开启后，本机桥接会在每段需求或任务会话结束时把可见聊天正文写入项目工作目录的 `chat/`，供 Git 一并提交。

已有项目表升级到项目级云端同步时，执行
[`migrations/20260823_delivery_program_cloud_sync.sql`](migrations/20260823_delivery_program_cloud_sync.sql)。
该脚本可安全重复执行；云端同步默认关闭，只有项目管理员选中的聊天记录、需求文档、设计文档、测试资料、原型、执行产物和附件会由本机桥接上传。云端文件按项目相对路径覆盖更新，不保存成员机器的绝对路径。
服务端上传到私有 OSS 后，数据库仅保存对象键、大小和 SHA-256 校验值。

已有云端文件索引表升级到按需求 / 任务归属分组时，执行
[`migrations/20260909_delivery_cloud_document_owner.sql`](migrations/20260909_delivery_cloud_document_owner.sql)。
该脚本可安全重复执行；补齐 `owner_kind` / `owner_key` / `stage` 三列和 `idx_dlv_cloud_file_owner`。
存量记录归属为空，按项目级未归类展示，重新执行一次云端同步即可回填。

已有需求表升级到支持需求详情里 @ 引用历史需求时，执行
[`migrations/20260818_delivery_requirement_references.sql`](migrations/20260818_delivery_requirement_references.sql)。
该脚本可安全重复执行；它补齐的 `reference_requirement_keys` 默认为空串，存量需求没有引用。

存量库升级到任务面板的批量/串行执行批次时，执行
[`migrations/20260825_delivery_execution_batch.sql`](migrations/20260825_delivery_execution_batch.sql)。
该脚本可安全重复执行；它建 `zt_delivery_execution_batch` 和 `zt_delivery_execution_batch_item` 两张表，
分别记录一次批次的启动事实和批次内每条任务的进度快照。缺这两张表时，任务面板批量执行会直接报
`Table 'xxx.zt_delivery_execution_batch' doesn't exist`。

已有 `zt_delivery_execution_batch` 升级到心跳判死时，执行
[`migrations/20260905_delivery_execution_batch_heartbeat.sql`](migrations/20260905_delivery_execution_batch_heartbeat.sql)。
它补上 `heartbeat_at`：执行端每隔 30 秒续一次心跳，超过 3 分钟没续上就按执行端已经不在了处理，
批次被自动收尾并放行里面的任务。缺这个字段时，一次断网或执行进程退出就会让批次永远停在 `running`，
批次里的任务再也启动不了（报「任务正在其他执行批次中」）。

已有需求表升级到支持需求详情里 @ 引用既有任务时，执行
[`migrations/20260818_delivery_requirement_task_references.sql`](migrations/20260818_delivery_requirement_task_references.sql)。
该脚本可安全重复执行；它补齐的 `reference_item_keys` 默认为空串，存量需求没有任务关联。

已有库启用移动端用户命令中心前，执行
[`migrations/20260903_delivery_command_center.sql`](migrations/20260903_delivery_command_center.sql)。
该脚本可安全重复执行；它建立权威命令、审计事件、插件注册和工作目录映射四张表。命令输入与结果不写 Redis，本机路径和 Worker 凭证也不得写入任意一张表。

命令表的巡检索引改以 `state` 打头后，执行
[`migrations/20260910_delivery_command_sweep_index.sql`](migrations/20260910_delivery_command_sweep_index.sql)。
租约回收与留存期清理都是跨业务线、跨用户的定时巡检，以 `biz_line` 打头的索引一条也用不上；
移动端会话页每几秒落一条快照命令，表长得快，而领取命令时会顺带跑一次租约回收，扫描成本会直接压在领取延迟上。
该脚本可安全重复执行。

省掉 `-file` 就只建表。**DDL 不在服务启动时跑** —— 线上建表不该是进程启动的副作用。
