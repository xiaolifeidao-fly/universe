-- Web Push subscriptions are scoped to the authenticated app-api user.
-- The endpoint hash keeps the unique index bounded while the full endpoint
-- remains available only to the server-side push sender.

CREATE TABLE IF NOT EXISTS `zt_app_push_subscription` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `user_id` varchar(64) NOT NULL,
  `endpoint` varchar(2048) NOT NULL,
  `endpoint_hash` char(64) NOT NULL,
  `p256dh` varchar(512) NOT NULL,
  `auth` varchar(512) NOT NULL,
  `created_time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_app_push_subscription_endpoint` (`endpoint_hash`),
  KEY `idx_app_push_subscription_user` (`user_id`, `updated_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
