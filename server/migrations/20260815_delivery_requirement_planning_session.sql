-- 需求拆解会话目录搬到服务端。
--
-- 桥接（delivery-task-planner 的本地 HTTP 进程）原来把「这条需求开过哪几轮拆解对话」
-- 只放在自己内存里，进程一重启，需求编辑页的聊天列表和聊天内容就一起空了。
-- 目录落到这张表上，正文仍然由 Codex / Claude 自己的会话缓存持有，按 thread_id 读回。
CREATE TABLE IF NOT EXISTS `zt_delivery_requirement_planning_session` (
  `id`              bigint       NOT NULL AUTO_INCREMENT,
  `biz_line`        varchar(32)  NOT NULL,
  `program_id`      bigint       NOT NULL,
  `requirement_key` varchar(64)  NOT NULL,
  `executor_type`   varchar(32)  NOT NULL,
  `thread_id`       varchar(255) NOT NULL,
  `title`           varchar(255) NOT NULL DEFAULT '',
  `status`          varchar(16)  NOT NULL DEFAULT 'running',
  `metadata_json`   mediumtext   NOT NULL,
  `version`         bigint       NOT NULL DEFAULT 1,
  `created_by`      varchar(64)  NOT NULL DEFAULT '',
  `updated_by`      varchar(64)  NOT NULL DEFAULT '',
  `created_time`    timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_time`    timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dlv_planning_session` (`biz_line`, `program_id`, `requirement_key`, `executor_type`, `thread_id`),
  KEY `idx_dlv_planning_program` (`program_id`, `requirement_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
