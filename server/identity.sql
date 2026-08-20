-- Console identity and scope assignment tables. Run before enabling real login.
CREATE TABLE IF NOT EXISTS `zt_identity_user` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `username` varchar(64) NOT NULL,
  `display_name` varchar(128) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `role` varchar(16) NOT NULL,
  `status` varchar(16) NOT NULL,
  `must_change_password` tinyint(1) NOT NULL DEFAULT 0,
  `token_version` bigint NOT NULL DEFAULT 1,
  `last_login_at` timestamp NULL,
  `created_time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_identity_user_username` (`username`),
  KEY `idx_identity_user_status` (`role`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_identity_user_biz_line` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `user_id` bigint NOT NULL,
  `biz_line` varchar(32) NOT NULL,
  `is_manager` tinyint(1) NOT NULL DEFAULT 0,
  `can_write` tinyint(1) NOT NULL DEFAULT 0,
  `created_time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_identity_user_bizline` (`user_id`, `biz_line`),
  KEY `idx_identity_user_bizline` (`user_id`, `biz_line`, `is_manager`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_identity_user_program` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `user_id` bigint NOT NULL,
  `biz_line` varchar(32) NOT NULL,
  `program_id` bigint NOT NULL,
  `is_manager` tinyint(1) NOT NULL DEFAULT 0,
  `created_time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_identity_user_program` (`user_id`, `program_id`),
  KEY `idx_identity_user_program` (`user_id`, `biz_line`, `program_id`, `is_manager`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
