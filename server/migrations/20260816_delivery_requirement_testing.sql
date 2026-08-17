-- 需求总体测试：独立于单条任务的成品测试。报告正文同时落在项目工作区
-- doc/test/<requirement_key>/测试报告.md，数据库保存内容和元数据供面板展示。
-- MySQL 不支持 ADD COLUMN IF NOT EXISTS，使用 information_schema 保证迁移可重复执行。

DELIMITER $$

DROP PROCEDURE IF EXISTS `migrate_delivery_requirement_testing`$$
CREATE PROCEDURE `migrate_delivery_requirement_testing`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_requirement' AND column_name = 'testing_status'
  ) THEN
    ALTER TABLE `zt_delivery_requirement`
      ADD COLUMN `testing_status` varchar(16) NOT NULL DEFAULT 'todo' AFTER `prototype_generated_at`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_requirement' AND column_name = 'testing_report'
  ) THEN
    ALTER TABLE `zt_delivery_requirement`
      ADD COLUMN `testing_report` mediumtext NOT NULL AFTER `testing_status`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_requirement' AND column_name = 'testing_report_path'
  ) THEN
    ALTER TABLE `zt_delivery_requirement`
      ADD COLUMN `testing_report_path` varchar(512) NOT NULL DEFAULT '' AFTER `testing_report`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_requirement' AND column_name = 'testing_reported_at'
  ) THEN
    ALTER TABLE `zt_delivery_requirement`
      ADD COLUMN `testing_reported_at` timestamp NULL AFTER `testing_report_path`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_requirement' AND index_name = 'idx_dlv_requirement_testing'
  ) THEN
    ALTER TABLE `zt_delivery_requirement`
      ADD KEY `idx_dlv_requirement_testing` (`biz_line`, `program_id`, `testing_status`);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_requirement' AND column_name = 'testing_cases_status'
  ) THEN
    ALTER TABLE `zt_delivery_requirement`
      ADD COLUMN `testing_cases_status` varchar(16) NOT NULL DEFAULT 'todo' AFTER `testing_reported_at`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_requirement' AND column_name = 'testing_cases'
  ) THEN
    ALTER TABLE `zt_delivery_requirement`
      ADD COLUMN `testing_cases` mediumtext NOT NULL AFTER `testing_cases_status`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_requirement' AND column_name = 'testing_cases_path'
  ) THEN
    ALTER TABLE `zt_delivery_requirement`
      ADD COLUMN `testing_cases_path` varchar(512) NOT NULL DEFAULT '' AFTER `testing_cases`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_requirement' AND index_name = 'idx_dlv_requirement_testing_cases'
  ) THEN
    ALTER TABLE `zt_delivery_requirement`
      ADD KEY `idx_dlv_requirement_testing_cases` (`biz_line`, `program_id`, `testing_cases_status`);
  END IF;
END$$

CALL `migrate_delivery_requirement_testing`()$$
DROP PROCEDURE `migrate_delivery_requirement_testing`$$

DELIMITER ;

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
