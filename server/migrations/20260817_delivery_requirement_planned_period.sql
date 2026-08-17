-- 需求计划时间段。两列均为空表示尚未排期；完整性与前后顺序由服务层校验。
-- MySQL 没有 ADD COLUMN IF NOT EXISTS，使用 information_schema 使本迁移可重复执行。

DELIMITER $$

DROP PROCEDURE IF EXISTS `migrate_delivery_requirement_planned_period`$$
CREATE PROCEDURE `migrate_delivery_requirement_planned_period`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_requirement' AND column_name = 'planned_start_at'
  ) THEN
    ALTER TABLE `zt_delivery_requirement`
      ADD COLUMN `planned_start_at` timestamp NULL AFTER `detail`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_requirement' AND column_name = 'planned_end_at'
  ) THEN
    ALTER TABLE `zt_delivery_requirement`
      ADD COLUMN `planned_end_at` timestamp NULL AFTER `planned_start_at`;
  END IF;
END$$

CALL `migrate_delivery_requirement_planned_period`()$$
DROP PROCEDURE `migrate_delivery_requirement_planned_period`$$

DELIMITER ;
