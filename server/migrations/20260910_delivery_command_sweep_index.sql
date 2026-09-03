-- 命令表的巡检索引：租约回收与留存期清理改走以 state 打头的索引。
--
-- 这两条查询都是跨业务线、跨用户的定时巡检：
--   ListExpiredCommands  state IN ('leased','running') AND lease_expires_at <= ?
--   ListUnclaimedCommands / 留存期清理  state = ? AND updated_time <= ?
-- 原来的 idx_dlv_command_lease 以 biz_line 打头，而这些查询根本不带 biz_line，
-- 一条也用不上，只能全表扫描 + filesort。手机端会话页每几秒就落一条快照命令，
-- 表长得快，而领取命令时还会顺带跑一次租约回收 —— 扫描成本会直接压在领取延迟上。
--
-- 全量脚本 delivery.sql 已同步，这里补一份增量供已有库执行。可重复执行。
DELIMITER $$

DROP PROCEDURE IF EXISTS `migrate_delivery_command_sweep_index`$$
CREATE PROCEDURE `migrate_delivery_command_sweep_index`()
BEGIN
  -- 旧索引以 biz_line 打头，没有任何查询用得上它，直接换成 state 打头的那一条。
  IF EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_command'
      AND index_name = 'idx_dlv_command_lease' AND seq_in_index = 1 AND column_name = 'biz_line'
  ) THEN
    ALTER TABLE `zt_delivery_command` DROP INDEX `idx_dlv_command_lease`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_command'
      AND index_name = 'idx_dlv_command_lease'
  ) THEN
    ALTER TABLE `zt_delivery_command` ADD KEY `idx_dlv_command_lease` (`state`, `lease_expires_at`);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_command'
      AND index_name = 'idx_dlv_command_sweep'
  ) THEN
    ALTER TABLE `zt_delivery_command` ADD KEY `idx_dlv_command_sweep` (`state`, `updated_time`);
  END IF;
END$$

CALL `migrate_delivery_command_sweep_index`()$$
DROP PROCEDURE `migrate_delivery_command_sweep_index`$$

DELIMITER ;
