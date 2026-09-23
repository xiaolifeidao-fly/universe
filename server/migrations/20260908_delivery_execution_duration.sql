-- 任务执行耗时：每一轮执行实例记开始与结束时刻，任务上留「最近一轮」和「累计」两个数。
--
-- 任务面板此前只知道任务跑成了什么样，不知道跑了多久：一条任务会被反复执行
-- （再做一次、追问、批量重跑），既要看最近一轮花了多久，也要看它到现在一共花了多久，
-- 需求进度页还要把全部任务加起来。会话行记一轮的起止，任务行做累计，两边分开存。
--
-- 全量脚本 delivery.sql 已同步，这里补一份增量供已有库执行。可重复执行。
DELIMITER $$

DROP PROCEDURE IF EXISTS `migrate_delivery_execution_duration`$$
CREATE PROCEDURE `migrate_delivery_execution_duration`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_item_execution_session'
      AND column_name = 'run_started_at'
  ) THEN
    ALTER TABLE `zt_delivery_item_execution_session`
      ADD COLUMN `run_started_at`        timestamp NULL COMMENT '本轮运行开始时间' AFTER `metadata_json`,
      ADD COLUMN `run_finished_at`       timestamp NULL COMMENT '本轮运行结束时间' AFTER `run_started_at`,
      ADD COLUMN `last_run_duration_ms`  bigint NOT NULL DEFAULT 0 COMMENT '最近一轮运行耗时毫秒' AFTER `run_finished_at`,
      ADD COLUMN `total_run_duration_ms` bigint NOT NULL DEFAULT 0 COMMENT '该会话历次运行累计耗时毫秒' AFTER `last_run_duration_ms`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_item'
      AND column_name = 'last_run_started_at'
  ) THEN
    ALTER TABLE `zt_delivery_item`
      ADD COLUMN `last_run_started_at`   timestamp NULL COMMENT '最近一轮执行开始时间' AFTER `progress`,
      ADD COLUMN `last_run_finished_at`  timestamp NULL COMMENT '最近一轮执行结束时间' AFTER `last_run_started_at`,
      ADD COLUMN `last_run_duration_ms`  bigint NOT NULL DEFAULT 0 COMMENT '最近一轮执行耗时毫秒' AFTER `last_run_finished_at`,
      ADD COLUMN `total_run_duration_ms` bigint NOT NULL DEFAULT 0 COMMENT '历次执行累计耗时毫秒' AFTER `last_run_duration_ms`,
      ADD COLUMN `run_count`             bigint NOT NULL DEFAULT 0 COMMENT '已结束的执行轮次数' AFTER `total_run_duration_ms`;
  END IF;
END$$

CALL `migrate_delivery_execution_duration`()$$
DROP PROCEDURE `migrate_delivery_execution_duration`$$

DELIMITER ;

-- 存量数据没有历史计时，一律从 0 起算：面板上「累计耗时」只统计这次上线之后跑过的轮次。
