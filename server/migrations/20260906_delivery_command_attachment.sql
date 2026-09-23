-- Mobile task conversation uploads. Bytes are held by app-api until the
-- authenticated, mapped Worker downloads them; workspace paths are never stored.
CREATE TABLE IF NOT EXISTS `zt_delivery_command_attachment` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `biz_line` varchar(32) NOT NULL,
  `attachment_id` varchar(64) NOT NULL,
  `program_id` bigint NOT NULL,
  `user_id` varchar(64) NOT NULL,
  `item_key` varchar(128) NOT NULL,
  `name` varchar(160) NOT NULL,
  `content_type` varchar(128) NOT NULL,
  `size` bigint NOT NULL,
  `content` longblob NOT NULL,
  `created_time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dlv_command_attachment` (`biz_line`, `attachment_id`),
  KEY `idx_dlv_command_attachment_owner` (`biz_line`, `user_id`, `program_id`, `created_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
