-- 模型目录再加一档官方参考价：缓存读取。
--
-- 20260918_galaxy_model_card.sql 加进来的是 list_input_price / list_output_price 两档，
-- 那时候模型卡片上只并排放「输入 / 输出」两个价。现在卡片上是三格
-- （新增输入 / 输出 / 缓存读取），划线价却只有两档 —— 第三格旁边没有可比的数，
-- 而缓存读取恰恰是「比官方便宜多少」最悬殊的一档，缺它等于把最有说服力的那个
-- 对比藏起来。
--
-- 口径与另外两档完全一致：每百万 token 的微分、同一币种。必须是运营自己核对
-- 上游官网当期价再按当期汇率折进来的事实 —— 由代码从输入价推一个「通常是十分之一」
-- 写上去，性质上就是价格欺诈。0 = 没填，卡片上这一档不出现（另外两档照常）。
--
-- **只影响展示，不影响一分钱的账。** 我们自己收的缓存价在 zt_galaxy_price 上按
-- `能力 × 模型 × llm.cache_read_tokens` 维护，和这一列没有关系
-- （见 20260920_galaxy_model_drop_display_price.sql：自家的四档展示价已经删干净了）。
--
-- 发版顺序：**先跑这份脚本，再发 galaxy-api / galaxy-consumer-api / manager-api**。
-- 反过来的话新版读一个不存在的列，GORM 直接报 1054，模型目录整页打不开。
-- 先跑脚本、后发版是安全的：老版本不认识这一列，多出来的列只是占着位置。
--
-- 幂等：跑之前先判断列在不在，重复执行不会报 1060。
-- 写法和 20260918_galaxy_model_card.sql 一致 —— 先把子查询赋给变量再对变量做 IF，
-- 把子查询直接嵌在 IF( 后面换行写，有的客户端会在第二行处把语句截断。
--
-- AFTER 挂在 list_output_price 上，不是当年那份脚本里的 cache_write_price ——
-- 那一列已经被 20260920_galaxy_model_drop_display_price.sql 删掉了，
-- 挂在它后面会报 1054「Unknown column」。

SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_model'
     AND column_name = 'list_cache_price'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE `zt_galaxy_model`
     ADD COLUMN `list_cache_price` bigint NOT NULL DEFAULT 0
     COMMENT ''官方参考价：每百万 cache read token 微分，0=这一档不显示'' AFTER `list_output_price`',
  'SELECT ''zt_galaxy_model.list_cache_price 已存在，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- -------------------------------------------------------------------------
-- 退路：客户端还是把上面的语句切坏的话，直接跑这一句（去掉行首的 -- ）。
-- 列已经加过就报 1060，那条错误本身就是「已经加过了」的意思。
--
-- ALTER TABLE `zt_galaxy_model`
--   ADD COLUMN `list_cache_price` bigint NOT NULL DEFAULT 0
--   COMMENT '官方参考价：每百万 cache read token 微分，0=这一档不显示'
--   AFTER `list_output_price`;
--
-- 走命令行永远不会切错句子：
--
--   mysql universe < server/migrations/20260920_galaxy_model_list_cache_price.sql
-- -------------------------------------------------------------------------
