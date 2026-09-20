-- 价目表加一列：结算单价。上游价从此和下游价各自独立。
--
-- 原先一行价只有一个 price（对外收多少）加一个 provider_share（提供者拿几成），
-- 于是给共享者的钱是对外价的一个函数。两件事因此永远绑在一起：
--
--   · 调一次对外价，所有共享者的收入跟着变 —— 想给使用者降价就必须同时降共享者的收入
--   · 共享者拿自己的积分流水除一除就反推出平台抽了几成（供给侧账本的 price 列
--     原先抄的还是**对外价**，等于直接写在那儿了）
--
-- 改完之后一行两个价：price 向使用者收，provider_price 结给共享者，差额是平台毛利。
-- 两个数各填各的，谁也不是谁的百分比。provider_share 留着只为存量行兜底
-- （provider_price = 0 时回落到老算式），这份脚本跑完就不会再走到那条路。
--
-- **要在发新版 galaxy-api / manager-api 之前跑。** 缺这一列不会让池子掉线：
-- 请求路径上的 SELECT 少一列只会让 provider_price 读成 0，结算自动回落老口径。
-- 但管理端价目表的保存会 1054（写入语句里带了这个列名），运营改不了价。
--
-- 回填按老算式对齐：provider_price = ROUND(price × provider_share)。
-- 跑完之后每一笔结算的金额和跑之前一样（取整差最多 1 微分 / 百万单位），
-- 不需要重算任何历史账。
--
-- 幂等：加列前先判断列在不在；回填只动 provider_price 还是 0 的行，
-- 重复执行不会把运营后来手工改过的结算价覆盖回去。
SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_price'
     AND column_name = 'provider_price'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE `zt_galaxy_price`
     ADD COLUMN `provider_price` bigint DEFAULT 0
     COMMENT ''结算单价：每百万单位微分，0=回落到 provider_share'' AFTER `currency`',
  'SELECT ''zt_galaxy_price.provider_price 已存在，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 回填。price = 0 的行（有意免费的单位）保持 provider_price = 0：
-- 对外不收钱、也不结给共享者，和改动前的行为一致。
UPDATE `zt_galaxy_price`
   SET `provider_price` = ROUND(`price` * `provider_share`)
 WHERE `provider_price` = 0
   AND `price` > 0
   AND `provider_share` > 0;
