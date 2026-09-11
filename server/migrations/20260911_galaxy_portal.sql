-- 门户（未登录可见的那一面）：对外的模型目录与「联系我们」线索。
--
-- 新环境直接跑 server/galaxy.sql 就够了，这份只给已经建过库的环境。
-- 两条都是 CREATE TABLE IF NOT EXISTS，重复执行安全。
--
-- 目录表可以一行都不填：为空时门户回落到 galaxy.models 声明的那份清单，
-- 只显示模型名与按 kind 的统一单价。填了才有上下文长度、能力标签和排序。

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
