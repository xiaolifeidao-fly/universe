-- 历史兼容迁移：补齐需求的「是否拆解任务」开关。
-- 存量需求一律按已有行为（拆成多条任务）处理，所以默认值为 TRUE。
-- 本脚本可重复执行。
DELIMITER $$

DROP PROCEDURE IF EXISTS `migrate_delivery_requirement_split_tasks`$$
CREATE PROCEDURE `migrate_delivery_requirement_split_tasks`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'zt_delivery_requirement'
      AND column_name = 'split_tasks'
  ) THEN
    ALTER TABLE `zt_delivery_requirement`
      ADD COLUMN `split_tasks` boolean NOT NULL DEFAULT TRUE AFTER `start_phase`;
  END IF;
END$$

CALL `migrate_delivery_requirement_split_tasks`()$$
DROP PROCEDURE `migrate_delivery_requirement_split_tasks`$$

DELIMITER ;
