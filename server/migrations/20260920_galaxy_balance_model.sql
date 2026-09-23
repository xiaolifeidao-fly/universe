-- 密钥余额按模型分账：加 model_id，唯一键换成 (biz_line, key_id, model_id, unit)。
--
--   model_id = ''      **通用额度**，任何模型都能用。不是「某个叫空串的模型」。
--   model_id = 'xxx'   只能给这个模型用。
--
-- 为什么要分：额度包要按模型打包卖（opus 八折、sonnet 六折）。额度不分模型记的话，
-- 一个「opus 1M + sonnet 5M」的包发到密钥上就合并成 6M 通用 token，买的人
-- 全拿去跑 opus —— 付的是混合折扣价、用的是单价最高的模型，而账面上一点异常
-- 都看不出来。折扣分模型定，额度就必须分模型记。
--
-- 扣的时候先扣这个模型自己的那份，扣不动再扣通用那份（service 的 consumeBalance），
-- 和价目表那套「模型价优先、兜底价回落」是同一个结构。
--
-- 存量行一律落成通用额度（model_id = ''），**行为一字不变**：现在发出去的额度
-- 本来就不分模型，落成通用之后任何模型照样能用，扣费也照旧走通用那一份。
--
-- **要在发新版 galaxy-api 之前跑。** 缺这一列，余额表上的每一次读写都会报 1054 ——
-- 发额度、扣额度、密钥页查余额全在这条路上，也就是**买了充不进、跑了扣不掉**。
--
-- 幂等：加列、换索引各自判一次存在性，重复执行不报 1060 / 1061。

SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_consumer_balance'
     AND column_name = 'model_id'
);

SET @sql := IF(@exists = 0,
  'ALTER TABLE `zt_galaxy_consumer_balance` ADD COLUMN `model_id` varchar(96) NOT NULL DEFAULT '''' COMMENT ''模型名，空=通用额度'' AFTER `key_id`',
  'SELECT 1');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @indexed := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_consumer_balance'
     AND index_name = 'uk_gx_consumer_balance' AND column_name = 'model_id'
);

SET @sql := IF(@indexed = 0,
  'ALTER TABLE `zt_galaxy_consumer_balance` DROP INDEX `uk_gx_consumer_balance`, ADD UNIQUE INDEX `uk_gx_consumer_balance` (`biz_line`,`key_id`,`model_id`,`unit`)',
  'SELECT 1');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
