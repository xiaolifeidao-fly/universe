-- 使用端注册赠送活动：registration_gift 流水类型长度超过旧版 varchar(16)。
-- 赠送积分只写使用端积分账本，不能提现；活动开关与赠送数量写在 zt_galaxy_setting。

SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_points_ledger'
     AND column_name = 'type'
);
SET @sql := IF(@exists = 1,
  'ALTER TABLE `zt_galaxy_points_ledger` MODIFY COLUMN `type` varchar(24)',
  'SELECT ''zt_galaxy_points_ledger.type 不存在，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
