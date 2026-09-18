-- 模型目录加一列：缓存写入单价。
--
-- 原先只有一个 cache_price，注释写死是 cache_read，于是缓存写入只能跟着缓存读取
-- 的价收。这两个数在任何一家上游都不是一个量级：缓存写入通常比普通输入还贵一截
-- （Anthropic 是 1.25 倍），缓存读取却便宜一个数量级（0.1 倍）。合成一档必然错一边，
-- 而且错的方向是「缓存写入按十分之一收」—— 提供者那边净亏。
--
-- 同一批改动里，Hub 把 OpenAI 的 input_tokens 减掉了 cached_tokens
-- （galaxy-hub-api/adapters/relay/usage.go 的 netInput）。从这次发版起，
-- 四个单价对的是四个互不重叠的桶：
--   input_price       未命中缓存的新增输入
--   output_price      输出（含推理 token，上游本来就算在 output 里）
--   cache_price       缓存命中读取
--   cache_write_price 写入缓存
--
-- 历史数据不回填：发版之前 OpenAI 那边的 llm.input_tokens 是含缓存命中的总输入，
-- 回填要重放每一条原始流才算得出来，而那些字节早就不在了。价格表当时还是空的，
-- 没有据此扣过钱，所以不回填只影响老记录的展示口径。
--
-- 幂等：跑之前先判断列在不在，重复执行不会报 1060。
SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_model'
     AND column_name = 'cache_write_price'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE `zt_galaxy_model`
     ADD COLUMN `cache_write_price` bigint NOT NULL DEFAULT 0
     COMMENT ''每百万 cache_write token 微分，0=按 kind 统一价'' AFTER `cache_price`',
  'SELECT ''zt_galaxy_model.cache_write_price 已存在，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
