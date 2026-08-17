-- 将存量交付数据从字符串项目编码迁移到 zt_delivery_program.id。
--
-- 适用对象：项目表和子表仍为旧字段 program_id varchar(64) 的库。
-- 新环境直接执行 server/delivery.sql 和 server/identity.sql，不要执行本文件。
--
-- 本迁移在删除任何旧列之前，会将回填后的 program_pk 改为 NOT NULL；存在无法映射的
-- 数据时这一步会失败，旧 program_id 列及其数据仍保留。修复映射后重新从该步执行即可。

-- 预检：项目编码必须全局唯一；有结果时先处理重复项目编码，不能继续迁移。
SELECT `program_id` AS `program_code`, COUNT(*) AS `total`
FROM `zt_delivery_program`
GROUP BY `program_id`
HAVING COUNT(*) > 1;

-- 在同一个 MySQL 会话内执行以下语句，临时映射表会在连接断开时自动删除。
CREATE TEMPORARY TABLE `tmp_dlv_program_id_map` AS
SELECT `id`, `program_id` AS `program_code`
FROM `zt_delivery_program`;

ALTER TABLE `zt_delivery_stage` ADD COLUMN `program_pk` bigint NULL AFTER `program_id`;
ALTER TABLE `zt_delivery_module` ADD COLUMN `program_pk` bigint NULL AFTER `program_id`;
ALTER TABLE `zt_delivery_requirement` ADD COLUMN `program_pk` bigint NULL AFTER `program_id`;
ALTER TABLE `zt_delivery_item` ADD COLUMN `program_pk` bigint NULL AFTER `program_id`;
ALTER TABLE `zt_delivery_item_execution_session` ADD COLUMN `program_pk` bigint NULL AFTER `program_id`;
ALTER TABLE `zt_delivery_item_dependency` ADD COLUMN `program_pk` bigint NULL AFTER `program_id`;
ALTER TABLE `zt_delivery_item_event` ADD COLUMN `program_pk` bigint NULL AFTER `program_id`;
ALTER TABLE `zt_delivery_snapshot` ADD COLUMN `program_pk` bigint NULL AFTER `program_id`;
ALTER TABLE `zt_identity_user_program` ADD COLUMN `program_pk` bigint NULL AFTER `program_id`;

UPDATE `zt_delivery_stage` c JOIN `tmp_dlv_program_id_map` p ON p.`program_code` = c.`program_id` SET c.`program_pk` = p.`id`;
UPDATE `zt_delivery_module` c JOIN `tmp_dlv_program_id_map` p ON p.`program_code` = c.`program_id` SET c.`program_pk` = p.`id`;
UPDATE `zt_delivery_requirement` c JOIN `tmp_dlv_program_id_map` p ON p.`program_code` = c.`program_id` SET c.`program_pk` = p.`id`;
UPDATE `zt_delivery_item` c JOIN `tmp_dlv_program_id_map` p ON p.`program_code` = c.`program_id` SET c.`program_pk` = p.`id`;
UPDATE `zt_delivery_item_execution_session` c JOIN `tmp_dlv_program_id_map` p ON p.`program_code` = c.`program_id` SET c.`program_pk` = p.`id`;
UPDATE `zt_delivery_item_dependency` c JOIN `tmp_dlv_program_id_map` p ON p.`program_code` = c.`program_id` SET c.`program_pk` = p.`id`;
UPDATE `zt_delivery_item_event` c JOIN `tmp_dlv_program_id_map` p ON p.`program_code` = c.`program_id` SET c.`program_pk` = p.`id`;
UPDATE `zt_delivery_snapshot` c JOIN `tmp_dlv_program_id_map` p ON p.`program_code` = c.`program_id` SET c.`program_pk` = p.`id`;
UPDATE `zt_identity_user_program` c JOIN `tmp_dlv_program_id_map` p ON p.`program_code` = c.`program_id` SET c.`program_pk` = p.`id`;

