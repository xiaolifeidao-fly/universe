-- 用户工作身份与业务需求独立表。
-- admin/member 仍是系统管理权限；persona 用逗号分隔保存一个或多个工作身份。

ALTER TABLE `zt_identity_user`
  ADD COLUMN `persona` varchar(32) NOT NULL DEFAULT 'product_research' AFTER `role`,
  ADD KEY `idx_identity_user_persona` (`persona`);

CREATE TABLE IF NOT EXISTS `zt_business_requirement` (
  `id`              bigint       NOT NULL AUTO_INCREMENT,
  `biz_line`        varchar(32)  NOT NULL,
  `program_id`      bigint       NOT NULL,
  `title`           varchar(255) NOT NULL,
  `detail`          mediumtext   NOT NULL,
  `status`          varchar(16)  NOT NULL DEFAULT 'submitted',
  `created_by`      varchar(64)  NOT NULL,
  `created_by_name` varchar(64)  NOT NULL,
  `created_time`    timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_time`    timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_business_requirement_program` (`biz_line`, `program_id`, `created_time`),
  KEY `idx_business_requirement_creator` (`biz_line`, `created_by`, `created_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_business_requirement_message` (
  `id`             bigint      NOT NULL AUTO_INCREMENT,
  `biz_line`       varchar(32) NOT NULL,
  `requirement_id` bigint      NOT NULL,
  `role`           varchar(16) NOT NULL,
  `content`        mediumtext  NOT NULL,
  `created_time`   timestamp   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_business_requirement_message` (`biz_line`, `requirement_id`, `created_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_business_requirement_document` (
  `id`             bigint       NOT NULL AUTO_INCREMENT,
  `biz_line`       varchar(32)  NOT NULL,
  `requirement_id` bigint       NOT NULL,
  `type`           varchar(32)  NOT NULL,
  `title`          varchar(255) NOT NULL,
  `content`        mediumtext   NOT NULL,
  `version`        bigint       NOT NULL,
  `created_time`   timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_business_requirement_document` (`biz_line`, `requirement_id`, `type`, `version`),
  KEY `idx_business_requirement_document` (`biz_line`, `requirement_id`, `created_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
