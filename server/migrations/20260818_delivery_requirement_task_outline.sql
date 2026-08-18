-- 历史兼容迁移：补齐需求的「每个任务生成需求大纲」开关。
-- 存量需求默认关闭，只保留需求级大纲，避免每条任务都多出一份文档。
-- 本脚本可重复执行。
DELIMITER $$

DROP PROCEDURE IF EXISTS `migrate_delivery_requirement_task_outline`$$
CREATE PROCEDURE `migrate_delivery_requirement_task_outline`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'zt_delivery_requirement'
      AND column_name = 'generate_task_outline'
  ) THEN
    ALTER TABLE `zt_delivery_requirement`
      ADD COLUMN `generate_task_outline` boolean NOT NULL DEFAULT FALSE AFTER `split_tasks`;
  END IF;
END$$

CALL `migrate_delivery_requirement_task_outline`()$$
DROP PROCEDURE `migrate_delivery_requirement_task_outline`$$

DELIMITER ;
