-- 项目与任务之间补上「需求」这一层：一次拆解产出一批任务，这批任务共享同一个需求键。
-- 存量任务的 requirement_key 留空，表示需求层落地之前建的任务，看板照常显示。
--
-- owner_ids / assistant_ids 存成 ,1,2, 这种前后都带逗号的形式：
-- 「和我有关的需求」用 LIKE '%,3,%' 就能命中，且不会把 13、23 误捞进来。
CREATE TABLE IF NOT EXISTS `zt_delivery_requirement` (
  `id`              bigint       NOT NULL AUTO_INCREMENT,
  `biz_line`        varchar(32)  NOT NULL,
  `program_id`      varchar(64)  NOT NULL,
  `requirement_key` varchar(64)  NOT NULL,
  `name`            varchar(255) NOT NULL,
  `detail`          mediumtext   NOT NULL,
  `status`          varchar(16)  NOT NULL DEFAULT 'open',
  `mode`            varchar(16)  NOT NULL DEFAULT 'professional',
  `start_phase`     varchar(16)  NOT NULL DEFAULT 'requirement',
  `owner_ids`       varchar(512) NOT NULL,
  `owner_names`     varchar(512) NOT NULL,
  `assistant_ids`   varchar(512) NOT NULL,
  `assistant_names` varchar(512) NOT NULL,
  `version`         bigint       NOT NULL DEFAULT 1,
  `created_by`      varchar(64)  NOT NULL,
  `created_by_name` varchar(64)  NOT NULL,
  `updated_by`      varchar(64)  NOT NULL,
  `created_time`    timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_time`    timestamp    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_dlv_requirement` (`biz_line`, `program_id`, `requirement_key`),
  KEY `idx_dlv_requirement_program` (`biz_line`, `program_id`),
  KEY `idx_dlv_requirement_creator` (`created_by`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE `zt_delivery_item`
  ADD COLUMN `requirement_key` varchar(64) NOT NULL DEFAULT '' AFTER `module_key`,
  ADD KEY `idx_dlv_item_requirement_key` (`biz_line`, `program_id`, `requirement_key`);
