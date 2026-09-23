-- 价目表加模型维度：同一个 kind 下，每个模型可以有自己的价。
--
-- 原先整张表只按 kind 定价。opus 和 haiku 都是 llm.chat，同样一百万 token，
-- 给共享者结的钱一模一样 —— 而门户上这两个模型的标价能差几十倍。结果是
-- 平台毛利随使用者调哪个模型剧烈漂移，贵模型每跑一次都在亏，且没有任何地方拦得住。
--
-- 共享端的模型页也靠这一列才成立：那一页要回答「跑哪个模型更赚」，
-- 没有这一列的话每一行都是同一个数字，页面本身就没有存在的理由。
--
-- 加完之后 model_id 是唯一键的一部分：
--
--   model_id = ''      该 kind 的**兜底价**。不是「一个叫空串的模型」，
--                      是「没单独定价的模型按它算」。每个单位都必须有一行，
--                      否则那个单位查不到价 —— 而查不到价是静默算 0，不报错。
--   model_id = 'xxx'   只管这一个模型，而且是**按单位**覆盖：
--                      只给 output 单独定了价，input 仍然走兜底价。
--
-- **要在发新版 galaxy-api / manager-api 之前跑**，而且这一条比 provider_price 那条更硬：
-- 新版的取价、保存、删除都带 model_id，缺列会让 zt_galaxy_price 上的每一次
-- 读写都报 1054 —— 也就是**全站请求都不计费、不结算**（record 里取价失败直接返错）。
--
-- 存量行一律落成兜底价（model_id = ''），行为和跑之前完全一样。
--
-- 幂等：加列、换索引各自判一次存在性，重复执行不会报 1060 / 1061。

-- 1) 加列。NOT NULL DEFAULT '' 不是装饰：MySQL 的唯一索引不拦 NULL，
--    这一列要是可空，两行「同 kind 同单位同生效时刻、model_id 都是 NULL」
--    能一起插进去，取价时先拿到哪行全看运气。默认值同时把存量行落成兜底价。
SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_price'
     AND column_name = 'model_id'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE `zt_galaxy_price`
     ADD COLUMN `model_id` varchar(96) NOT NULL DEFAULT ''''
     COMMENT ''模型名，空=该 kind 的兜底价'' AFTER `kind`',
  'SELECT ''zt_galaxy_price.model_id 已存在，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2) 唯一键从 (biz_line, kind, unit, effective_from)
--    换成 (biz_line, kind, model_id, unit, effective_from)。
--
--    先判断索引里有没有 model_id：有就说明这一步跑过了。删掉再建之间有一瞬没有唯一键，
--    但存量行此刻 model_id 全是 ''，新旧两个键在这批数据上等价，撞不出重复来。
SET @indexed := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_price'
     AND index_name = 'uk_gx_price' AND column_name = 'model_id'
);
SET @sql := IF(@indexed = 0,
  'ALTER TABLE `zt_galaxy_price`
     DROP INDEX `uk_gx_price`,
     ADD UNIQUE INDEX `uk_gx_price` (`biz_line`,`kind`,`model_id`,`unit`,`effective_from`)',
  'SELECT ''uk_gx_price 已含 model_id，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