-- 预检结果都必须为 0。紧随其后的 NOT NULL 约束也会阻断任何遗漏数据的列替换。
SELECT 'zt_delivery_stage' AS `table_name`, COUNT(*) AS `unmapped` FROM `zt_delivery_stage` WHERE `program_pk` IS NULL
UNION ALL SELECT 'zt_delivery_module', COUNT(*) FROM `zt_delivery_module` WHERE `program_pk` IS NULL
UNION ALL SELECT 'zt_delivery_requirement', COUNT(*) FROM `zt_delivery_requirement` WHERE `program_pk` IS NULL
UNION ALL SELECT 'zt_delivery_item', COUNT(*) FROM `zt_delivery_item` WHERE `program_pk` IS NULL
UNION ALL SELECT 'zt_delivery_item_execution_session', COUNT(*) FROM `zt_delivery_item_execution_session` WHERE `program_pk` IS NULL
UNION ALL SELECT 'zt_delivery_item_dependency', COUNT(*) FROM `zt_delivery_item_dependency` WHERE `program_pk` IS NULL
UNION ALL SELECT 'zt_delivery_item_event', COUNT(*) FROM `zt_delivery_item_event` WHERE `program_pk` IS NULL
UNION ALL SELECT 'zt_delivery_snapshot', COUNT(*) FROM `zt_delivery_snapshot` WHERE `program_pk` IS NULL
UNION ALL SELECT 'zt_identity_user_program', COUNT(*) FROM `zt_identity_user_program` WHERE `program_pk` IS NULL;

ALTER TABLE `zt_delivery_stage` MODIFY COLUMN `program_pk` bigint NOT NULL;
ALTER TABLE `zt_delivery_module` MODIFY COLUMN `program_pk` bigint NOT NULL;
ALTER TABLE `zt_delivery_requirement` MODIFY COLUMN `program_pk` bigint NOT NULL;
ALTER TABLE `zt_delivery_item` MODIFY COLUMN `program_pk` bigint NOT NULL;
ALTER TABLE `zt_delivery_item_execution_session` MODIFY COLUMN `program_pk` bigint NOT NULL;
ALTER TABLE `zt_delivery_item_dependency` MODIFY COLUMN `program_pk` bigint NOT NULL;
ALTER TABLE `zt_delivery_item_event` MODIFY COLUMN `program_pk` bigint NOT NULL;
ALTER TABLE `zt_delivery_snapshot` MODIFY COLUMN `program_pk` bigint NOT NULL;
ALTER TABLE `zt_identity_user_program` MODIFY COLUMN `program_pk` bigint NOT NULL;

ALTER TABLE `zt_delivery_stage`
  DROP INDEX `uk_dlv_stage`, DROP INDEX `idx_dlv_stage_seq`, DROP COLUMN `program_id`,
  CHANGE COLUMN `program_pk` `program_id` bigint NOT NULL,
  ADD UNIQUE KEY `uk_dlv_stage` (`biz_line`, `program_id`, `stage_key`),
  ADD KEY `idx_dlv_stage_seq` (`biz_line`, `program_id`, `seq`);
ALTER TABLE `zt_delivery_module`
  DROP INDEX `uk_dlv_module`, DROP INDEX `idx_dlv_module_seq`, DROP COLUMN `program_id`,
  CHANGE COLUMN `program_pk` `program_id` bigint NOT NULL,
  ADD UNIQUE KEY `uk_dlv_module` (`biz_line`, `program_id`, `module_key`),
  ADD KEY `idx_dlv_module_seq` (`biz_line`, `program_id`, `seq`);
ALTER TABLE `zt_delivery_requirement`
  DROP INDEX `uk_dlv_requirement`, DROP INDEX `idx_dlv_requirement_program`, DROP COLUMN `program_id`,
  CHANGE COLUMN `program_pk` `program_id` bigint NOT NULL,
  ADD UNIQUE KEY `uk_dlv_requirement` (`biz_line`, `program_id`, `requirement_key`),
  ADD KEY `idx_dlv_requirement_program` (`biz_line`, `program_id`);
