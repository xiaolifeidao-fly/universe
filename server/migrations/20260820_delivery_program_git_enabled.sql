-- 为存量交付项目增加项目级 Git 能力开关。
-- 可重复执行；存量项目默认关闭，原有仓库地址和基准分支会被保留。

DELIMITER $$

DROP PROCEDURE IF EXISTS `migrate_delivery_program_git_enabled`$$
CREATE PROCEDURE `migrate_delivery_program_git_enabled`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_program' AND column_name = 'git_enabled'
  ) THEN
    ALTER TABLE `zt_delivery_program`
      ADD COLUMN `git_enabled` boolean NOT NULL DEFAULT FALSE AFTER `status`;
  END IF;
END$$
CALL `migrate_delivery_program_git_enabled`()$$
DROP PROCEDURE `migrate_delivery_program_git_enabled`$$

DELIMITER ;
