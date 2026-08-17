-- 需求编辑需要回显拆解时选择的阶段、模块和任务类型。
-- 存量需求没有这组上下文，统一用空串表示未指定。
--
-- 这份补丁可能在部分环境已经执行过；用 information_schema 检查后再 ADD，
-- 避免重复执行时中断，也避免前两列已存在导致 kind 被漏加。
DELIMITER $$

DROP PROCEDURE IF EXISTS `migrate_delivery_requirement_context`$$
CREATE PROCEDURE `migrate_delivery_requirement_context`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'zt_delivery_requirement'
      AND column_name = 'stage_key'
  ) THEN
    ALTER TABLE `zt_delivery_requirement`
      ADD COLUMN `stage_key` varchar(64) NOT NULL DEFAULT '' AFTER `start_phase`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'zt_delivery_requirement'
      AND column_name = 'module_key'
  ) THEN
    ALTER TABLE `zt_delivery_requirement`
      ADD COLUMN `module_key` varchar(64) NOT NULL DEFAULT '' AFTER `stage_key`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'zt_delivery_requirement'
      AND column_name = 'kind'
  ) THEN
    ALTER TABLE `zt_delivery_requirement`
      ADD COLUMN `kind` varchar(16) NOT NULL DEFAULT '' AFTER `module_key`;
  END IF;
END$$

CALL `migrate_delivery_requirement_context`()$$
DROP PROCEDURE `migrate_delivery_requirement_context`$$

DELIMITER ;
