-- 为既有的用户—业务线 / 用户—项目授权补充管理员标记。
-- 管理员关系仍是对应资源的成员关系，不新增跨域外键。

DELIMITER $$

DROP PROCEDURE IF EXISTS `migrate_identity_scope_managers`$$
CREATE PROCEDURE `migrate_identity_scope_managers`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'zt_identity_user_biz_line'
      AND column_name = 'is_manager'
  ) THEN
    ALTER TABLE `zt_identity_user_biz_line`
      ADD COLUMN `is_manager` tinyint(1) NOT NULL DEFAULT 0 AFTER `biz_line`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'zt_identity_user_biz_line'
      AND index_name = 'idx_identity_user_bizline_manager'
  ) THEN
    ALTER TABLE `zt_identity_user_biz_line`
      ADD KEY `idx_identity_user_bizline_manager` (`user_id`, `biz_line`, `is_manager`);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'zt_identity_user_program'
      AND column_name = 'is_manager'
  ) THEN
    ALTER TABLE `zt_identity_user_program`
      ADD COLUMN `is_manager` tinyint(1) NOT NULL DEFAULT 0 AFTER `program_id`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'zt_identity_user_program'
      AND index_name = 'idx_identity_user_program_manager'
  ) THEN
    ALTER TABLE `zt_identity_user_program`
      ADD KEY `idx_identity_user_program_manager` (`user_id`, `biz_line`, `program_id`, `is_manager`);
  END IF;
END$$

CALL `migrate_identity_scope_managers`()$$
DROP PROCEDURE `migrate_identity_scope_managers`$$

DELIMITER ;
