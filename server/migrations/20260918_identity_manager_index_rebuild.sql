-- 把 is_manager 并进用户—业务线 / 用户—项目的那两条索引。
--
-- 这件事做过两版。20260817_identity_scope_managers 当时是**另建**一条
-- idx_identity_user_bizline_manager，把 (user_id, biz_line, is_manager) 单独放一个索引；
-- 后来模型和 identity.sql 都改成了直接扩原来那条 idx_identity_user_bizline ——
-- 两条索引前缀完全重合，留着旧的那条只是让每次写入多维护一棵 B+ 树。
--
-- 于是线上卡在中间态：is_manager 这一列加上了，索引却停在两列的老样子，
-- 而 GORM 模型和 identity.sql 都写着三列。「按业务线查管理员」因此回表。
--
-- 扩列必须先 DROP 再 ADD：MySQL 没有原地给索引追加一列的写法，同名索引也不能共存。
-- 这两张表一共四十几行，重建是一瞬间的事；真正要紧的是别让中间那一刻没有索引可用，
-- 所以两句放在同一个存储过程里连着走完。
--
-- 幂等：跑之前先看线上那条索引到底是几列，已经是目标形态就整段跳过。

DELIMITER $$

DROP PROCEDURE IF EXISTS `migrate_identity_manager_index_rebuild`$$
CREATE PROCEDURE `migrate_identity_manager_index_rebuild`()
BEGIN
  -- zt_identity_user_biz_line：(user_id, biz_line) → (user_id, biz_line, is_manager)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'zt_identity_user_biz_line'
      AND index_name = 'idx_identity_user_bizline'
      AND column_name = 'is_manager'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = 'zt_identity_user_biz_line'
        AND index_name = 'idx_identity_user_bizline'
    ) THEN
      ALTER TABLE `zt_identity_user_biz_line` DROP INDEX `idx_identity_user_bizline`;
    END IF;
    ALTER TABLE `zt_identity_user_biz_line`
      ADD KEY `idx_identity_user_bizline` (`user_id`, `biz_line`, `is_manager`);
  END IF;

  -- zt_identity_user_program：(user_id, biz_line, program_id) → 末尾补 is_manager
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'zt_identity_user_program'
      AND index_name = 'idx_identity_user_program'
      AND column_name = 'is_manager'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = 'zt_identity_user_program'
        AND index_name = 'idx_identity_user_program'
    ) THEN
      ALTER TABLE `zt_identity_user_program` DROP INDEX `idx_identity_user_program`;
    END IF;
    ALTER TABLE `zt_identity_user_program`
      ADD KEY `idx_identity_user_program` (`user_id`, `biz_line`, `program_id`, `is_manager`);
  END IF;
END$$

DELIMITER ;

CALL `migrate_identity_manager_index_rebuild`();
DROP PROCEDURE IF EXISTS `migrate_identity_manager_index_rebuild`;
