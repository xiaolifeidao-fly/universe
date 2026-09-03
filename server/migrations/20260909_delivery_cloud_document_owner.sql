-- 云端文档归属：文档跟着它所属的需求或任务走，并区分阶段。
-- 归属由本机桥接按工作目录约定识别后上报；识别不出来的留空，面板按项目级未归类展示。
-- 可重复执行；存量记录归属为空，重新执行一次云端同步即可回填。
--
-- 不使用 DELIMITER 与存储过程：DELIMITER 只是 mysql 命令行客户端的指令，
-- DataGrip / Navicat 等图形客户端会把它当成 SQL 报 1064。下面全是普通语句，任何客户端都能整段执行。

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_cloud_sync_file' AND column_name = 'owner_kind'
  ),
  'SELECT ''owner_kind already exists''',
  'ALTER TABLE `zt_delivery_cloud_sync_file` ADD COLUMN `owner_kind` varchar(16) NOT NULL DEFAULT '''' AFTER `content_type`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_cloud_sync_file' AND column_name = 'owner_key'
  ),
  'SELECT ''owner_key already exists''',
  'ALTER TABLE `zt_delivery_cloud_sync_file` ADD COLUMN `owner_key` varchar(64) NOT NULL DEFAULT '''' AFTER `owner_kind`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_cloud_sync_file' AND column_name = 'stage'
  ),
  'SELECT ''stage already exists''',
  'ALTER TABLE `zt_delivery_cloud_sync_file` ADD COLUMN `stage` varchar(24) NOT NULL DEFAULT '''' AFTER `owner_key`'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_cloud_sync_file'
      AND index_name = 'idx_dlv_cloud_file_owner'
  ),
  'SELECT ''idx_dlv_cloud_file_owner already exists''',
  'ALTER TABLE `zt_delivery_cloud_sync_file` ADD KEY `idx_dlv_cloud_file_owner` (`biz_line`, `program_id`, `owner_kind`, `owner_key`)'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
