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
