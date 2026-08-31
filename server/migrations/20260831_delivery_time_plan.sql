-- 时间计划：项目的交付时间窗口，在 Git 上对应一条从基准分支切出的发布分支
-- （默认 release/{截止日期}）。需求通过 zt_delivery_requirement.time_plan_key 弱引用它。
--
-- 全量脚本 delivery.sql 已包含这张表和这一列，这里补一份增量，供已有库执行。
-- 可重复执行。存量需求一律留空：猜出来的排期比空着更难纠正。

CREATE TABLE IF NOT EXISTS `zt_delivery_time_plan` (
  `id`              bigint       NOT NULL AUTO_INCREMENT,
  `biz_line`        varchar(32)  NOT NULL,
  `program_id`      bigint       NOT NULL,
  `plan_key`        varchar(64)  NOT NULL,
  `name`            varchar(255) NOT NULL DEFAULT '',
  `start_at`        timestamp    NULL,
  `end_at`          timestamp    NULL,
  `status`          varchar(16)  NOT NULL DEFAULT 'active',
  `base_branch`     varchar(255) NOT NULL DEFAULT '',
  `branch`          varchar(255) NOT NULL DEFAULT '',
  `branch_created_at` timestamp  NULL,
  `base_synced_at`  timestamp    NULL,
  `requirement_merged_at` timestamp NULL,
  `base_published_at` timestamp  NULL,
  `version`         bigint       NOT NULL DEFAULT 1,
  `created_by`      varchar(64)  NOT NULL DEFAULT '',
  `created_by_name` varchar(64)  NOT NULL DEFAULT '',
  `updated_by`      varchar(64)  NOT NULL DEFAULT '',
  `created_time`    timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_time`    timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dlv_time_plan` (`biz_line`, `program_id`, `plan_key`),
  KEY `idx_dlv_time_plan_end` (`biz_line`, `program_id`, `end_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'zt_delivery_requirement' AND COLUMN_NAME = 'time_plan_key'
);
SET @statement := IF(@column_exists = 0,
  'ALTER TABLE `zt_delivery_requirement` ADD COLUMN `time_plan_key` varchar(64) NOT NULL DEFAULT '''' AFTER `reference_item_keys`',
  'SELECT 1');
PREPARE migrate_column FROM @statement;
EXECUTE migrate_column;
DEALLOCATE PREPARE migrate_column;

SET @index_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'zt_delivery_requirement' AND INDEX_NAME = 'idx_dlv_requirement_time_plan'
);
SET @statement := IF(@index_exists = 0,
  'ALTER TABLE `zt_delivery_requirement` ADD KEY `idx_dlv_requirement_time_plan` (`biz_line`, `program_id`, `time_plan_key`)',
  'SELECT 1');
PREPARE migrate_index FROM @statement;
EXECUTE migrate_index;
DEALLOCATE PREPARE migrate_index;
