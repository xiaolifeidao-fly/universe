-- 任务收益标签：JSON 数组，供需求确认时生成并在任务卡片上展示。
-- 历史任务保留空数组，新的创建路径会强制至少提供一个标签。

DELIMITER $$

DROP PROCEDURE IF EXISTS `migrate_delivery_item_benefit_tags`$$
CREATE PROCEDURE `migrate_delivery_item_benefit_tags`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'zt_delivery_item'
      AND column_name = 'benefit_tags'
  ) THEN
    ALTER TABLE `zt_delivery_item`
      ADD COLUMN `benefit_tags` text NOT NULL AFTER `description`;
  END IF;
END$$

CALL `migrate_delivery_item_benefit_tags`()$$
DROP PROCEDURE `migrate_delivery_item_benefit_tags`$$

DELIMITER ;
