-- 需求时间线：需求自身事件与任务事件独立留存，再在查询层按时间聚合。
-- 任务事件冗余 requirement_key，确保任务删除或后续更换需求归属后，历史仍可被原需求追溯。

DELIMITER $$

DROP PROCEDURE IF EXISTS `migrate_delivery_requirement_timeline`$$
CREATE PROCEDURE `migrate_delivery_requirement_timeline`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_item_event' AND column_name = 'requirement_key'
  ) THEN
    ALTER TABLE `zt_delivery_item_event`
      ADD COLUMN `requirement_key` varchar(64) NOT NULL DEFAULT '' AFTER `item_key`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_item_event' AND index_name = 'idx_dlv_event_requirement_time'
  ) THEN
    ALTER TABLE `zt_delivery_item_event`
      ADD KEY `idx_dlv_event_requirement_time` (`biz_line`, `program_id`, `requirement_key`, `created_time`);
  END IF;

  CREATE TABLE IF NOT EXISTS `zt_delivery_requirement_event` (
    `id` bigint NOT NULL AUTO_INCREMENT,
    `biz_line` varchar(32) NOT NULL,
    `program_id` bigint NOT NULL,
    `requirement_key` varchar(64) NOT NULL,
    `kind` varchar(16) NOT NULL,
    `field` varchar(32) NOT NULL,
    `from_value` varchar(255) NOT NULL,
    `to_value` varchar(255) NOT NULL,
    `comment` varchar(1024) NOT NULL,
    `actor_id` varchar(64) NOT NULL,
    `actor_name` varchar(64) NOT NULL,
    `created_time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_dlv_requirement_event_time` (`biz_line`, `program_id`, `requirement_key`, `created_time`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
END$$

CALL `migrate_delivery_requirement_timeline`()$$
DROP PROCEDURE `migrate_delivery_requirement_timeline`$$

DELIMITER ;