ALTER TABLE `zt_delivery_item`
  DROP INDEX `uk_dlv_item`, DROP INDEX `idx_dlv_item_board`, DROP INDEX `idx_dlv_item_module`,
  DROP INDEX `idx_dlv_item_requirement_key`, DROP INDEX `idx_dlv_item_requirement`,
  DROP INDEX `idx_dlv_item_development`, DROP INDEX `idx_dlv_item_testing`, DROP INDEX `idx_dlv_item_phase`,
  DROP COLUMN `program_id`, CHANGE COLUMN `program_pk` `program_id` bigint NOT NULL,
  ADD UNIQUE KEY `uk_dlv_item` (`biz_line`, `program_id`, `item_key`),
  ADD KEY `idx_dlv_item_board` (`biz_line`, `program_id`, `stage_key`, `status`),
  ADD KEY `idx_dlv_item_module` (`biz_line`, `program_id`, `module_key`, `status`),
  ADD KEY `idx_dlv_item_requirement_key` (`biz_line`, `program_id`, `requirement_key`),
  ADD KEY `idx_dlv_item_requirement` (`biz_line`, `program_id`, `requirement_status`),
  ADD KEY `idx_dlv_item_development` (`biz_line`, `program_id`, `development_status`),
  ADD KEY `idx_dlv_item_testing` (`biz_line`, `program_id`, `testing_status`),
  ADD KEY `idx_dlv_item_phase` (`biz_line`, `program_id`, `phase`, `status`);
ALTER TABLE `zt_delivery_item_execution_session`
  DROP INDEX `uk_dlv_item_exec`, DROP INDEX `idx_dlv_exec_status`, DROP COLUMN `program_id`,
  CHANGE COLUMN `program_pk` `program_id` bigint NOT NULL,
  ADD UNIQUE KEY `uk_dlv_item_exec` (`biz_line`, `program_id`, `item_key`, `executor_type`, `phase`),
  ADD KEY `idx_dlv_exec_status` (`biz_line`, `program_id`, `item_key`, `phase`, `status`);
ALTER TABLE `zt_delivery_item_dependency`
  DROP INDEX `uk_dlv_item_dep`, DROP INDEX `idx_dlv_item_dep_pre`, DROP INDEX `idx_dlv_item_dep_suc`,
  DROP COLUMN `program_id`, CHANGE COLUMN `program_pk` `program_id` bigint NOT NULL,
  ADD UNIQUE KEY `uk_dlv_item_dep` (`biz_line`, `program_id`, `predecessor_item_key`, `successor_item_key`),
  ADD KEY `idx_dlv_item_dep_pre` (`biz_line`, `program_id`, `predecessor_item_key`),
  ADD KEY `idx_dlv_item_dep_suc` (`biz_line`, `program_id`, `successor_item_key`);
ALTER TABLE `zt_delivery_item_event`
  DROP INDEX `idx_dlv_event_item`, DROP INDEX `idx_dlv_event_time`, DROP COLUMN `program_id`,
  CHANGE COLUMN `program_pk` `program_id` bigint NOT NULL,
  ADD KEY `idx_dlv_event_item` (`biz_line`, `program_id`, `item_key`),
  ADD KEY `idx_dlv_event_time` (`biz_line`, `program_id`, `created_time`);
ALTER TABLE `zt_delivery_snapshot`
  DROP INDEX `uk_dlv_snapshot`, DROP COLUMN `program_id`, CHANGE COLUMN `program_pk` `program_id` bigint NOT NULL,
  ADD UNIQUE KEY `uk_dlv_snapshot` (`biz_line`, `program_id`, `stat_date`, `module_key`);
ALTER TABLE `zt_identity_user_program`
  DROP INDEX `uk_identity_user_program`, DROP INDEX `idx_identity_user_program`, DROP COLUMN `program_id`,
  CHANGE COLUMN `program_pk` `program_id` bigint NOT NULL,
  ADD UNIQUE KEY `uk_identity_user_program` (`user_id`, `program_id`),
  ADD KEY `idx_identity_user_program` (`user_id`, `biz_line`, `program_id`);

ALTER TABLE `zt_delivery_program`
  DROP INDEX `uk_dlv_program`,
  CHANGE COLUMN `program_id` `program_code` varchar(64) NOT NULL,
  ADD UNIQUE KEY `uk_dlv_program_code` (`program_code`),
  ADD KEY `idx_dlv_program_biz_line` (`biz_line`);
