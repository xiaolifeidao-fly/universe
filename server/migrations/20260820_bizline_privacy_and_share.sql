-- 空间隐私设置、成员读写权与分享链接。
-- 存量成员一律按写入处理：改造之前他们本来就能写，不该因为迁移被降级。

ALTER TABLE `zt_bizline_def`
  ADD COLUMN `description` varchar(512) NOT NULL DEFAULT '' AFTER `name`,
  ADD COLUMN `visible` tinyint(1) NOT NULL DEFAULT 1 AFTER `enabled`;

ALTER TABLE `zt_identity_user_biz_line`
  ADD COLUMN `can_write` tinyint(1) NOT NULL DEFAULT 0 AFTER `is_manager`;

UPDATE `zt_identity_user_biz_line` SET `can_write` = 1;

CREATE TABLE IF NOT EXISTS `zt_bizline_share_link` (
  `id`           bigint       NOT NULL AUTO_INCREMENT,
  `token`        varchar(64)  NOT NULL,
  `biz_line`     varchar(32)  NOT NULL,
  `permission`   varchar(16)  NOT NULL,
  `created_by`   varchar(64)  NOT NULL DEFAULT '',
  `expires_at`   timestamp    NOT NULL,
  `created_time` timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_bizline_share_token` (`token`),
  KEY `idx_bizline_share_line` (`biz_line`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
