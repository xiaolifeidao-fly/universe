-- 需求拆解批次：一次「拆解并写入任务」算一批，任务侧冻结来源批次键（非必填）。
-- 全量脚本 delivery.sql 已包含这张表和这一列，这里补一份增量，供已有库执行。
-- 可重复执行。

CREATE TABLE IF NOT EXISTS `zt_delivery_requirement_planning_batch` (
  `id`              bigint       NOT NULL AUTO_INCREMENT,
  `biz_line`        varchar(32)  NOT NULL,
  `program_id`      bigint       NOT NULL,
  `batch_key`       varchar(64)  NOT NULL,
  `requirement_key` varchar(64)  NOT NULL,
  `seq`             bigint       NOT NULL DEFAULT 1,
  `title`           varchar(255) NOT NULL DEFAULT '',
  `source`          varchar(16)  NOT NULL DEFAULT 'planner',
  `executor_type`   varchar(32)  NOT NULL DEFAULT '',
  `thread_id`       varchar(255) NOT NULL DEFAULT '',
  `summary`         varchar(1024) NOT NULL DEFAULT '',
  `item_count`      bigint       NOT NULL DEFAULT 0,
  `created_by`      varchar(64)  NOT NULL DEFAULT '',
  `created_by_name` varchar(64)  NOT NULL DEFAULT '',
  `updated_by`      varchar(64)  NOT NULL DEFAULT '',
  `created_time`    timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_time`    timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dlv_planning_batch` (`biz_line`, `program_id`, `batch_key`),
  KEY `idx_dlv_planning_batch_req` (`biz_line`, `program_id`, `requirement_key`, `seq`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 存量任务不归批：这一列留空即可，不做任何回填猜测。
SET @column_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'zt_delivery_item' AND COLUMN_NAME = 'planning_batch_key'
);
SET @statement := IF(@column_exists = 0,
  'ALTER TABLE `zt_delivery_item` ADD COLUMN `planning_batch_key` varchar(64) NOT NULL DEFAULT '''' AFTER `requirement_key`',
  'SELECT 1');
PREPARE migrate_column FROM @statement;
EXECUTE migrate_column;
DEALLOCATE PREPARE migrate_column;

SET @index_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'zt_delivery_item' AND INDEX_NAME = 'idx_dlv_item_planning_batch'
);
SET @statement := IF(@index_exists = 0,
  'ALTER TABLE `zt_delivery_item` ADD KEY `idx_dlv_item_planning_batch` (`biz_line`, `program_id`, `planning_batch_key`)',
  'SELECT 1');
PREPARE migrate_index FROM @statement;
EXECUTE migrate_index;
DEALLOCATE PREPARE migrate_index;
