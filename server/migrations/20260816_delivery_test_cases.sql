-- 测试用例设计与真实测试执行分开：研发进行期间可以生成用例，不能因此改变任务/需求的测试结论。
-- 用例正文的权威工作区副本分别是 doc/test/<item_key>/测试用例.md 与 doc/test/<requirement_key>/测试用例.md。
-- MySQL 没有 ADD COLUMN IF NOT EXISTS，使用 information_schema 使本迁移可重复执行。

DELIMITER $$

DROP PROCEDURE IF EXISTS `migrate_delivery_test_cases`$$
CREATE PROCEDURE `migrate_delivery_test_cases`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_requirement' AND column_name = 'testing_cases_status'
  ) THEN
    ALTER TABLE `zt_delivery_requirement`
      ADD COLUMN `testing_cases_status` varchar(16) NOT NULL DEFAULT 'todo' AFTER `testing_reported_at`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_requirement' AND column_name = 'testing_cases'
  ) THEN
    ALTER TABLE `zt_delivery_requirement`
      ADD COLUMN `testing_cases` mediumtext NOT NULL AFTER `testing_cases_status`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_requirement' AND column_name = 'testing_cases_path'
  ) THEN
    ALTER TABLE `zt_delivery_requirement`
      ADD COLUMN `testing_cases_path` varchar(512) NOT NULL DEFAULT '' AFTER `testing_cases`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_requirement' AND index_name = 'idx_dlv_requirement_testing_cases'
  ) THEN
    ALTER TABLE `zt_delivery_requirement`
      ADD KEY `idx_dlv_requirement_testing_cases` (`biz_line`, `program_id`, `testing_cases_status`);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_item' AND column_name = 'testing_cases_status'
  ) THEN
    ALTER TABLE `zt_delivery_item`
      ADD COLUMN `testing_cases_status` varchar(16) NOT NULL DEFAULT 'todo' AFTER `testing_report`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_item' AND column_name = 'testing_cases'
  ) THEN
    ALTER TABLE `zt_delivery_item`
      ADD COLUMN `testing_cases` mediumtext NOT NULL AFTER `testing_cases_status`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_item' AND column_name = 'testing_cases_path'
  ) THEN
    ALTER TABLE `zt_delivery_item`
      ADD COLUMN `testing_cases_path` varchar(512) NOT NULL DEFAULT '' AFTER `testing_cases`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_item' AND index_name = 'idx_dlv_item_testing_cases'
  ) THEN
    ALTER TABLE `zt_delivery_item`
      ADD KEY `idx_dlv_item_testing_cases` (`biz_line`, `program_id`, `testing_cases_status`);
  END IF;
END$$

CALL `migrate_delivery_test_cases`()$$
DROP PROCEDURE `migrate_delivery_test_cases`$$

DELIMITER ;
