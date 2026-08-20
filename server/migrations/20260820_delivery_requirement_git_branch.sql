-- 需求级 Git 分支关联。Git 命令由本机桥接执行，数据库只记录用户确认过的关联结果。
-- 本脚本可重复执行，存量需求保持「未设置」，由前端回落到用户偏好里的默认值。
DELIMITER $$

DROP PROCEDURE IF EXISTS `migrate_delivery_requirement_git_branch`$$
CREATE PROCEDURE `migrate_delivery_requirement_git_branch`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_requirement' AND column_name = 'git_enabled'
  ) THEN
    ALTER TABLE `zt_delivery_requirement`
      ADD COLUMN `git_enabled` boolean NULL DEFAULT NULL AFTER `generate_prototype`;
  ELSEIF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_requirement'
      AND column_name = 'git_enabled' AND is_nullable = 'NO'
  ) THEN
    -- 该列曾经是 NOT NULL，未设置和明确关闭分不开。改成可空后，把本次功能上线前
    -- 留下的默认 FALSE（既没开启也没关联过分支）复位成 NULL，让它们回落到用户偏好。
    ALTER TABLE `zt_delivery_requirement`
      MODIFY COLUMN `git_enabled` boolean NULL DEFAULT NULL;
    UPDATE `zt_delivery_requirement`
      SET `git_enabled` = NULL
      WHERE `git_enabled` = FALSE AND `git_branch` = '' AND `git_base_branch` = '';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_requirement' AND column_name = 'git_base_branch'
  ) THEN
    ALTER TABLE `zt_delivery_requirement`
      ADD COLUMN `git_base_branch` varchar(255) NOT NULL DEFAULT '' AFTER `git_enabled`;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_requirement' AND column_name = 'git_branch'
  ) THEN
    ALTER TABLE `zt_delivery_requirement`
      ADD COLUMN `git_branch` varchar(255) NOT NULL DEFAULT '' AFTER `git_base_branch`;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_requirement' AND column_name = 'git_branch_created_at'
  ) THEN
    ALTER TABLE `zt_delivery_requirement`
      ADD COLUMN `git_branch_created_at` timestamp NULL AFTER `git_branch`;
  END IF;
END$$

CALL `migrate_delivery_requirement_git_branch`()$$
DROP PROCEDURE `migrate_delivery_requirement_git_branch`$$

DELIMITER ;
