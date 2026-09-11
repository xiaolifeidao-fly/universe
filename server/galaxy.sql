-- =========================================================================
-- 共享算力池建表语句 · zt_galaxy_*
--
-- 与 service/galaxy/internal/repository/model.go 一一对应。这份文件不是手写的，
-- 是让 GORM 自己走一遍建表流程抄下来的（见 ddldump_test.go），所以先跑这份 SQL
-- 再跑 `go run ./cmd/galaxyinit` 不会被 ALTER —— 两条路建出来的结构一模一样。
--
-- 因此这里刻意不写 COLUMN COMMENT、不加多余的 DEFAULT、不写 NOT NULL：
-- AutoMigrate 会把「库里有、模型里没有」判定为差异并改回去。字段说明放在行注释里。
-- 整型统一 bigint —— Go 的 int 在 64 位下映射过来就是它。
--
-- galaxyinit 除了建表还会写入默认定价（zt_galaxy_price）与额度包（zt_galaxy_package）。
-- 只跑这份 SQL 的话这两张表是空的：请求会因为「未定价」而只计量不计费，
-- 控制台的「额度与订单」也会显示「暂时没有上架的额度包」。
-- 不想跑 galaxyinit 的话，接着跑一遍 server/galaxy_seed.sql（可重复执行）。
--
-- 库：galaxy-api 的 application.properties 里 sqlconn 指向的那个
-- 依赖：MySQL 5.7+
-- =========================================================================

-- 共享池按平台维度运行，不按空间隔离：池内表的 biz_line 固定为 'galaxy'。
-- 任务宇宙这类按空间运行的业务接进来时，真实空间落在 unit.space / ledger_session.space。
--
-- 供给单元是「贡献」而不是「节点」—— 座位、额度、队列、绑定、限流全部以 cid 为主键。
-- 一台机器可以有多个贡献，同机两个贡献的额度互相独立。


