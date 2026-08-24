-- 项目级 Git 聊天记录归档：由项目管理员显式开启后，本机桥接才会写入工作目录 chat/。
-- 可重复执行，适用于已存在的 zt_delivery_program。

DELIMITER $$

DROP PROCEDURE IF EXISTS migrate_delivery_program_git_chat_sync$$
CREATE PROCEDURE migrate_delivery_program_git_chat_sync()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_program' AND column_name = 'git_chat_sync_enabled'
  ) THEN
    ALTER TABLE `zt_delivery_program`
      ADD COLUMN `git_chat_sync_enabled` boolean NOT NULL DEFAULT FALSE AFTER `git_base_branch`;
  END IF;
END$$
CALL migrate_delivery_program_git_chat_sync()$$
DROP PROCEDURE migrate_delivery_program_git_chat_sync$$

DELIMITER ;
