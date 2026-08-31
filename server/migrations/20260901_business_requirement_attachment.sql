-- 业务访谈的图片与文档附件。文件本体留在远端 Kodes 的业务工作目录里，
-- 这里只记录清单：谁在哪条诉求上传了什么，以及它最终挂在哪条消息上。
-- message_id 为 0 表示已上传但还没随消息发出。

CREATE TABLE IF NOT EXISTS `zt_business_requirement_attachment` (
  `id`             bigint       NOT NULL AUTO_INCREMENT,
  `biz_line`       varchar(32)  NOT NULL,
  `requirement_id` bigint       NOT NULL,
  `message_id`     bigint       NOT NULL DEFAULT 0,
  `remote_id`      varchar(128) NOT NULL,
  `name`           varchar(255) NOT NULL,
  `content_type`   varchar(128) NOT NULL DEFAULT 'application/octet-stream',
  `size`           bigint       NOT NULL DEFAULT 0,
  `is_image`       tinyint(1)   NOT NULL DEFAULT 0,
  `created_by`     varchar(64)  NOT NULL,
  `created_time`   timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_business_requirement_attachment_remote` (`remote_id`),
  KEY `idx_business_requirement_attachment` (`biz_line`, `requirement_id`, `created_time`),
  KEY `idx_business_requirement_attachment_message` (`message_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
