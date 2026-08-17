-- =========================================================================
-- 业务线定义建表语句 · zt_bizline_*
--
-- 业务线是控制台数据的横切范围。项目管理、新建与迁移都会读取
-- zt_bizline_def 中 enabled=1 的记录作为可选项。
-- =========================================================================

CREATE TABLE IF NOT EXISTS `zt_bizline_def` (
  `id`           bigint       NOT NULL AUTO_INCREMENT,
  `code`         varchar(32)  NOT NULL,                    -- 业务线业务键，如 whatsapp / tiktok
  `name`         varchar(64)  NOT NULL,                    -- 控制台显示名称
  `enabled`      tinyint(1)   NOT NULL DEFAULT 1,          -- 是否可选用
  `created_time` timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_time` timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_bizline_def` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_bizline_capability` (
  `id`                bigint       NOT NULL AUTO_INCREMENT,
  `biz_line`          varchar(32)  NOT NULL,
  `capability_key`    varchar(64)  NOT NULL,
  `min_agent_version` varchar(32)  NOT NULL,
  `enabled`           tinyint(1)   NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_bizline_cap` (`biz_line`, `capability_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `zt_bizline_def` (`code`, `name`, `enabled`)
VALUES ('whatsapp', 'WhatsApp', 1)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`), `enabled` = VALUES(`enabled`);
