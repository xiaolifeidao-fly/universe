-- =========================================================================
-- 交付推进（任务面板）建表语句 · zt_delivery_*
--
-- 与 service/delivery/internal/repository/model.go 一一对应，也与
-- `go run service/delivery/cmd/dlvimport` 里 AutoMigrate 生成的结构一致 ——
-- 两条路走哪条都行，先跑这份 SQL 再跑 dlvimport 导数据也不会被 ALTER。
--
-- 因此这里刻意不写 COLUMN COMMENT、也不给字段加多余的 DEFAULT：
-- GORM 的 AutoMigrate 会把「库里有注释 / 有默认值，但模型里没有」判定为差异并
-- ALTER 掉。字段说明放在 `--` 行注释里，效果一样，不会被改回去。
-- 整型统一 bigint 也是同一个原因：Go 的 int 在 64 位下映射过来就是 bigint。
--
-- 库：application.properties 里 sqlconn 指向的那个（默认 zhangtianping）
-- 依赖：MySQL 5.7+
-- 已有使用字符串 program_id 的 zt_delivery_* 表请先执行
-- server/migrations/20260814_delivery_program_primary_key.sql，不能用本文件替代存量表迁移。
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. 交付项目：一个甲方 / 一个国家的落地推进算一个项目
--    id 是所有关联使用的数值主键；program_code 仅用于展示和导入幂等
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `zt_delivery_program` (
  `id`           bigint       NOT NULL AUTO_INCREMENT,
  `biz_line`     varchar(32)  NOT NULL,                        -- 业务线 whatsapp/tiktok
  `program_code`  varchar(64)  NOT NULL,                        -- 项目业务编码 如 indonesia
  `name`         varchar(128) NOT NULL,                        -- 项目名称
  `summary`      varchar(512) NOT NULL,                        -- 一句话说明
  `status`       varchar(16)  NOT NULL DEFAULT 'active',       -- active 进行中 / archived 已归档
	`git_enabled` boolean NOT NULL DEFAULT FALSE,                 -- 是否启用项目 Git 与需求分支能力
	`git_repository_url` varchar(512) NOT NULL DEFAULT '',        -- 可选记录的 Git 仓库地址，不校验本机远端
	`git_remote_name` varchar(64) NOT NULL DEFAULT 'origin',      -- 远端名
	`git_base_branch` varchar(255) NOT NULL DEFAULT '',           -- 启用后新需求默认基准分支
	`git_chat_sync_enabled` boolean NOT NULL DEFAULT FALSE,       -- 是否将结束的聊天记录归档到工作目录 chat/
	`cloud_sync_enabled` boolean NOT NULL DEFAULT FALSE,          -- 是否启用选定内容的云端同步
	`cloud_sync_scopes` varchar(128) NOT NULL DEFAULT '',         -- chat,requirement,design 的规范化逗号列表
  `created_by`   varchar(64)  NOT NULL,
  `updated_by`   varchar(64)  NOT NULL,
  `created_time` timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_time` timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dlv_program_code` (`biz_line`, `program_code`),
  KEY `idx_dlv_program_biz_line` (`biz_line`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------------------
-- 1.5 项目云端文件：由本机桥接显式上传的聊天、需求与设计文档快照
--     正文只存私有 OSS；数据库只存项目相对路径、OSS 对象键与校验元数据。
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `zt_delivery_cloud_sync_file` (
  `id`            bigint        NOT NULL AUTO_INCREMENT,
  `biz_line`      varchar(32)   NOT NULL,
  `program_id`    bigint        NOT NULL,
  `category`      varchar(16)   NOT NULL,                       -- chat / requirement / design
  `relative_path` varchar(1024) NOT NULL,                       -- 项目工作目录内相对路径
  `relative_path_hash` char(64) NOT NULL,                       -- relative_path 的 SHA-256，唯一键里的定长替身
  `content_type`  varchar(128)  NOT NULL,
  `object_key`    varchar(1536) NOT NULL,                       -- 私有 OSS 对象键
  `size`          bigint        NOT NULL,
  `sha256`        char(64)      NOT NULL,
  `updated_by`    varchar(64)   NOT NULL,
  `updated_time`  timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dlv_cloud_file` (`biz_line`, `program_id`, `category`, `relative_path_hash`),
  KEY `idx_dlv_cloud_file_updated` (`biz_line`, `program_id`, `category`, `updated_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------------------
-- 2. 推进阶段：现状 / 第一步 / 第二步 / 第三步 / 终局
--    标识用 stage_key、排序用 seq —— 原型里阶段是数组下标(tasks[].stage=0..4)，
--    中途插一个阶段所有任务的归属会整体错位，所以不用下标做键
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `zt_delivery_stage` (
  `id`             bigint       NOT NULL AUTO_INCREMENT,
  `biz_line`       varchar(32)  NOT NULL,
  `program_id`     bigint         NOT NULL,                      -- 所属项目
  `stage_key`      varchar(64)  NOT NULL,                      -- 阶段业务键 如 s1
  `seq`            bigint       NOT NULL,                      -- 展示顺序，看板列从左到右
  `tag`            varchar(32)  NOT NULL,                      -- 阶段标签 现状/第一步/终局
  `time_window`    varchar(64)  NOT NULL,                      -- 时间窗 如 0 – 4 周
  `maturity_level` varchar(16)  NOT NULL,                      -- 自动化成熟度 如 L2.0
  `title`          varchar(255) NOT NULL,                      -- 阶段目标
  `created_time`   timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_time`   timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dlv_stage` (`biz_line`, `program_id`, `stage_key`),
  KEY `idx_dlv_stage_seq` (`biz_line`, `program_id`, `seq`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------------------
-- 3. 能力模块：数据回传 30% / 案件前筛 18% / 触达·WhatsApp 16% ...
--    weight 是加权成熟度的分母来源：Σ(weight × 模块进度)/Σweight
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `zt_delivery_module` (
  `id`           bigint       NOT NULL AUTO_INCREMENT,
  `biz_line`     varchar(32)  NOT NULL,
  `program_id`     bigint         NOT NULL,                        -- 所属项目
  `module_key`   varchar(64)  NOT NULL,                        -- 模块业务键 如 data/screen/wa
  `seq`          bigint       NOT NULL,                        -- 展示顺序
  `name`         varchar(128) NOT NULL,                        -- 模块名称
  `weight`       bigint       NOT NULL,                        -- 权重百分比，用于加权成熟度
  `kind`         varchar(16)  NOT NULL,                        -- link 链路 / tool 工具 / center 中枢
  `created_time` timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_time` timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dlv_module` (`biz_line`, `program_id`, `module_key`),
  KEY `idx_dlv_module_seq` (`biz_line`, `program_id`, `seq`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------------------
-- 3.5 需求：项目与任务之间的那一层
--     一次「新增需求」产出一批任务，这批任务共享同一个 requirement_key；
--     拆解会话也挂在需求上，追问时要把已经建出来的任务列表一并带给执行器。
--     owner_ids / assistant_ids 存成 ,1,2, 形式，「和我有关」用 LIKE '%,3,%' 命中。
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `zt_delivery_requirement` (
  `id`              bigint       NOT NULL AUTO_INCREMENT,
  `biz_line`        varchar(32)  NOT NULL,
  `program_id`     bigint         NOT NULL,                     -- 所属项目
  `requirement_key` varchar(64)  NOT NULL,                     -- 需求业务键 如 req-1760000000000
  `name`            varchar(255) NOT NULL,                     -- 需求名称；可为空串，拆解会话结束后由 AI 按聊天内容补上
  `detail`          mediumtext   NOT NULL,                     -- 需求详细信息
  `reference_requirement_keys` varchar(1024) NOT NULL DEFAULT '', -- 详情里 @ 引用的历史需求键，存成 ,req-a,req-b,
  `reference_item_keys` varchar(2048) NOT NULL DEFAULT '',       -- 详情里 @ 引用的既有任务键，存成 ,task-a,task-b,
  `status`          varchar(16)  NOT NULL DEFAULT 'open',      -- open 进行中 / done 已完成 / dropped 不做
  `mode`            varchar(16)  NOT NULL DEFAULT 'professional', -- simple 简易（直接进动作执行）/ professional 专业
  `start_phase`     varchar(16)  NOT NULL DEFAULT 'requirement',  -- 拆出的任务从哪个阶段起步
  `split_tasks`     boolean      NOT NULL DEFAULT TRUE,           -- 是否把需求拆成多条任务；FALSE 表示只落一条任务
  `generate_task_outline` boolean NOT NULL DEFAULT FALSE,          -- 拆解时是否为每条任务单独写一份需求大纲；默认只留需求级大纲
  `generate_prototype` boolean    NOT NULL DEFAULT FALSE,           -- 专业模式拆解确认后可生成关联 HTML 原型
  `git_enabled` boolean NULL DEFAULT NULL,                            -- 是否为该需求关联独立 Git 分支；NULL 表示未单独设置，由项目 Git 配置决定前端默认值
  `git_base_branch` varchar(255) NOT NULL DEFAULT '',                -- 创建需求分支时使用的基准分支
  `git_branch` varchar(255) NOT NULL DEFAULT '',                     -- 关联的需求分支
  `git_branch_created_at` timestamp NULL,                            -- 最近一次确认创建并关联需求分支的时间
  `prototype_html_path` varchar(512) NOT NULL DEFAULT '',           -- 原型目录在项目工作区 doc/ 下的相对路径，内含按模块拆分的 HTML
  `prototype_generated_at` timestamp NULL,                           -- 最近一次生成 HTML 原型的时间
  `testing_status`  varchar(16)  NOT NULL DEFAULT 'todo',            -- 需求总体测试：todo/doing/passed/failed/blocked
  `testing_report`  mediumtext   NOT NULL,                            -- 需求总体测试报告
  `testing_report_path` varchar(512) NOT NULL DEFAULT '',             -- doc/test/<requirement_key>/测试报告.md
  `testing_reported_at` timestamp NULL,                               -- 最近一次生成测试报告的时间
  `testing_cases_status` varchar(16) NOT NULL DEFAULT 'todo',         -- 需求测试用例：todo/doing/ready/blocked
  `testing_cases` mediumtext NOT NULL,                                -- 需求总体测试用例正文
  `testing_cases_path` varchar(512) NOT NULL DEFAULT '',              -- doc/test/<requirement_key>/测试用例.md
  `stage_key`       varchar(64)  NOT NULL DEFAULT '',            -- 拆解任务默认所属交付阶段
  `module_key`      varchar(64)  NOT NULL DEFAULT '',            -- 拆解任务默认所属模块
  `kind`            varchar(16)  NOT NULL DEFAULT '',            -- 拆解任务默认类型 gap/capability/asset
  `owner_ids`       varchar(512) NOT NULL,                     -- 主负责人标识，形如 ,1,2,
  `owner_names`     varchar(512) NOT NULL,                     -- 主负责人显示名，逗号分隔
  `assistant_ids`   varchar(512) NOT NULL,                     -- 辅助人标识
  `assistant_names` varchar(512) NOT NULL,                     -- 辅助人显示名
  `version`         bigint       NOT NULL DEFAULT 1,           -- 乐观锁版本
  `created_by`      varchar(64)  NOT NULL,
  `created_by_name` varchar(64)  NOT NULL,
  `updated_by`      varchar(64)  NOT NULL,
  `created_time`    timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_time`    timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dlv_requirement` (`biz_line`, `program_id`, `requirement_key`),
  KEY `idx_dlv_requirement_program` (`biz_line`, `program_id`),
  KEY `idx_dlv_requirement_testing` (`biz_line`, `program_id`, `testing_status`),
  KEY `idx_dlv_requirement_testing_cases` (`biz_line`, `program_id`, `testing_cases_status`),
  KEY `idx_dlv_requirement_creator` (`created_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------------------
-- 3.1 需求拆解会话目录：一条需求下开过哪几轮拆解对话
--     只存目录，不存对话正文 —— 正文在 Codex / Claude 自己的会话缓存里，
--     桥接按 thread_id 读回。桥接是随时会重启的本地进程，目录不能只留在它内存里。
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `zt_delivery_requirement_planning_session` (
  `id`              bigint       NOT NULL AUTO_INCREMENT,
  `biz_line`        varchar(32)  NOT NULL,
  `program_id`      bigint       NOT NULL,
  `requirement_key` varchar(64)  NOT NULL,
  `executor_type`   varchar(32)  NOT NULL,
  `thread_id`       varchar(255) NOT NULL,
  `title`           varchar(255) NOT NULL DEFAULT '',
  `status`          varchar(16)  NOT NULL DEFAULT 'running',
  `metadata_json`   mediumtext   NOT NULL,
  `version`         bigint       NOT NULL DEFAULT 1,
  `created_by`      varchar(64)  NOT NULL DEFAULT '',
  `updated_by`      varchar(64)  NOT NULL DEFAULT '',
  `created_time`    timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_time`    timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dlv_planning_session` (`biz_line`, `program_id`, `requirement_key`, `executor_type`, `thread_id`),
  KEY `idx_dlv_planning_program` (`program_id`, `requirement_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------------------
-- 3.15 需求拆解批次：一次「拆解并写入任务」算一批。
--      任务侧只冻结 planning_batch_key，删批次不影响任务；批次是任务进度按行
--      展示与「整批再做一次」的唯一依据，靠创建时间聚类猜不出来。
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `zt_delivery_requirement_planning_batch` (
  `id`              bigint       NOT NULL AUTO_INCREMENT,
  `biz_line`        varchar(32)  NOT NULL,
  `program_id`      bigint       NOT NULL,
  `batch_key`       varchar(64)  NOT NULL,                      -- 批次业务键 如 plan-xxxx
  `requirement_key` varchar(64)  NOT NULL,                      -- 所属需求
  `seq`             bigint       NOT NULL DEFAULT 1,            -- 需求内第几次拆解，从 1 开始
  `title`           varchar(255) NOT NULL DEFAULT '',           -- 默认「第 N 次拆解」
  `source`          varchar(16)  NOT NULL DEFAULT 'planner',    -- planner 拆解会话 / manual 人工 / import 导入
  `executor_type`   varchar(32)  NOT NULL DEFAULT '',           -- 产出该批次的执行器，可空
  `thread_id`       varchar(255) NOT NULL DEFAULT '',           -- 产出该批次的拆解会话，可空
  `summary`         varchar(1024) NOT NULL DEFAULT '',
  `item_count`      bigint       NOT NULL DEFAULT 0,            -- 写入时登记的任务数，实际归属以任务表为准
  `created_by`      varchar(64)  NOT NULL DEFAULT '',
  `created_by_name` varchar(64)  NOT NULL DEFAULT '',
  `updated_by`      varchar(64)  NOT NULL DEFAULT '',
  `created_time`    timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_time`    timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dlv_planning_batch` (`biz_line`, `program_id`, `batch_key`),
  KEY `idx_dlv_planning_batch_req` (`biz_line`, `program_id`, `requirement_key`, `seq`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------------------
-- 3.2 需求总体测试会话目录：正文仍在执行器会话缓存，平台保存可恢复的会话索引。
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `zt_delivery_requirement_testing_session` (
  `id`              bigint       NOT NULL AUTO_INCREMENT,
  `biz_line`        varchar(32)  NOT NULL,
  `program_id`      bigint       NOT NULL,
  `requirement_key` varchar(64)  NOT NULL,
  `executor_type`   varchar(32)  NOT NULL,
  `thread_id`       varchar(255) NOT NULL,
  `title`           varchar(255) NOT NULL DEFAULT '',
  `status`          varchar(16)  NOT NULL DEFAULT 'running',
  `metadata_json`   mediumtext   NOT NULL,
  `version`         bigint       NOT NULL DEFAULT 1,
  `created_by`      varchar(64)  NOT NULL DEFAULT '',
  `updated_by`      varchar(64)  NOT NULL DEFAULT '',
  `created_time`    timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_time`    timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dlv_requirement_testing_session` (`biz_line`, `program_id`, `requirement_key`, `executor_type`, `thread_id`),
  KEY `idx_dlv_requirement_testing_session` (`biz_line`, `program_id`, `requirement_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------------------
-- 4. 推进任务：看板主体
--    注意与第 2 层 zt_task_*（下发给端侧的催收指令）的区别：那边是「这条指令
--    发了没有」，这边是「这个能力建到哪一步了」。前缀是唯一的归属判据。
--
--    version 是乐观锁：看板多人同时开着，单条更新一律
--    UPDATE ... WHERE item_key = ? AND version = ?，0 行即冲突。
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `zt_delivery_item` (
  `id`           bigint        NOT NULL AUTO_INCREMENT,
  `biz_line`     varchar(32)   NOT NULL,
  `program_id`     bigint          NOT NULL,                       -- 所属项目
  `item_key`     varchar(64)   NOT NULL,                       -- 任务业务键 如 data-p01，沿用原型 id
  `stage_key`    varchar(64)   NOT NULL,                       -- 所属阶段
  `module_key`   varchar(64)   NOT NULL,                       -- 所属模块
  `requirement_key` varchar(64) NOT NULL DEFAULT '',           -- 所属需求，空串是需求层落地前的存量任务
  `planning_batch_key` varchar(64) NOT NULL DEFAULT '',        -- 来源拆解批次，非必填；手工建的任务留空
  `kind`         varchar(16)   NOT NULL,                       -- gap 坑点 / capability 能力 / asset 已具备
  `prototype_task` boolean      NOT NULL DEFAULT FALSE,         -- 历史兼容字段；新方案不再创建原型图任务
  `title`        varchar(255)  NOT NULL,
  `description`  varchar(1024) NOT NULL,
  `benefit_tags` text          NOT NULL,                       -- 任务收益或作用标签 JSON 数组
  `requirement_document` mediumtext NOT NULL,                  -- 旧需求文档正文，迁移后仅兼容读取
  `requirement_document_path` varchar(512) NOT NULL,           -- 固定相对路径 doc/{module}/{task}/文档.md
  `execution_output`     mediumtext NOT NULL,                  -- 旧执行记录，迁移后仅兼容读取
  `action_output`        mediumtext NOT NULL,                  -- 动作执行产物摘要
  `testing_report`       mediumtext NOT NULL,                  -- 成品测试报告
  `testing_cases_status` varchar(16) NOT NULL DEFAULT 'todo', -- 测试用例：todo/doing/ready/blocked
  `testing_cases`        mediumtext NOT NULL,                  -- 成品测试用例正文
  `testing_cases_path`   varchar(512) NOT NULL DEFAULT '',     -- doc/test/<item_key>/测试用例.md
  `phase`        varchar(16)   NOT NULL DEFAULT 'requirement', -- 唯一当前阶段：requirement/development/testing
  `requirement_status` varchar(16) NOT NULL DEFAULT 'todo',    -- 需求阶段：todo/doing/done/blocked/dropped
  `development_status` varchar(16) NOT NULL DEFAULT 'todo',    -- 开发阶段：todo/doing/done/blocked/dropped
  `testing_status`     varchar(16) NOT NULL DEFAULT 'todo',    -- 测试阶段：todo/doing/done/blocked/dropped
  `status`       varchar(16)   NOT NULL,                       -- todo/doing/done/blocked/dropped
  `progress`     bigint        NOT NULL,                       -- 0-100，done 强制 100，dropped 不计入统计
  `owner_id`     varchar(64)   NOT NULL,                       -- 鉴权落地前先空着，只用 owner_name
  `owner_name`   varchar(64)   NOT NULL,
  `due_date`     date          NULL,                           -- 截止日期，可空
  `note`         varchar(1024) NOT NULL,
  `sort_order`   bigint        NOT NULL,                       -- 列内手工排序，越小越靠前
  `version`      bigint        NOT NULL DEFAULT 1,             -- 乐观锁版本
  `created_by`   varchar(64)   NOT NULL,
  `updated_by`   varchar(64)   NOT NULL,
  `created_time` timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_time` timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dlv_item` (`biz_line`, `program_id`, `item_key`),
  KEY `idx_dlv_item_board` (`biz_line`, `program_id`, `stage_key`, `status`),
  KEY `idx_dlv_item_planning_batch` (`biz_line`, `program_id`, `planning_batch_key`),
  KEY `idx_dlv_item_module` (`biz_line`, `program_id`, `module_key`, `status`),
  KEY `idx_dlv_item_requirement_key` (`biz_line`, `program_id`, `requirement_key`),
  KEY `idx_dlv_item_requirement` (`biz_line`, `program_id`, `requirement_status`),
  KEY `idx_dlv_item_development` (`biz_line`, `program_id`, `development_status`),
  KEY `idx_dlv_item_testing` (`biz_line`, `program_id`, `testing_status`),
  KEY `idx_dlv_item_testing_cases` (`biz_line`, `program_id`, `testing_cases_status`),
  KEY `idx_dlv_item_phase` (`biz_line`, `program_id`, `phase`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------------------
-- 5. 任务执行会话：一个任务可按执行器类型绑定一个当前外部会话
--    执行器负责创建会话，本表只保存平台无关的绑定和独立状态
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `zt_delivery_item_execution_session` (
  `id`                  bigint       NOT NULL AUTO_INCREMENT,
  `biz_line`            varchar(32)  NOT NULL,
  `program_id`     bigint         NOT NULL,
  `item_key`            varchar(64)  NOT NULL,
  `executor_type`       varchar(32)  NOT NULL,                   -- 执行器类型，如 codex / claude
  `phase`               varchar(16)  NOT NULL,                   -- 运行实例所属阶段
  `external_session_id` varchar(255) NOT NULL,                   -- 宿主创建的外部会话标识
  `external_host_id`    varchar(255) NOT NULL,                   -- 可选的宿主或运行节点标识
  `status`              varchar(16)  NOT NULL,                   -- pending/running/completed/blocked/closed
  `progress`            bigint       NOT NULL DEFAULT 0,         -- 运行实例完成进度 0-100
  `metadata_json`       text         NOT NULL,                   -- 执行器扩展元数据 JSON 对象
  `version`             bigint       NOT NULL DEFAULT 1,         -- 乐观锁版本
  `created_by`          varchar(64)  NOT NULL,
  `updated_by`          varchar(64)  NOT NULL,
  `created_time`        timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_time`        timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dlv_item_exec` (`biz_line`, `program_id`, `item_key`, `executor_type`, `phase`),
  UNIQUE KEY `uk_dlv_exec_external` (`biz_line`, `executor_type`, `external_session_id`),
  KEY `idx_dlv_exec_status` (`biz_line`, `program_id`, `item_key`, `phase`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------------------
-- 6. 执行批次：一次批量并行或串行启动的服务端生命周期。
--    批次固定关联一条需求和启动时的需求分支；完成提醒只属于启动者。
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `zt_delivery_execution_batch` (
  `id`                     bigint       NOT NULL AUTO_INCREMENT,
  `biz_line`               varchar(32)  NOT NULL,
  `program_id`             bigint       NOT NULL,
  `batch_id`               varchar(64)  NOT NULL,
  `requirement_key`        varchar(64)  NOT NULL,
  `requirement_name`       varchar(255) NOT NULL,
  `requirement_git_branch` varchar(255) NOT NULL,
  `mode`                   varchar(16)  NOT NULL,              -- parallel / sequence
  `executor_type`          varchar(32)  NOT NULL,              -- codex / claude
  `status`                 varchar(16)  NOT NULL,              -- running / completed / blocked
  `item_count`             bigint       NOT NULL,
  `completed_count`        bigint       NOT NULL,
  `blocked_count`          bigint       NOT NULL,
  `summary`                varchar(2048) NOT NULL,
  `notification_read_at`   timestamp    NULL,                  -- 启动者点击完成提醒的时间
  `started_at`             timestamp    NULL,
  `finished_at`            timestamp    NULL,
  `created_by`             varchar(64)  NOT NULL,
  `created_by_name`        varchar(64)  NOT NULL,
  `updated_by`             varchar(64)  NOT NULL,
  `created_time`           timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_time`           timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dlv_execution_batch` (`biz_line`, `program_id`, `batch_id`),
  KEY `idx_dlv_execution_batch_requirement` (`biz_line`, `program_id`, `requirement_key`),
  KEY `idx_dlv_execution_batch_notice` (`biz_line`, `program_id`, `status`, `finished_at`, `created_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------------------
-- 6.1 执行批次任务：保留本批次内每条任务的进度和结果，任务后来变更也不影响历史。
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `zt_delivery_execution_batch_item` (
  `id`           bigint      NOT NULL AUTO_INCREMENT,
  `biz_line`     varchar(32) NOT NULL,
  `program_id`   bigint      NOT NULL,
  `batch_id`     varchar(64) NOT NULL,
  `item_key`     varchar(64) NOT NULL,
  `sequence`     bigint      NOT NULL,
  `status`       varchar(16) NOT NULL,                         -- pending / running / completed / blocked
  `message`      varchar(1024) NOT NULL,
  `created_time` timestamp   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_time` timestamp   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dlv_execution_batch_item` (`biz_line`, `program_id`, `batch_id`, `item_key`),
  KEY `idx_dlv_execution_batch_item_active` (`biz_line`, `program_id`, `batch_id`, `item_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------------------
-- 6.2 需求完成通知：需求进入 done 后，逐位通知主负责人和协助者。
--     创建人不是默认接收人；每位接收人独立确认已读。
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `zt_delivery_requirement_completion_notification` (
  `id`                   bigint       NOT NULL AUTO_INCREMENT,
  `biz_line`             varchar(32)  NOT NULL,
  `program_id`           bigint       NOT NULL,
  `requirement_key`      varchar(64)  NOT NULL,
  `requirement_name`     varchar(255) NOT NULL,
  `recipient_id`         varchar(64)  NOT NULL,
  `recipient_name`       varchar(64)  NOT NULL,
  `notification_read_at` timestamp    NULL,                     -- 仅当前接收人的已读时间
  `completed_at`         timestamp    NOT NULL,                 -- 本轮需求被标记完成的时间
  `created_time`         timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_time`         timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dlv_requirement_completion_notice` (`biz_line`, `program_id`, `requirement_key`, `recipient_id`),
  KEY `idx_dlv_requirement_completion_recipient` (`biz_line`, `program_id`, `recipient_id`, `notification_read_at`, `completed_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------------------
-- 7. 任务依赖：predecessor -> successor 表示后置任务等待前置任务
--    一对多表示并行分叉，多对一表示汇合；环形依赖由 service 拒绝
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `zt_delivery_item_dependency` (
  `id`                    bigint      NOT NULL AUTO_INCREMENT,
  `biz_line`              varchar(32) NOT NULL,
  `program_id`     bigint        NOT NULL,
  `predecessor_item_key`  varchar(64) NOT NULL,               -- 前置任务业务键
  `successor_item_key`    varchar(64) NOT NULL,               -- 后置任务业务键
	`source_side`           varchar(8)  NOT NULL DEFAULT '',    -- top/right/bottom/left，空值自动选择
  `target_side`           varchar(8)  NOT NULL DEFAULT '',    -- top/right/bottom/left，空值自动选择
  `created_by`            varchar(64) NOT NULL,
  `created_time`          timestamp   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dlv_item_dep` (`biz_line`, `program_id`, `predecessor_item_key`, `successor_item_key`),
  KEY `idx_dlv_item_dep_pre` (`biz_line`, `program_id`, `predecessor_item_key`),
  KEY `idx_dlv_item_dep_suc` (`biz_line`, `program_id`, `successor_item_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------------------
-- 7. 需求流水：需求自身的字段变更。任务流水在下一张表，需求时间线再合并两者。
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `zt_delivery_requirement_event` (
  `id`              bigint        NOT NULL AUTO_INCREMENT,
  `biz_line`        varchar(32)   NOT NULL,
  `program_id`      bigint        NOT NULL,
  `requirement_key` varchar(64)   NOT NULL,
  `kind`            varchar(16)   NOT NULL,                   -- create/field/delete
  `field`           varchar(32)   NOT NULL,
  `from_value`      varchar(255)  NOT NULL,
  `to_value`        varchar(255)  NOT NULL,
  `comment`         varchar(1024) NOT NULL,
  `actor_id`        varchar(64)   NOT NULL,
  `actor_name`      varchar(64)   NOT NULL,
  `created_time`    timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_dlv_requirement_event_time` (`biz_line`, `program_id`, `requirement_key`, `created_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------------------
-- 8. 任务流水：状态流转、进度改动、进展评论各一条
--    没有这张表，看板只有「当前快照」，回答不了「这个月推动了什么」「这条卡了几天」
--    任务删了流水不删 —— 「谁在什么时候把它删掉的」还得留着
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `zt_delivery_item_event` (
  `id`           bigint        NOT NULL AUTO_INCREMENT,
  `biz_line`     varchar(32)   NOT NULL,
  `program_id`     bigint          NOT NULL,
  `item_key`     varchar(64)   NOT NULL,                       -- 任务业务键，不建外键
	`requirement_key` varchar(64) NOT NULL DEFAULT '',             -- 事件发生时所属需求，删除/移动后仍可回溯
  `kind`         varchar(16)   NOT NULL,                       -- create/field/comment/delete
  `field`        varchar(32)   NOT NULL,                       -- 变更字段名，kind=field 时有值
  `from_value`   varchar(255)  NOT NULL,
  `to_value`     varchar(255)  NOT NULL,
  `comment`      varchar(1024) NOT NULL,                       -- 进展说明
  `actor_id`     varchar(64)   NOT NULL,                       -- 操作人，取自凭证不取请求体
  `actor_name`   varchar(64)   NOT NULL,
  `created_time` timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_dlv_event_item` (`biz_line`, `program_id`, `item_key`),
  KEY `idx_dlv_event_time` (`biz_line`, `program_id`, `created_time`),
  KEY `idx_dlv_event_requirement_time` (`biz_line`, `program_id`, `requirement_key`, `created_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------------------
-- 9. 每日进度快照：按 (项目, 模块) 一行，module_key 为空串的那行是整体
--    趋势线和三维全景的历史对比靠它 —— 拿当前 item 表算不出上周的进度
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `zt_delivery_snapshot` (
  `id`             bigint        NOT NULL AUTO_INCREMENT,
  `biz_line`       varchar(32)   NOT NULL,
  `program_id`     bigint          NOT NULL,
  `stat_date`      date          NOT NULL,                     -- 统计日期
  `module_key`     varchar(64)   NOT NULL,                     -- 空串表示整体
  `progress`       decimal(5,2)  NOT NULL,                     -- 该模块进度，非 dropped 任务的平均值
  `maturity_score` decimal(5,2)  NOT NULL,                     -- 加权成熟度，仅整体行有值
  `total_count`    bigint        NOT NULL,                     -- 任务总数（不含 dropped）
  `done_count`     bigint        NOT NULL,
  `doing_count`    bigint        NOT NULL,
  `blocked_count`  bigint        NOT NULL,
  `created_time`   timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dlv_snapshot` (`biz_line`, `program_id`, `stat_date`, `module_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
