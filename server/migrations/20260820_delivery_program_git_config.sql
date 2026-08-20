-- 项目共享的 Git 策略。实际工作目录、当前分支和工作区改动只存在于开发者本机桥接，
-- 此处仅保存供校验与默认值使用的期望远端、远端名和基准分支。

DELIMITER $$

DROP PROCEDURE IF EXISTS `migrate_delivery_program_git_config`$$
CREATE PROCEDURE `migrate_delivery_program_git_config`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_program' AND column_name = 'git_repository_url'
  ) THEN
    ALTER TABLE `zt_delivery_program`
      ADD COLUMN `git_repository_url` varchar(512) NOT NULL DEFAULT '' AFTER `status`;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_program' AND column_name = 'git_remote_name'
  ) THEN
    ALTER TABLE `zt_delivery_program`
      ADD COLUMN `git_remote_name` varchar(64) NOT NULL DEFAULT 'origin' AFTER `git_repository_url`;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_program' AND column_name = 'git_base_branch'
  ) THEN
    ALTER TABLE `zt_delivery_program`
      ADD COLUMN `git_base_branch` varchar(255) NOT NULL DEFAULT '' AFTER `git_remote_name`;
  END IF;
END$$
CALL `migrate_delivery_program_git_config`()$$
DROP PROCEDURE `migrate_delivery_program_git_config`$$

DELIMITER ;
