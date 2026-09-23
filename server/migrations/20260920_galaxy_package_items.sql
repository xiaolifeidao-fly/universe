-- 额度包改成「模型 × 数量 × 折扣」：zt_galaxy_package 与 zt_galaxy_order 各加一列 items_json。
--
-- 原先一个包只有一份不分模型的额度（units_json）和一个**手填的售价**（amount）。
-- 两个毛病：
--
--   1. 售价和单价互不相干。调一次对外单价，所有包的实际折扣就悄悄变了，
--      而没有任何地方看得出来；反过来，运营想给某个模型让 15 个点，得自己算乘法。
--   2. 额度不分模型。一个「opus 1M + sonnet 5M」的包发到密钥上合并成 6M 通用 token，
--      买的人全拿去跑 opus —— 付的是混合折扣价、用的是单价最高的模型。
--
-- 新的形状是一组条目，一条一个模型：
--
--   [{"modelId":"claude-opus-5","kind":"llm.chat",
--     "units":{"llm.input_tokens":3000000,"llm.output_tokens":1000000},
--     "discountBps":8500}]
--
-- discountBps 是**成交价占原价的万分比**：10000 = 原价，8500 = 八五折。
-- 售价由服务端算：Σ 数量 × 对外单价 / 1e6，再乘折扣。请求体里传进来的 amount
-- 一概不看 —— 能传的话这整套折扣就只是界面上的装饰。
--
-- units_json 与 amount **两列都保留**：模型包由条目摊平 / 算出来写进去，
-- 老代码和遗留包照读不误。amount 是**成交价**，下单时快照进订单，
-- 之后单价再调也不影响已经在卖的包，直到运营重新保存一次。
--
-- -------------------------------------------------------------------------
-- 存量包怎么办：**不动**。
--
-- 这份脚本只加两列，一行数据都不改。已有的包 items_json 为空，就是「遗留包」——
-- 照常卖、照常上下架，只是改不了构成（要改就新建一个模型包）。
--
-- 不在 SQL 里反推折扣，是因为反推要先算 Σ 数量 × 单价，而单价按 (kind, model, unit)
-- 分层回落、还带生效时间，在 SQL 里重写一遍这套规则，算错了不会报错，
-- 只会让某个包的价格在运营毫不知情的时候变掉。管理端的编辑框会在**打开某个
-- 绑了模型的遗留包**时当场按当前单价把折扣反推出来摆给运营看，他确认了再存 ——
-- 那一步有人在看着数字。
--
-- -------------------------------------------------------------------------
-- **要在发新版之前跑。** 缺这两列，商品目录的每一次读写都报 1054：
-- 运营开不了「商品与定价」，使用端的广场和下单也一起挂。
--
-- 幂等：两列各判一次存在性，重复执行不报 1060。
-- -------------------------------------------------------------------------

SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_package'
     AND column_name = 'items_json'
);

-- 用 text 不是 varchar：一个包能装十几个模型 × 四档计量单位，
-- varchar(1024) 在第五六个模型上就会被 MySQL 截断，而截断不报错 ——
-- 只会让这个包少发几档额度。
SET @sql := IF(@exists = 0,
  'ALTER TABLE `zt_galaxy_package` ADD COLUMN `items_json` text COMMENT ''按模型拆开的构成，空为遗留包'' AFTER `title`',
  'SELECT 1');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_order'
     AND column_name = 'items_json'
);

-- 订单也要存一份：履约按它分模型发额度。空的是老订单，整份落进通用额度 ——
-- 它本来就是按「一份不分模型的 token」卖的，语义一字未变。
SET @sql := IF(@exists = 0,
  'ALTER TABLE `zt_galaxy_order` ADD COLUMN `items_json` text COMMENT ''按模型拆开的额度快照，空则整份落通用额度'' AFTER `units_json`',
  'SELECT 1');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- -------------------------------------------------------------------------
-- 退路：客户端把上面的语句切坏时（有的 SQL 客户端会在多行 SET @sql := IF(
-- 的第二行处截断，MySQL 收到半句报 1064「near '' at line 2」），直接跑这两句：
--
-- ALTER TABLE `zt_galaxy_package` ADD COLUMN `items_json` text COMMENT '按模型拆开的构成，空为遗留包' AFTER `title`;
-- ALTER TABLE `zt_galaxy_order`   ADD COLUMN `items_json` text COMMENT '按模型拆开的额度快照，空则整份落通用额度' AFTER `units_json`;
--
-- 它们不幂等 —— 列已经加过就报 1060，那条错误本身就是「已经加过了」的意思。
--
-- 更省事的办法是走命令行，它永远不会切错句子：
--
--   mysql universe < server/migrations/20260920_galaxy_package_items.sql
-- -------------------------------------------------------------------------
