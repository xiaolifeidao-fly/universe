-- 用户命令中心：MySQL 是命令、租约和审计的权威来源；Redis 仅保存短时领取通知。
-- 本文件可重复执行。不要在这里保存 Worker 本机绝对路径、用户令牌或 Redis 结果。

CREATE TABLE IF NOT EXISTS `zt_delivery_command` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `biz_line` varchar(32) NOT NULL,
  `command_id` varchar(64) NOT NULL,
  `program_id` bigint NOT NULL,
  `user_id` varchar(64) NOT NULL,
  `command_type` varchar(64) NOT NULL,
  `idempotency_key` varchar(128) NOT NULL,
  `input_json` mediumtext NOT NULL,
  `result_json` mediumtext NOT NULL,
  `error_message` varchar(1024) NOT NULL DEFAULT '',
  `state` varchar(16) NOT NULL,
  `progress` int NOT NULL DEFAULT 0,
  `cancel_requested` boolean NOT NULL DEFAULT FALSE,
  `lease_token` varchar(64) NOT NULL DEFAULT '',
  `lease_worker_id` varchar(64) NOT NULL DEFAULT '',
  `lease_expires_at` timestamp NULL,
  `dispatch_count` int NOT NULL DEFAULT 1,
  `attempt_count` int NOT NULL DEFAULT 0,
  `started_at` timestamp NULL,
  `finished_at` timestamp NULL,
  `version` bigint NOT NULL DEFAULT 1,
  `created_time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dlv_command_id` (`biz_line`, `command_id`),
  UNIQUE KEY `uk_dlv_command_idempotency` (`biz_line`, `user_id`, `idempotency_key`),
  KEY `idx_dlv_command_queue` (`biz_line`, `user_id`, `state`, `program_id`, `created_time`),
  KEY `idx_dlv_command_user` (`biz_line`, `user_id`, `program_id`, `state`),
  KEY `idx_dlv_command_lease` (`biz_line`, `lease_expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_delivery_command_event` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `biz_line` varchar(32) NOT NULL,
  `command_id` varchar(64) NOT NULL,
  `user_id` varchar(64) NOT NULL,
  `kind` varchar(32) NOT NULL,
  `state` varchar(16) NOT NULL,
  `message` varchar(1024) NOT NULL DEFAULT '',
  `data_json` mediumtext NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_dlv_command_event_stream` (`biz_line`, `command_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_delivery_command_worker` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `biz_line` varchar(32) NOT NULL,
  `user_id` varchar(64) NOT NULL,
  `worker_id` varchar(64) NOT NULL,
  `display_name` varchar(128) NOT NULL DEFAULT '',
  `capabilities_json` text NOT NULL,
  `last_heartbeat_at` timestamp NOT NULL,
  `created_time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dlv_command_worker` (`biz_line`, `user_id`, `worker_id`),
  KEY `idx_dlv_command_worker_heartbeat` (`biz_line`, `user_id`, `worker_id`, `last_heartbeat_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_delivery_command_worker_workspace` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `biz_line` varchar(32) NOT NULL,
  `user_id` varchar(64) NOT NULL,
  `worker_id` varchar(64) NOT NULL,
  `program_id` bigint NOT NULL,
  `created_time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dlv_command_workspace` (`biz_line`, `user_id`, `worker_id`, `program_id`),
  KEY `idx_dlv_command_workspace_worker` (`biz_line`, `user_id`, `worker_id`, `program_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
