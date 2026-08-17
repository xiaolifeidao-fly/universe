-- 历史兼容迁移：补齐专业模式需求的原型开关与旧版原型任务标记。
-- 当前流程不再创建原型任务，HTML 原型关联到需求本身；prototype_task 仅保留存量数据兼容。
-- 本脚本可重复执行。
DELIMITER $$

DROP PROCEDURE IF EXISTS `migrate_delivery_requirement_prototype`$$
CREATE PROCEDURE `migrate_delivery_requirement_prototype`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'zt_delivery_requirement'
      AND column_name = 'generate_prototype'
  ) THEN
    ALTER TABLE `zt_delivery_requirement`
      ADD COLUMN `generate_prototype` boolean NOT NULL DEFAULT FALSE AFTER `start_phase`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'zt_delivery_item'
      AND column_name = 'prototype_task'
  ) THEN
    ALTER TABLE `zt_delivery_item`
      ADD COLUMN `prototype_task` boolean NOT NULL DEFAULT FALSE AFTER `kind`;
  END IF;
END$$

CALL `migrate_delivery_requirement_prototype`()$$
DROP PROCEDURE `migrate_delivery_requirement_prototype`$$

DELIMITER ;
