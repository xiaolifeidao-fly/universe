-- 模型目录删掉四列展示价：单价从此只有 zt_galaxy_price 一个出处。
--
--   input_price / output_price / cache_price / cache_write_price
--
-- 这四列是**展示价**，只被门户和模型广场读，不参与计费。按模型计价落地之后
-- （见 20260919_galaxy_price_model.sql），同一个模型的价在库里就有了两份：
-- 门户照目录标、账上照计价表扣，两个数各改各的、谁也不校验谁。对不上时
-- 两边都不报错，而访问者看到的是一个他付不到的价 —— 那是对外失信，
-- 不是显示问题。现在门户上标的数直接来自计价表。
--
-- list_input_price / list_output_price（官方参考价，用来划线和算「省 X%」）
-- **不删**：那是别人家的价，和我们自己的单价是两回事。
--
-- -------------------------------------------------------------------------
-- 跑之前先确认一次：这四列是不是都还是 0
-- -------------------------------------------------------------------------
--
--   SELECT model_id, input_price, output_price, cache_price, cache_write_price
--     FROM zt_galaxy_model
--    WHERE input_price > 0 OR output_price > 0
--       OR cache_price > 0 OR cache_write_price > 0
--
-- 查出来是空的（种子数据本来就全填 0）就直接跑，门户上一个数都不会变。
--
-- **查出来有行就先别跑**：那些模型的门户标价是这里填的，删了之后它们会改成
-- 按计价表显示。要保持原样，先把这些数抄进价目表 —— 在管理端
-- 「商品与定价 → 单价」里按模型加行，能力选模型对应的 kind、模型选它自己，
-- 四个计量单位各填一行，对外单价填这里查出来的数。抄完再跑这份脚本。
--
-- 对照关系：
--   input_price       → llm.input_tokens
--   output_price      → llm.output_tokens
--   cache_price       → llm.cache_read_tokens
--   cache_write_price → llm.cache_write_5m_tokens（合计那个单位不进账本）
--
-- **要在发新版 galaxy-api / manager-api 之前跑。** 缺了这一步不会出错：
-- 新版根本不读这四列（GORM 的模型里已经没有它们），多出来的列只是占着位置。
-- 但反过来，先跑这份脚本、后发版也安全 —— 老版本读不到列会报 1054，
-- 所以两件事之间别隔太久。
--
-- -------------------------------------------------------------------------
-- 幂等：先查还剩哪几列，再拼一条 ALTER。四列都没了就什么都不做，重复执行不报 1091。
--
-- 写法上刻意和 20260918_galaxy_cache_write_price.sql 一致：**先把子查询赋给变量，
-- 再对变量做 IF**。把子查询直接嵌在 IF( 后面换行写，有的客户端会在第二行处把语句
-- 截断，MySQL 收到半句报 1064「near '' at line 2」—— 而那个空串是「输入到此为止」，
-- 排查起来完全看不出是客户端切的。
--
-- 四列拼成一条 ALTER，不是四条：每条 ALTER 都要重建一次表。
-- -------------------------------------------------------------------------

SET @cols := (
  SELECT GROUP_CONCAT(CONCAT('DROP COLUMN `', column_name, '`') SEPARATOR ', ')
    FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'zt_galaxy_model'
     AND column_name IN ('input_price', 'output_price', 'cache_price', 'cache_write_price')
);

SET @sql := IF(@cols IS NULL, 'SELECT 1', CONCAT('ALTER TABLE `zt_galaxy_model` ', @cols));

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- -------------------------------------------------------------------------
-- 退路：客户端还是把上面的语句切坏的话，直接跑这一句（去掉行首的 -- ）。
--
-- 它不幂等 —— 列已经删过就报 1091，那条错误本身就是「已经删过了」的意思，
-- 不用管。确认过四列都是 0 之后，这是一次性动作，不值得为幂等和客户端较劲。
--
-- ALTER TABLE `zt_galaxy_model`
--   DROP COLUMN `input_price`,
--   DROP COLUMN `output_price`,
--   DROP COLUMN `cache_price`,
--   DROP COLUMN `cache_write_price`;
--
-- 更省事的办法是走命令行，它永远不会切错句子：
--
--   mysql universe < server/migrations/20260920_galaxy_model_drop_display_price.sql
-- -------------------------------------------------------------------------
