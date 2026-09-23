-- 价目表加推理强度维度，单元表记下每次请求跑的是哪一档。
--
-- 同一个模型，max 档一次请求烧掉的推理 token 能比 low 档多一个量级，而这些 token
-- 全部落在 output 桶里按同一个单价收 —— 于是深思考的请求每跑一次平台都在亏，
-- 浅思考的又收贵了，共享者结算拿到的也是同一个被摊平的数。加这一维之后，
-- 使用者按 (模型, 强度) 扣积分，共享者按同一组键结算，两头对的是同一行价。
--
-- 档位名用**上游原生**的那一套，两族各不相同（见 contract.FamilyEfforts）：
--
--   anthropic   none / low / medium / high / xhigh / max     （output_config.effort）
--   openai      none / minimal / low / medium / high          （reasoning.effort）
--
-- 没有统一刻度是有意的：openai 的 minimal 在 anthropic 没有对应档，anthropic 的
-- xhigh / max 在 openai 也没有。硬造一个公共刻度，运营填的档就不再是上游真实收费的那个。
--
-- **要在发新版 galaxy-api / manager-api / galaxy-hub-api 之前跑。** 和 model_id 那一条
-- 一样硬：新版的取价、保存、删除都带 effort，缺列会让 zt_galaxy_price 上的每一次读写
-- 都报 1054 —— 也就是全站请求都不计费、不结算（record 里取价失败直接返错）。
-- zt_galaxy_unit.effort 缺列则会让派单那一刻的 INSERT 整条失败，请求直接打不进来。
--
-- 存量行一律落成「不分强度」（effort = ''），行为和跑之前完全一样：
-- 没有任何一行带强度时，取价的四级回落每次都停在原来那两级上。
--
-- 幂等：加列、换索引各自判一次存在性，重复执行不会报 1060 / 1061。

-- 1) 价目表加列。NOT NULL DEFAULT '' 不是装饰，理由和 model_id 那一列一模一样：
--    MySQL 的唯一索引不拦 NULL，这一列要是可空，两行「同 kind 同模型同单位同生效时刻、
--    effort 都是 NULL」能一起插进去，取价时先拿到哪行全看运气。
--    默认值同时把存量行落成不分强度价。
SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_price'
     AND column_name = 'effort'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE `zt_galaxy_price`
     ADD COLUMN `effort` varchar(16) NOT NULL DEFAULT ''''
     COMMENT ''推理强度，空=不分强度'' AFTER `model_id`',
  'SELECT ''zt_galaxy_price.effort 已存在，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2) 唯一键从 (biz_line, kind, model_id, unit, effective_from)
--    换成 (biz_line, kind, model_id, effort, unit, effective_from)。
--
--    effort 排在 model_id 之后、unit 之前：取价的 ORDER BY 必须和索引同列序才走得上
--    索引顺序（见 ListEffectivePrices 与 billing_pricequery_test），而回落是
--    「模型比强度更粗」的顺序 —— 两者在这个列序上是一致的。
--
--    先判断索引里有没有 effort：有就说明这一步跑过了。删掉再建之间有一瞬没有唯一键，
--    但存量行此刻 effort 全是 ''，新旧两个键在这批数据上等价，撞不出重复来。
SET @indexed := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_price'
     AND index_name = 'uk_gx_price' AND column_name = 'effort'
);
SET @sql := IF(@indexed = 0,
  'ALTER TABLE `zt_galaxy_price`
     DROP INDEX `uk_gx_price`,
     ADD UNIQUE INDEX `uk_gx_price` (`biz_line`,`kind`,`model_id`,`effort`,`unit`,`effective_from`)',
  'SELECT ''uk_gx_price 已含 effort，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 3) 单元表加列：这一次请求跑的是哪一档。
--
--    它不是冗余。结算发生在请求跑完之后，账单与争议追回更是事后好几天才重新取价，
--    那时 Redis 里那份信封早过期了，唯一能回答「当初是哪一档」的就是这一列。
--    少了它，一笔按 max 档收过的钱，退款时会按不分强度价退 —— 差额静静挂在平台账上。
--
--    这一列可空（没有 NOT NULL DEFAULT）：它跟着 model / family 走，
--    那两列本来就是「单元行还在就有、被清掉就没有」的口径，三列保持一致。
SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_unit'
     AND column_name = 'effort'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE `zt_galaxy_unit`
     ADD COLUMN `effort` varchar(16) NULL
     COMMENT ''推理强度，计价键的一部分'' AFTER `model`',
  'SELECT ''zt_galaxy_unit.effort 已存在，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