-- -------------------------------------------------------------------------
-- 1. 供给：机器 → 贡献 → 授权 → 座位
-- 贡献 = 一台机器上的一种能力（kind + provider）。额度以 Hub 为权威：
-- 节点本地申报的只是展示副本，真正生效的是 quota_grant 这几行。
-- 座位的权威在 Redis（ZSET，score 是过期时刻），seat_binding 只供审计。
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `zt_galaxy_node` (
  `id`               bigint AUTO_INCREMENT,                        -- 主键
  `biz_line`         varchar(32),                                  -- 业务线，池内固定 galaxy
  `node_id`          varchar(64),                                  -- 节点业务键
  `owner_user_id`    varchar(64),                                  -- 提供者用户标识
  `display_name`     varchar(128),                                 -- 主人给机器起的名字
  `token_hash`       varchar(64),                                  -- 节点令牌 sha256
  `bridge_version`   varchar(32),                                  -- ai-bridge 版本
  `contract_version` bigint,                                       -- 节点声明的契约版本
  `access_mode`      varchar(16) DEFAULT 'poll',                   -- poll=节点长轮询领活；export=Hub 回连节点公网地址
  `endpoint_url`     varchar(255) DEFAULT '',                      -- export：Hub 回连的公网基地址
  `endpoint_secret`  varchar(128) DEFAULT '',                      -- export：回连密钥。节点生成、注册时上报，Hub 必须持有明文才能出示
  `endpoint_status`  varchar(16) DEFAULT '',                       -- export：最近一次回连探测结果 ok/unreachable
  `endpoint_error`   varchar(255) DEFAULT '',                      -- export：最近一次回连失败的原因，人话，直接展示
  `endpoint_checked_at` timestamp NULL DEFAULT NULL,               -- export：最近一次回连探测时刻
  `resources_json`   text,                                         -- 探测到的本机资源，仅供放置的资源需求过滤
  `machine_fingerprint` varchar(64),                               -- 设备指纹 sha256，工作室的信誉、平台封禁都跟着它走；老版本节点不报，为空
  `status`           varchar(16),                                  -- active/offline/revoked
  `banned`           boolean DEFAULT false,                        -- 平台封禁。请求路径只看这一列；报过指纹的节点随 zt_galaxy_machine_ban 一起改
  `last_beat_at`     timestamp NULL DEFAULT NULL,                               -- 最近一次心跳
  `online_since`     timestamp NULL DEFAULT NULL,                               -- 本轮连续在线起点
  `created_time`     datetime(3) NULL,                             -- 创建时间
  `updated_time`     datetime(3) NULL,                             -- 更新时间
  PRIMARY KEY (`id`),
  INDEX `idx_gx_node_owner` (`biz_line`,`owner_user_id`,`status`),
  INDEX `idx_gx_node_token` (`biz_line`,`token_hash`),
  INDEX `idx_gx_node_fingerprint` (`biz_line`,`machine_fingerprint`),
  UNIQUE INDEX `uk_gx_node_id` (`biz_line`,`node_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 提供者身份：散户 / 工作室。注册默认是散户，没有行就是散户；只有管理端能设成工作室。
-- 两者只差信誉跟着谁走：散户跟着账号，工作室跟着设备（设备指纹）。
CREATE TABLE IF NOT EXISTS `zt_galaxy_provider` (
  `id`            bigint AUTO_INCREMENT,
  `biz_line`      varchar(32),
  `owner_user_id` varchar(64),                                  -- 提供者用户标识
  `provider_type` varchar(16),                                  -- individual=散户，信誉跟着账号；studio=工作室，信誉跟着设备
  `updated_by`    varchar(64),                                  -- 最近一次改身份的管理端账号
  `created_time`  datetime(3) NULL,
  `updated_time`  datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_provider_owner` (`biz_line`,`owner_user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 信誉记录。主体 account:<账号>（散户读）、device:<设备指纹>（工作室读）、node:<nodeId>（没报指纹的老节点）。
-- 扣分同时记账号和设备两份，读哪份看身份，所以改身份不清零。
-- 行只在第一次扣分时建，没有行就是满分。reputation 是 reputation_at 那一刻的分数，
-- 此刻的分数按 galaxy.reputation_recovery_per_day 现算。
CREATE TABLE IF NOT EXISTS `zt_galaxy_reputation` (
  `id`            bigint AUTO_INCREMENT,
  `biz_line`      varchar(32),
  `subject`       varchar(96),                                  -- account:<账号> / device:<设备指纹> / node:<nodeId>
  `reputation`    double,                                       -- 信誉分 0..1，截至 reputation_at；此后按天回升
  `reputation_at` timestamp NULL DEFAULT NULL,                  -- reputation 的结算时刻
  `created_time`  datetime(3) NULL,
  `updated_time`  datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_reputation_subject` (`biz_line`,`subject`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 平台封禁，按设备指纹记，和散户 / 工作室无关。节点记录每配一次对就换一个 nodeId，
-- 封禁只记在节点上的话，被封的机器解绑重配、换个账号再配就回来了。
-- 请求路径看的仍是 zt_galaxy_node.banned：封禁 / 解封时带这个指纹的节点一起改，
-- 新配出来的节点在 hello 报上指纹时补标。没报过指纹的老节点只能封节点那一行。
-- 解封不删行，banned 改回 false。
CREATE TABLE IF NOT EXISTS `zt_galaxy_machine_ban` (
  `id`                  bigint AUTO_INCREMENT,
  `biz_line`            varchar(32),
  `machine_fingerprint` varchar(64),                            -- 设备指纹 sha256，同 zt_galaxy_node.machine_fingerprint
  `banned`              boolean,                                -- 是否封禁中；解封改回 false，不删行
  `reason`              varchar(255),                           -- 最近一次封禁 / 解封填的原因
  `updated_by`          varchar(64),                            -- 最近一次操作的管理端账号
  `created_time`        datetime(3) NULL,
  `updated_time`        datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_machine_ban_fingerprint` (`biz_line`,`machine_fingerprint`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_galaxy_pairing_code` (
  `id`            bigint AUTO_INCREMENT,
  `biz_line`      varchar(32),
  `code`          varchar(32),                               -- 配对码明文，10 分钟有效
  `owner_user_id` varchar(64),
  `terms_version` varchar(32),                               -- 签发时的条款版本，pair 时再校验一次
  `expires_at`    timestamp NULL DEFAULT NULL,                            -- 过期时刻
  `consumed_at`   timestamp NULL DEFAULT NULL,                            -- 被兑换的时刻，非空即失效
  `node_id`       varchar(64),                               -- 兑换出的节点
  `created_time`  datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_pairing_code` (`biz_line`,`code`),
  INDEX `idx_gx_pairing_owner` (`biz_line`,`owner_user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 提供者接入密钥。单独部署的 rust bridge 用它自助注册节点，代替配对码。
--
-- 与配对码的分工：配对码一次性、10 分钟有效，给可视化客户端用（人在两个界面之间搬一个码）；
-- 接入密钥是长期的，给无人值守的服务器用 —— 那种机器上没人能去点一下「生成配对码」。
-- 明文只在签发那一刻返回一次，库里存 sha256，与算力密钥同一套做法。
CREATE TABLE IF NOT EXISTS `zt_galaxy_provider_key` (
  `id`            bigint AUTO_INCREMENT,
  `biz_line`      varchar(32),                                  -- 业务线，池内固定 galaxy
  `key_id`        varchar(64),                                  -- 匿名标识 gpk_…，日志与列表里用它
  `key_hash`      varchar(64),                                  -- gpk- 明文的 sha256
  `owner_user_id` varchar(64),                                  -- 归属的提供者：用这把密钥注册的机器算他的
  `alias`         varchar(64),                                  -- 主人给这把密钥起的名字
  `terms_version` varchar(32),                                  -- 签发时的条款版本，注册时再校验一次
  `status`        varchar(16),                                  -- active/revoked
  `last_used_at`  timestamp NULL DEFAULT NULL,                  -- 最近一次注册成功
  `last_node_id`  varchar(64),                                  -- 最近一次注册出来的节点
  `expires_at`    timestamp NULL DEFAULT NULL,                  -- 空表示不过期
  `created_time`  datetime(3) NULL,
  `updated_time`  datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_provider_key_id` (`biz_line`,`key_id`),
  UNIQUE INDEX `uk_gx_provider_key_hash` (`biz_line`,`key_hash`),
  INDEX `idx_gx_provider_key_owner` (`biz_line`,`owner_user_id`,`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_galaxy_contribution` (
  `id`                bigint AUTO_INCREMENT,
  `biz_line`          varchar(32),
  `cid`               varchar(96),                                  -- 贡献业务键，全局唯一
  `node_id`           varchar(64),
  `owner_user_id`     varchar(64),
  `kind`              varchar(64),                                  -- 能力注册名，如 llm.chat
  `kind_version`      bigint,
  `provider`          varchar(64),                                  -- 路由键，选节点 provider
  `models_allow_json` varchar(1024),                                -- 模型白名单模式数组
  `models_available_json` varchar(4096) DEFAULT NULL,               -- 节点上报的上游可用模型名，仅作控制台候选项
  `models_deny_json`  varchar(1024),                                -- 模型黑名单模式数组
  `seats`             bigint DEFAULT 3,                             -- 同时服务的消费者数量上限
  `seat_concurrency`  bigint DEFAULT 2,                             -- 单座位并发上限
  `schedule_json`     varchar(512),                                 -- 挂机时段
  `status`            varchar(16),                                  -- active/draining/paused/disabled
  `created_time`      datetime(3) NULL,
  `updated_time`      datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_contribution_cid` (`biz_line`,`cid`),
  INDEX `idx_gx_contribution_node` (`biz_line`,`node_id`,`status`),
  INDEX `idx_gx_contribution_lane` (`biz_line`,`kind`,`provider`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_galaxy_quota_grant` (
  `id`           bigint AUTO_INCREMENT,
  `biz_line`     varchar(32),
  `cid`          varchar(96),
  `unit`         varchar(48),                                 -- 计量单位
  `limit_value`  bigint,                                      -- 窗口内上限
  `window`       varchar(16),                                 -- day/week/month/total
  `reset_at`     varchar(16),                                 -- 归零时刻与时区偏移，如 00:00+08:00
  `updated_time` datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_quota_grant` (`biz_line`,`cid`,`unit`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_galaxy_quota_window` (
  `id`          bigint AUTO_INCREMENT,
  `biz_line`    varchar(32),
  `cid`         varchar(96),
  `unit`        varchar(48),
  `window_key`  varchar(24),
  `used`        bigint,
  `reserved`    bigint,
  `snapshot_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_quota_window` (`biz_line`,`cid`,`unit`,`window_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_galaxy_seat_binding` (
  `id`           bigint AUTO_INCREMENT,
  `biz_line`     varchar(32),
  `cid`          varchar(96),
  `consumer_key` varchar(64),
  `lane`         varchar(128),
  `bound_at`     timestamp NULL DEFAULT NULL,
  `last_used_at` timestamp NULL DEFAULT NULL,
  `released_at`  timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_seat_binding` (`biz_line`,`cid`,`consumer_key`,`lane`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- -------------------------------------------------------------------------
-- 2. 执行与计量
-- unit 是一次请求 / 一个回合 / 一个任务的权威记录，三种原语共用这一张。
-- 计量幂等键是 (unit_id, attempt, unit)，对账以 meter_record 求和为准；
-- 额度计数器不在这里，在 Redis（每请求两次以上的高频写），这边只留分钟级快照。
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `zt_galaxy_unit` (
  `id`            bigint AUTO_INCREMENT,
  `biz_line`      varchar(32),
  `unit_id`       varchar(40),                                                    -- ULID，全局唯一
  `kind`          varchar(64),
  `kind_version`  bigint,
  `primitive`     varchar(16),
  `family`        varchar(32),
  `provider`      varchar(64),
  `model`         varchar(96),
  `consumer_key`  varchar(64),
  `space`         varchar(64),
  `sid`           varchar(40),                                                    -- session 原语的会话 id
  `op`            varchar(16),                                                    -- open/resume/turn/close
  `cid`           varchar(96),
  `seq`           bigint DEFAULT 0,                                               -- session 回合序号
  `attempt`       bigint DEFAULT 1,                                               -- job 重跑次数
  `state`         varchar(16),
  `error_class`   varchar(24),
  `error_code`    varchar(48),
  `error_message` varchar(512),                                                   -- 面向消费者的简明错误，不含请求内容
  `first_byte_at` timestamp NULL DEFAULT NULL,                                                 -- 首字节时刻，决定失败语义
  `started_at`    timestamp NULL DEFAULT NULL,
  `finished_at`   timestamp NULL DEFAULT NULL,
  `estimate_json` varchar(512),
  `actual_json`   varchar(512),
  `instance`      varchar(128),                                                   -- 持有消费者连接的 Hub 实例
  `created_time`  datetime(3) NULL,
  `updated_time`  datetime(3) NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_gx_unit_sweep` (`state`,`updated_time`),
  UNIQUE INDEX `uk_gx_unit_id` (`biz_line`,`unit_id`),
  INDEX `idx_gx_unit_consumer` (`biz_line`,`consumer_key`,`kind`,`created_time`),
  INDEX `idx_gx_unit_contribution` (`biz_line`,`cid`,`state`),
  INDEX `idx_gx_unit_session` (`biz_line`,`sid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_galaxy_unit_event` (
  `id`         bigint AUTO_INCREMENT,
  `biz_line`   varchar(32),
  `unit_id`    varchar(40),
  `seq`        bigint DEFAULT 0,
  `kind`       varchar(32),                                      -- placed/claimed/first_byte/completed/reassigned 等
  `message`    varchar(512),
  `data_json`  text,
  `created_at` datetime(3) NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_gx_unit_event_stream` (`biz_line`,`unit_id`,`seq`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_galaxy_meter_record` (
  `id`           bigint AUTO_INCREMENT,
  `biz_line`     varchar(32),
  `unit_id`      varchar(40),
  `attempt`      bigint,                                                         -- 结算幂等键的一半：rid + attempt
  `unit`         varchar(48),
  `cid`          varchar(96),
  `consumer_key` varchar(64),
  `kind`         varchar(64),
  `amount`       bigint,
  `source`       varchar(8),                                                     -- hub/stream/node
  `created_at`   datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_meter_record` (`biz_line`,`unit_id`,`attempt`,`unit`),
  INDEX `idx_gx_meter_consumer` (`biz_line`,`consumer_key`,`kind`,`created_at`),
  INDEX `idx_gx_meter_contribution` (`biz_line`,`cid`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_galaxy_usage_mismatch` (
  `id`         bigint AUTO_INCREMENT,
  `biz_line`   varchar(32),
  `unit_id`    varchar(40),
  `cid`        varchar(96),
  `unit`       varchar(48),
  `hub_value`  bigint,
  `node_value` bigint,
  `ratio`      double,
  `created_at` datetime(3) NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_gx_usage_mismatch` (`biz_line`,`unit_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- -------------------------------------------------------------------------
-- 3. 消费者：密钥、余额、商品与订单
-- 算力密钥只存 sha256，明文在签发那一次返回后永远查不到。
-- 支付与履约分两步：回调只把订单推到 paid，履约单独一步且幂等 ——
-- 渠道重推同一条通知不会重复发额度。
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `zt_galaxy_consumer_key` (
  `id`                     bigint AUTO_INCREMENT,
  `biz_line`               varchar(32),
  `key_id`                 varchar(64),                                    -- 匿名标识 ck_…，节点看到的就是它
  `key_hash`               varchar(64),                                    -- sk- 明文的 sha256
  `alias`                  varchar(64),                                    -- 日志与账单里的可读名
  `owner_user_id`          varchar(64),
  `order_id`               varchar(64),
  `allowed_kinds_json`     varchar(512),                                   -- 空数组表示不限
  `allowed_providers_json` varchar(512),
  `model_tier_json`        varchar(1024),                                  -- 允许的模型模式
  `concurrency`            bigint DEFAULT 4,
  `rpm`                    bigint DEFAULT 120,
  `status`                 varchar(16),                                    -- active/expired/frozen/revoked
  `issued_at`              timestamp NULL DEFAULT NULL,
  `expires_at`             timestamp NULL DEFAULT NULL,                                 -- 到期后请求返回 key_expired
  `frozen_until`           timestamp NULL DEFAULT NULL,                                 -- 冻结期内可续期换发
  `renewed_from_key_id`    varchar(64),
  `notice_version`         varchar(32),
  `notice_ack_at`          timestamp NULL DEFAULT NULL,
  `created_time`           datetime(3) NULL,
  `updated_time`           datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_consumer_key_hash` (`biz_line`,`key_hash`),
  INDEX `idx_gx_consumer_key_owner` (`biz_line`,`owner_user_id`,`status`),
  UNIQUE INDEX `uk_gx_consumer_key_id` (`biz_line`,`key_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_galaxy_consumer_balance` (
  `id`           bigint AUTO_INCREMENT,
  `biz_line`     varchar(32),
  `key_id`       varchar(64),
  `unit`         varchar(48),
  `balance`      bigint,
  `frozen`       bigint,
  `updated_time` datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_consumer_balance` (`biz_line`,`key_id`,`unit`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_galaxy_consent_record` (
  `id`            bigint AUTO_INCREMENT,
  `biz_line`      varchar(32),
  `subject_type`  varchar(16),                                                          -- provider/consumer
  `user_id`       varchar(64),
  `terms_version` varchar(32),
  `accepted_at`   timestamp NULL DEFAULT NULL,
  `ip`            varchar(64),
  `user_agent`    varchar(256),
  `created_time`  datetime(3) NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_gx_consent_subject` (`biz_line`,`subject_type`,`user_id`,`terms_version`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_galaxy_price` (
  `id`             bigint AUTO_INCREMENT,
  `biz_line`       varchar(32),
  `kind`           varchar(64),
  `unit`           varchar(48),
  `effective_from` timestamp NULL DEFAULT NULL,
  `price`          bigint,                                                -- 每百万单位价格，单位微分
  `currency`       varchar(8) DEFAULT 'CNY',
  `provider_share` double DEFAULT 0.700000,                               -- 提供者分成比例
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_price` (`biz_line`,`kind`,`unit`,`effective_from`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_galaxy_artifact` (
  `id`           bigint AUTO_INCREMENT,
  `biz_line`     varchar(32),
  `object_key`   varchar(256),                                 -- 对象键不含任何用户或节点信息
  `unit_id`      varchar(40),
  `owner_key`    varchar(64),                                  -- 归属密钥的匿名标识
  `kind`         varchar(64),
  `size`         bigint,
  `sha256`       varchar(64),
  `content_type` varchar(128),
  `expires_at`   timestamp NULL DEFAULT NULL,                               -- 按 kind 保留期清理
  `deleted`      boolean DEFAULT false,
  `created_time` datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_artifact_key` (`biz_line`,`object_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_galaxy_package` (
  `id`                 bigint AUTO_INCREMENT,
  `biz_line`           varchar(32),
  `package_code`       varchar(64),
  `title`              varchar(128),
  `units_json`         varchar(1024),
  `amount`             bigint,
  `currency`           varchar(8) DEFAULT 'CNY',
  `ttl_days`           bigint DEFAULT 30,
  `allowed_kinds_json` varchar(512),
  `model_tier_json`    varchar(1024),
  `concurrency`        bigint DEFAULT 4,
  `rpm`                bigint DEFAULT 120,
  `listed`             boolean DEFAULT true,
  `sort_order`         bigint DEFAULT 0,
  `created_time`       datetime(3) NULL,
  `updated_time`       datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_package` (`biz_line`,`package_code`),
  INDEX `idx_gx_package_listed` (`biz_line`,`listed`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_galaxy_order` (
  `id`            bigint AUTO_INCREMENT,
  `biz_line`      varchar(32),
  `order_id`      varchar(64),
  `user_id`       varchar(64),
  `package_code`  varchar(64),
  `amount`        bigint,
  `currency`      varchar(8) DEFAULT 'CNY',
  `units_json`    varchar(1024),
  `target_key_id` varchar(64),                                              -- 非空表示给这把已有密钥充值，空表示签发新密钥
  `key_id`        varchar(64),                                              -- 履约后落到哪把密钥
  `status`        varchar(16),                                              -- pending/paid/fulfilled/cancelled
  `payment_ref`   varchar(128),
  `paid_at`       timestamp NULL DEFAULT NULL,
  `fulfilled_at`  timestamp NULL DEFAULT NULL,
  `created_time`  datetime(3) NULL,
  `updated_time`  datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_order` (`biz_line`,`order_id`),
  INDEX `idx_gx_order_user` (`biz_line`,`user_id`,`status`,`created_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- -------------------------------------------------------------------------
-- 4. 上下文账本（session 原语）
-- 会话是硬亲和的：活着的时候一直钉在同一个贡献上。
-- 但上下文由平台记账，节点不在了这份东西仍然完整 —— 换台机器能接着跑。
-- (sid, seq) 是回合幂等键，重复提交同一个 seq 不重跑。
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `zt_galaxy_ledger_session` (
  `id`                     bigint AUTO_INCREMENT,
  `biz_line`               varchar(32),
  `sid`                    varchar(40),
  `kind`                   varchar(64),
  `kind_version`           bigint,
  `provider`               varchar(64),
  `consumer_key`           varchar(64),
  `space`                  varchar(64),
  `program_ref`            varchar(128),
  `cid`                    varchar(96),
  `state`                  varchar(16),                                  -- open/pinned/migrating/closed
  `last_seq`               bigint DEFAULT 0,
  `context_schema_version` varchar(64),
  `workspace_ref_json`     varchar(1024),                                -- 工作区分支与 commit，跨节点续接靠它
  `close_reason`           varchar(128),
  `created_time`           datetime(3) NULL,
  `last_turn_at`           timestamp NULL DEFAULT NULL,
  `updated_time`           datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_ledger_session` (`biz_line`,`sid`),
  INDEX `idx_gx_ledger_session_key` (`biz_line`,`consumer_key`,`state`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_galaxy_ledger_turn` (
  `id`                 bigint AUTO_INCREMENT,
  `biz_line`           varchar(32),
  `sid`                varchar(40),
  `seq`                bigint,
  `unit_id`            varchar(40),
  `cid`                varchar(96),
  `input_json`         mediumtext,
  `output_summary`     text,
  `tool_calls_json`    mediumtext,
  `changed_files_json` mediumtext,
  `artifacts_json`     mediumtext,
  `usage_json`         varchar(512),
  `external_thread_id` varchar(128),                         -- 节点侧 CLI thread，换节点后失效
  `state`              varchar(16),
  `workspace_lost`     boolean DEFAULT false,
  `started_at`         timestamp NULL DEFAULT NULL,
  `ended_at`           timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_ledger_turn` (`biz_line`,`sid`,`seq`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_galaxy_ledger_checkpoint` (
  `id`          bigint AUTO_INCREMENT,
  `biz_line`    varchar(32),
  `sid`         varchar(40),
  `seq`         bigint,
  `provider`    varchar(64),
  `cli_version` varchar(32),
  `object_key`  varchar(256),
  `size`        bigint,
  `created_at`  datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_ledger_checkpoint` (`biz_line`,`sid`,`seq`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- -------------------------------------------------------------------------
-- 5. 结算三本账、抽检与争议
-- 消费侧、供给侧、平台侧各记各的，三本账可对平。
-- 争议成立不抹原始流水，而是各记一笔反向的（refund / clawback / baddebt）——
-- 抹掉就对不出「这笔钱进来过又出去了」，事后没法审。
-- audit_probe 短期保留被抽中那次的请求原文（重放要用），但节点的响应只留结构签名。
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `zt_galaxy_credit_account` (
  `id`            bigint AUTO_INCREMENT,
  `biz_line`      varchar(32),
  `owner_user_id` varchar(64),
  `balance`       bigint,
  `frozen`        bigint,
  `updated_time`  datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_credit_account` (`biz_line`,`owner_user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_galaxy_consumer_ledger` (
  `id`            bigint AUTO_INCREMENT,
  `biz_line`      varchar(32),
  `txn_id`        varchar(96),                                           -- 幂等键 rid+attempt+unit
  `key_id`        varchar(64),
  `type`          varchar(16),                                           -- topup/reserve/settle/refund/expire
  `unit`          varchar(48),
  `amount`        bigint,
  `price`         bigint,                                                -- 结算时点的单价快照
  `balance_after` bigint,
  `unit_id`       varchar(40),
  `created_at`    datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_consumer_ledger` (`biz_line`,`txn_id`),
  INDEX `idx_gx_consumer_ledger_key` (`biz_line`,`key_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_galaxy_provider_ledger` (
  `id`            bigint AUTO_INCREMENT,
  `biz_line`      varchar(32),
  `txn_id`        varchar(96),
  `cid`           varchar(96),
  `owner_user_id` varchar(64),
  `type`          varchar(16),                                        -- contribute/settle/payout/clawback
  `unit`          varchar(48),
  `amount`        bigint,                                             -- unit=credit 时为积分
  `price`         bigint,
  `unit_id`       varchar(40),
  `created_at`    datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_provider_ledger` (`biz_line`,`txn_id`),
  INDEX `idx_gx_provider_ledger_cid` (`biz_line`,`cid`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_galaxy_platform_ledger` (
  `id`         bigint AUTO_INCREMENT,
  `biz_line`   varchar(32),
  `txn_id`     varchar(96),
  `type`       varchar(16),                                   -- fee/baddebt
  `amount`     bigint,
  `unit_id`    varchar(40),
  `created_at` datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_platform_ledger` (`biz_line`,`txn_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 提现申请。账本只前进不回退，而提现在钱真的打出去之前还有一段人工过程
-- （待打款 / 驳回 / 重试）—— 那段状态放在这张表上，账本上只在受理那一刻记一笔 payout。
CREATE TABLE IF NOT EXISTS `zt_galaxy_payout` (
  `id`            bigint AUTO_INCREMENT,
  `biz_line`      varchar(32),
  `payout_id`     varchar(64),
  `owner_user_id` varchar(64),
  `credits`       bigint,                                          -- 提现的积分数
  `amount`        bigint,                                          -- 折算出的金额，微分
  `currency`      varchar(8) DEFAULT 'CNY',
  `fee`           bigint,                                          -- 手续费，微分
  `method`        varchar(16),                                     -- alipay/wechat/bank
  `account`       varchar(128),                                    -- 收款账号，展示时打码
  `status`        varchar(16),                                     -- pending/paid/rejected
  `note`          varchar(256),                                    -- 驳回原因等，面向申请人
  `handled_by`    varchar(64),
  `handled_at`    timestamp NULL DEFAULT NULL,
  `created_time`  datetime(3) NULL,
  `updated_time`  datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_payout` (`biz_line`,`payout_id`),
  INDEX `idx_gx_payout_owner` (`biz_line`,`owner_user_id`,`status`,`created_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_galaxy_audit_probe` (
  `id`               bigint AUTO_INCREMENT,
  `biz_line`         varchar(32),
  `probe_id`         varchar(40),
  `cid`              varchar(96),
  `unit_id`          varchar(40),
  `family`           varchar(32),
  `path`             varchar(64),
  `model`            varchar(96),
  `request_body`     mediumtext,                                          -- 仅为重放保留的请求原文，比对完立即清空，超 24 小时未跑也清空
  `node_signature`   varchar(1024),                                       -- 节点响应的结构签名，不是响应内容
  `shadow_signature` varchar(1024),                                       -- 影子重放的结构签名，同样不含响应内容
  `shadow_unit_id`   varchar(40),
  `similarity`       double,
  `verdict`          varchar(16),                                         -- pending/ready/pass/suspect/forged/skipped
  `detail`           varchar(512),
  `created_at`       datetime(3) NULL,
  `checked_at`       timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_gx_audit_probe_pending` (`biz_line`,`verdict`,`created_at`),
  UNIQUE INDEX `uk_gx_audit_probe` (`biz_line`,`probe_id`),
  INDEX `idx_gx_audit_probe_cid` (`biz_line`,`cid`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_galaxy_dispute` (
  `id`               bigint AUTO_INCREMENT,
  `biz_line`         varchar(32),
  `dispute_id`       varchar(40),                                                -- dp_ + ULID
  `unit_id`          varchar(40),
  `attempt`          bigint,
  `kind`             varchar(64),
  `key_id`           varchar(64),                                                -- 花钱的那把算力密钥
  `owner_user_id`    varchar(64),                                                -- 申诉人，即消费者
  `cid`              varchar(96),
  `provider_user_id` varchar(64),                                                -- 建单那一刻的贡献主人；追回打在他头上
  `reason`           varchar(32),                                                -- not_delivered/wrong_output/overcharged/forged/other
  `detail`           varchar(512),                                               -- 申诉人自述。界面明确劝阻粘贴请求内容 —— 那些平台本就不留存
  `status`           varchar(16),                                                -- open/reviewing/upheld/rejected/withdrawn
  `resolution`       varchar(512),                                               -- 运营的处理说明，会原样给到申诉人
  `refund_json`      varchar(512),                                               -- 实际退回的量，按计量单位。空表示成立但没有可退的钱
  `clawback_amount`  bigint DEFAULT 0,                                           -- 从提供者积分里扣回的金额
  `handled_by`       varchar(64),
  `handled_at`       timestamp NULL DEFAULT NULL,
  `created_time`     datetime(3) NULL,
  `updated_time`     datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_dispute_id` (`biz_line`,`dispute_id`),
  UNIQUE INDEX `uk_gx_dispute_unit` (`biz_line`,`unit_id`,`attempt`),
  INDEX `idx_gx_dispute_owner` (`biz_line`,`owner_user_id`,`created_time` desc),
  INDEX `idx_gx_dispute_status` (`biz_line`,`status`,`created_time` desc),
  INDEX `idx_gx_dispute_contribution` (`biz_line`,`cid`,`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- -------------------------------------------------------------------------
-- 6. 门户：对外的模型目录与「联系我们」线索
-- 这两张表是全站唯一被**未登录**的接口读写的东西（/api/galaxy/portal/*），
-- 所以字段刻意都短，且一个用户维度的列都没有。
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `zt_galaxy_model` (
  `id`                bigint AUTO_INCREMENT,
  `biz_line`          varchar(32),
  `model_id`          varchar(96),                                        -- 对外模型名，与 /v1/models 一致
  `display_name`      varchar(96),
  `vendor`            varchar(32),                                        -- anthropic/openai/google/…
  `family`            varchar(32),                                        -- 门户分栏用的族名
  `kind`              varchar(64),                                        -- 计价所属 kind，默认 llm.chat
  `context_tokens`    bigint DEFAULT 0,                                   -- 上下文窗口 token 数，0 表示未声明
  `max_output_tokens` bigint DEFAULT 0,
  `input_price`       bigint DEFAULT 0,                                   -- 每百万 input token 微分，0=按 kind 统一价
  `output_price`      bigint DEFAULT 0,                                   -- 每百万 output token 微分，0=按 kind 统一价
  `cache_price`       bigint DEFAULT 0,                                   -- 每百万 cache_read token 微分，0=按 kind 统一价
  `currency`          varchar(8) DEFAULT 'CNY',
  `tags_json`         varchar(512),                                       -- 能力标签，JSON 数组
  `summary`           varchar(256),                                       -- 一句话说明，门户卡片上那行
  `listed`            boolean DEFAULT true,
  `featured`          boolean DEFAULT false,                              -- 首页精选位
  `sort_order`        bigint DEFAULT 0,
  `created_time`      datetime(3) NULL,
  `updated_time`      datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_model` (`biz_line`,`model_id`),
  INDEX `idx_gx_model_listed` (`biz_line`,`listed`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_galaxy_lead` (
  `id`           bigint AUTO_INCREMENT,
  `biz_line`     varchar(32),
  `lead_id`      varchar(64),
  `name`         varchar(64),
  `contact`      varchar(128),                                            -- 邮箱/手机/微信，来访者自己选一种
  `company`      varchar(128),
  `topic`        varchar(32),                                             -- enterprise/support/business/other
  `scale`        varchar(32),                                             -- 预估用量档，来访者自述
  `message`      varchar(1000),
  `source`       varchar(32),                                             -- 来源页面，默认 portal
  `ip`           varchar(64),                                             -- 只为限流与排查，不进任何对外视图
  `user_agent`   varchar(256),
  `status`       varchar(16),                                             -- new/handled/closed
  `handled_by`   varchar(64),
  `handled_at`   timestamp NULL DEFAULT NULL,
  `created_time` datetime(3) NULL,
  `updated_time` datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_lead` (`biz_line`,`lead_id`),
  INDEX `idx_gx_lead_status` (`biz_line`,`status`,`created_time` desc),
  INDEX `idx_gx_lead_ip` (`biz_line`,`ip`,`created_time` desc)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
