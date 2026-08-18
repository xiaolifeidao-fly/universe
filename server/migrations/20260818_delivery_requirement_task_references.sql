-- 历史兼容迁移：补齐需求详情里 @ 引用既有任务的任务键。
-- 列值形如 ,task-a,task-b,，与需求关联、负责人标识采用同一种存法。
-- 本脚本可重复执行。
DELIMITER $$

DROP PROCEDURE IF EXISTS `migrate_delivery_requirement_task_references`$$
CREATE PROCEDURE `migrate_delivery_requirement_task_references`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'zt_delivery_requirement'
      AND column_name = 'reference_item_keys'
  ) THEN
    ALTER TABLE `zt_delivery_requirement`
      ADD COLUMN `reference_item_keys` varchar(2048) NOT NULL DEFAULT '' AFTER `reference_requirement_keys`;
  END IF;
END$$

CALL `migrate_delivery_requirement_task_references`()$$
DROP PROCEDURE `migrate_delivery_requirement_task_references`$$

DELIMITER ;
