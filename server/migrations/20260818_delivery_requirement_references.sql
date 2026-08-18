-- 历史兼容迁移：补齐需求详情里 @ 引用的历史需求键。
-- 存量需求没有引用，默认空串；列值形如 ,req-a,req-b,，与 owner_ids 同一种存法，
-- 将来查「谁引用了这条需求」用 LIKE '%,req-a,%' 即可，不必再开一张关联表。
-- 本脚本可重复执行。
DELIMITER $$

DROP PROCEDURE IF EXISTS `migrate_delivery_requirement_references`$$
CREATE PROCEDURE `migrate_delivery_requirement_references`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'zt_delivery_requirement'
      AND column_name = 'reference_requirement_keys'
  ) THEN
    ALTER TABLE `zt_delivery_requirement`
      ADD COLUMN `reference_requirement_keys` varchar(1024) NOT NULL DEFAULT '' AFTER `detail`;
  END IF;
END$$

CALL `migrate_delivery_requirement_references`()$$
DROP PROCEDURE `migrate_delivery_requirement_references`$$

DELIMITER ;
