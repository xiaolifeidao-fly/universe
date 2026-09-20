  -- 使用端改成按账户积分余额逐笔扣费：额度包下架，密钥不再带额度。
  --
  -- 只加列，不删任何东西。zt_galaxy_consumer_balance 里的历史额度不再参与扣费，
  -- 但那是买过的记录，留着可查；两张订单 / 商品表同理。
  --
  -- 加的两列让「扣了多少积分」那行流水说得出是哪一次请求花的：
  --
  --   unit_id  这笔扣费对应的工作单元。账单上的 unitId 就是它，申诉也钉这个。
  --   kind     调的哪类能力（llm.chat / video.…），配上已有的 model_id 就说得清钱花在哪。
  --
  -- **要在发新版 galaxy-api 之前跑。** 缺这两列，每一次请求结算时写流水都会报 1054 ——
  -- 而扣费失败只记日志不阻断，所以表面上一切正常，只是**谁都不扣钱**。
  --
  -- 幂等：加列、建索引各自判一次存在性，重复执行不报 1060 / 1061。

  SET @exists := (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_points_ledger'
      AND column_name = 'unit_id'
  );

  SET @sql := IF(@exists = 0,
    'ALTER TABLE `zt_galaxy_points_ledger` ADD COLUMN `unit_id` varchar(64) NOT NULL DEFAULT '''' COMMENT ''按量扣费对应的工作单元'' AFTER `order_id`',
    'SELECT 1');
  PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

  SET @exists := (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_points_ledger'
      AND column_name = 'kind'
  );

  SET @sql := IF(@exists = 0,
    'ALTER TABLE `zt_galaxy_points_ledger` ADD COLUMN `kind` varchar(32) NOT NULL DEFAULT '''' COMMENT ''按量扣费：调的哪类能力'' AFTER `unit_id`',
    'SELECT 1');
  PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

  -- 按单元回查那一笔扣费：申诉退款要找回当初这一次实际扣了多少。
  SET @exists := (
    SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_points_ledger'
      AND index_name = 'idx_gx_points_ledger_unit'
  );

  SET @sql := IF(@exists = 0,
    'CREATE INDEX `idx_gx_points_ledger_unit` ON `zt_galaxy_points_ledger` (`biz_line`, `unit_id`)',
    'SELECT 1');
  PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
