-- 交付任务的需求、开发、测试三个阶段状态。
-- 旧总状态用于反填，保证已有面板与自动执行任务在升级后仍处于合理的阶段。
ALTER TABLE `zt_delivery_item`
  ADD COLUMN `requirement_status` varchar(16) NOT NULL DEFAULT 'todo' AFTER `execution_output`,
  ADD COLUMN `development_status` varchar(16) NOT NULL DEFAULT 'todo' AFTER `requirement_status`,
  ADD COLUMN `testing_status` varchar(16) NOT NULL DEFAULT 'todo' AFTER `development_status`,
  ADD KEY `idx_dlv_item_requirement` (`biz_line`, `program_id`, `requirement_status`),
  ADD KEY `idx_dlv_item_development` (`biz_line`, `program_id`, `development_status`),
  ADD KEY `idx_dlv_item_testing` (`biz_line`, `program_id`, `testing_status`);

UPDATE `zt_delivery_item`
SET
  `requirement_status` = CASE
    WHEN `status` = 'done' THEN 'done'
    WHEN `status` IN ('doing', 'blocked') THEN 'done'
    WHEN `status` = 'dropped' THEN 'dropped'
    ELSE 'todo'
  END,
  `development_status` = CASE
    WHEN `status` = 'done' THEN 'done'
    WHEN `status` = 'doing' THEN 'doing'
    WHEN `status` = 'blocked' THEN 'blocked'
    WHEN `status` = 'dropped' THEN 'dropped'
    ELSE 'todo'
  END,
  `testing_status` = CASE
    WHEN `status` = 'done' THEN 'done'
    WHEN `status` = 'dropped' THEN 'dropped'
    ELSE 'todo'
  END;
