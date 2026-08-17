-- 交付任务使用单一当前阶段，且每个 Codex 运行实例记录所属阶段与进度。
-- 旧的 requirement/development/testing 三列保留作历史数据兼容，不再作为看板依据。
ALTER TABLE `zt_delivery_item`
  ADD COLUMN `phase` varchar(16) NOT NULL DEFAULT 'requirement' AFTER `execution_output`,
  ADD COLUMN `requirement_document_path` varchar(512) NOT NULL DEFAULT '' AFTER `requirement_document`,
  ADD COLUMN `action_output` mediumtext NOT NULL AFTER `execution_output`,
  ADD COLUMN `testing_report` mediumtext NOT NULL AFTER `action_output`,
  ADD KEY `idx_dlv_item_phase` (`biz_line`, `program_id`, `phase`, `status`);

UPDATE `zt_delivery_item`
SET
  `phase` = CASE
    WHEN `requirement_status` <> 'done' THEN 'requirement'
    WHEN `development_status` <> 'done' THEN 'development'
    ELSE 'testing'
  END,
  `status` = CASE
    WHEN `requirement_status` <> 'done' THEN `requirement_status`
    WHEN `development_status` <> 'done' THEN `development_status`
    ELSE `testing_status`
  END,
  `requirement_document_path` = CONCAT('doc/', COALESCE(`module_key`, ''), '/', COALESCE(`item_key`, ''), '/文档.md'),
  `action_output` = COALESCE(`execution_output`, '')
WHERE `phase` = 'requirement' OR `requirement_document_path` = '';

ALTER TABLE `zt_delivery_item_execution_session`
  ADD COLUMN `phase` varchar(16) NOT NULL DEFAULT 'development' AFTER `executor_type`,
  ADD COLUMN `progress` bigint NOT NULL DEFAULT 0 AFTER `status`,
  DROP INDEX `uk_dlv_item_exec`,
  ADD UNIQUE KEY `uk_dlv_item_exec` (`biz_line`, `program_id`, `item_key`, `executor_type`, `phase`),
  DROP INDEX `idx_dlv_exec_status`,
  ADD KEY `idx_dlv_exec_status` (`biz_line`, `program_id`, `item_key`, `phase`, `status`);

UPDATE `zt_delivery_item_execution_session` AS session
JOIN `zt_delivery_item` AS item
  ON item.`biz_line` = session.`biz_line`
  AND item.`program_id` = session.`program_id`
  AND item.`item_key` = session.`item_key`
SET session.`phase` = item.`phase`;
