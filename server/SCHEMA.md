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
| `zt_delivery_stage` | 推进阶段（现状 / 第一步 … 终局） | `stages[]` |
| `zt_delivery_module` | 能力模块 + 权重（数据回传 30% …） | `modules[]` |
| `zt_delivery_requirement` | 需求：项目与任务之间的一层；含可选的计划开始/结束时间；专业模式可在任务拆解确认后生成关联 HTML 原型；需求测试用例与总体测试报告独立保存 | 原型没有 |
| `zt_delivery_requirement_event` | 需求自身的变更流水；与任务流水按时间聚合为需求时间线 | 原型没有 |
| `zt_delivery_requirement_planning_session` | 需求拆解会话目录（聊天列表）；对话正文在执行器自己的会话缓存里，这里只存 `thread_id` | 原型没有 |
| `zt_delivery_item` | 推进任务，看板主体；`requirement_key` 指向所属需求；测试用例可与研发并行生成，`prototype_task` 仅保留历史兼容 | `tasks[]` |
| `zt_delivery_item_execution_session` | 任务与外部执行器会话的通用绑定及独立状态 | 原型没有，供自动执行引擎使用 |
| `zt_delivery_item_dependency` | 任务依赖有向边（前置 → 后置），`source_side` / `target_side` 持久化两端连接边框 | 任务面板依赖连线 |
| `zt_delivery_item_event` | 流水：状态流转 / 进度改动 / 进展评论；事件中冻结 `requirement_key`，供需求时间线回溯 | 原型没有，看板的价值主要在这 |
| `zt_delivery_snapshot` | 每日进度快照，趋势与三维图历史 | 原型没有 |

### 隔离维度

`program_id` 是 `zt_delivery_program.id` 的数值主键；所有项目范围接口、交付子表和项目授权均据此关联并解析项目归属的 `biz_line`。`program_code` 仅用于展示、新建项目和导入幂等，不能用于项目范围关联。
第二个甲方 / 第二个国家进来是**加一行 program**，不是拷一套表。`biz_line` 仍保留在每张交付表上，
用于按业务线浏览、统计和与全局数据模型保持一致。

索引一览：

```
PRIMARY KEY      (id)                            uk_dlv_program_code      (program_code)
uk_dlv_stage     (biz_line, program_id, stage_key)      idx_dlv_stage_seq    (biz_line, program_id, seq)
uk_dlv_module    (biz_line, program_id, module_key)     idx_dlv_module_seq   (biz_line, program_id, seq)
uk_dlv_item      (biz_line, program_id, item_key)       idx_dlv_item_board   (biz_line, program_id, stage_key, status)
                                                        idx_dlv_item_module  (biz_line, program_id, module_key, status)
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

### 建表

两条路，结构完全一致，走哪条都行。

**① 直接跑 SQL：** [`server/delivery.sql`](delivery.sql)，八张表的 DDL 都在里面。

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

已有需求表升级到支持需求详情里 @ 引用历史需求时，执行
[`migrations/20260818_delivery_requirement_references.sql`](migrations/20260818_delivery_requirement_references.sql)。
该脚本可安全重复执行；它补齐的 `reference_requirement_keys` 默认为空串，存量需求没有引用。

已有需求表升级到支持需求详情里 @ 引用既有任务时，执行
[`migrations/20260818_delivery_requirement_task_references.sql`](migrations/20260818_delivery_requirement_task_references.sql)。
该脚本可安全重复执行；它补齐的 `reference_item_keys` 默认为空串，存量需求没有任务关联。

省掉 `-file` 就只建表。**DDL 不在服务启动时跑** —— 线上建表不该是进程启动的副作用。
