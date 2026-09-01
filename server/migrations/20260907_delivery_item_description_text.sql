-- 任务说明放宽为 text。
-- 需求拆解现在要求把任务说明写成能独立执行的需求（目标、真实落点、改动分条、边界、
-- 依赖与输入、验收标准），varchar(1024) 装不下；任务没有单独需求文档时，执行阶段
-- 唯一能看到的需求就是这一列，截断等于丢需求。
-- 全量脚本 delivery.sql 已同步为 text，这里补一份增量，供已有库执行。可重复执行。
DELIMITER $$

DROP PROCEDURE IF EXISTS `migrate_delivery_item_description_text`$$
CREATE PROCEDURE `migrate_delivery_item_description_text`()
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_delivery_item'
      AND column_name = 'description' AND data_type = 'varchar'
  ) THEN
    ALTER TABLE `zt_delivery_item`
      MODIFY COLUMN `description` text NOT NULL COMMENT '任务说明；无任务需求文档时是执行阶段唯一的需求输入';
  END IF;
END$$

CALL `migrate_delivery_item_description_text`()$$
DROP PROCEDURE `migrate_delivery_item_description_text`$$

DELIMITER ;
