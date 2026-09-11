-- 提现与「本轮连续在线」。
--
-- 新环境直接跑 server/galaxy.sql 就够了，这份只给已经建过库的环境。
--
-- ADD COLUMN 上不能写 IF NOT EXISTS —— 那是 MariaDB 的扩展，MySQL 至今不认，
-- 8.0.36 上会直接 1064 语法错误，整份脚本卡在第一条。重复执行时它报 1060
-- （列已存在），忽略即可；建表那条有 IF NOT EXISTS，本来就可以重复跑。

ALTER TABLE `zt_galaxy_node`
  ADD COLUMN `online_since` timestamp NULL DEFAULT NULL AFTER `last_beat_at`;

CREATE TABLE IF NOT EXISTS `zt_galaxy_payout` (
  `id`            bigint AUTO_INCREMENT,
  `biz_line`      varchar(32),
  `payout_id`     varchar(64),
  `owner_user_id` varchar(64),
  `credits`       bigint,
  `amount`        bigint,
  `currency`      varchar(8) DEFAULT 'CNY',
  `fee`           bigint,
  `method`        varchar(16),
  `account`       varchar(128),
  `status`        varchar(16),
  `note`          varchar(256),
  `handled_by`    varchar(64),
  `handled_at`    timestamp NULL DEFAULT NULL,
  `created_time`  datetime(3) NULL,
  `updated_time`  datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_payout` (`biz_line`,`payout_id`),
  INDEX `idx_gx_payout_owner` (`biz_line`,`owner_user_id`,`status`,`created_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
