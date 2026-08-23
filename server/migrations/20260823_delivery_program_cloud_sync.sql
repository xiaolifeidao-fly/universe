-- 项目级云端同步：配置留在项目表，内容快照留在独立文件表。
-- 可重复执行，适用于已存在的 zt_delivery_program。

DELIMITER $$

DROP PROCEDURE IF EXISTS migrate_delivery_program_cloud_sync$$
CREATE PROCEDURE migrate_delivery_program_cloud_sync()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_program' AND column_name = 'cloud_sync_enabled'
  ) THEN
    ALTER TABLE `zt_delivery_program`
      ADD COLUMN `cloud_sync_enabled` boolean NOT NULL DEFAULT FALSE AFTER `git_base_branch`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_program' AND column_name = 'cloud_sync_scopes'
  ) THEN
    ALTER TABLE `zt_delivery_program`
      ADD COLUMN `cloud_sync_scopes` varchar(128) NOT NULL DEFAULT '' AFTER `cloud_sync_enabled`;
  END IF;
END$$
CALL migrate_delivery_program_cloud_sync()$$
DROP PROCEDURE migrate_delivery_program_cloud_sync$$

DELIMITER ;

CREATE TABLE IF NOT EXISTS `zt_delivery_cloud_sync_file` (
  `id`            bigint        NOT NULL AUTO_INCREMENT,
  `biz_line`      varchar(32)   NOT NULL,
  `program_id`    bigint        NOT NULL,
  `category`      varchar(16)   NOT NULL,
  `relative_path` varchar(1024) NOT NULL,
  `content_type`  varchar(128)  NOT NULL,
  `object_key`    varchar(1536) NOT NULL,
  `size`          bigint        NOT NULL,
  `sha256`        char(64)      NOT NULL,
  `updated_by`    varchar(64)   NOT NULL,
  `updated_time`  timestamp     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dlv_cloud_file` (`biz_line`, `program_id`, `category`, `relative_path`),
  KEY `idx_dlv_cloud_file_updated` (`biz_line`, `program_id`, `category`, `updated_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 早期云同步实现把正文存到了 MySQL。保留旧列避免在迁移时丢数据；
-- 新版本在 OSS 上传成功后只写 object_key，旧记录点击“立即同步”后即可迁入 OSS。
DELIMITER $$

DROP PROCEDURE IF EXISTS migrate_delivery_cloud_sync_to_oss$$
CREATE PROCEDURE migrate_delivery_cloud_sync_to_oss()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_cloud_sync_file' AND column_name = 'object_key'
  ) THEN
    ALTER TABLE `zt_delivery_cloud_sync_file`
      ADD COLUMN `object_key` varchar(1536) NOT NULL DEFAULT '' AFTER `content_type`;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_cloud_sync_file' AND column_name = 'content'
  ) THEN
    ALTER TABLE `zt_delivery_cloud_sync_file`
      MODIFY COLUMN `content` mediumblob NULL;
  END IF;
END$$
CALL migrate_delivery_cloud_sync_to_oss()$$
DROP PROCEDURE migrate_delivery_cloud_sync_to_oss$$

DELIMITER ;
