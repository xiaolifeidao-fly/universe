-- 执行批次与批次任务：任务面板批量/串行执行的服务端事实。
-- 全量脚本 delivery.sql 已包含这两张表，这里补一份增量，供已有库执行。
-- 可重复执行。

CREATE TABLE IF NOT EXISTS `zt_delivery_execution_batch` (
  `id`                     bigint       NOT NULL AUTO_INCREMENT,
  `biz_line`               varchar(32)  NOT NULL,
  `program_id`             bigint       NOT NULL,
  `batch_id`               varchar(64)  NOT NULL,
  `requirement_key`        varchar(64)  NOT NULL,
  `requirement_name`       varchar(255) NOT NULL,
  `requirement_git_branch` varchar(255) NOT NULL,
  `mode`                   varchar(16)  NOT NULL,
  `executor_type`          varchar(32)  NOT NULL,
  `status`                 varchar(16)  NOT NULL,
  `item_count`             bigint       NOT NULL,
  `completed_count`        bigint       NOT NULL,
  `blocked_count`          bigint       NOT NULL,
  `summary`                varchar(2048) NOT NULL,
  `notification_read_at`   timestamp    NULL,
  `heartbeat_at`           timestamp    NULL,
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

CREATE TABLE IF NOT EXISTS `zt_delivery_execution_batch_item` (
  `id`           bigint      NOT NULL AUTO_INCREMENT,
  `biz_line`     varchar(32) NOT NULL,
  `program_id`   bigint      NOT NULL,
  `batch_id`     varchar(64) NOT NULL,
  `item_key`     varchar(64) NOT NULL,
  `sequence`     bigint      NOT NULL,
  `status`       varchar(16) NOT NULL,
  `message`      varchar(1024) NOT NULL,
  `created_time` timestamp   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_time` timestamp   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dlv_execution_batch_item` (`biz_line`, `program_id`, `batch_id`, `item_key`),
  KEY `idx_dlv_execution_batch_item_active` (`biz_line`, `program_id`, `batch_id`, `item_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
