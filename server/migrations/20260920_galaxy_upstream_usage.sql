-- 共享算力池：节点自报的**上游订阅余量**落两列。
--
-- 首选做法不是跑这份 SQL，而是：
--
--     cd server/galaxy-api && go run ./cmd/galaxyinit
--
-- 表结构的唯一出处是 service/galaxy/internal/repository/model.go，galaxyinit 按它
-- AutoMigrate。这份只给「目标环境跑不了 galaxyinit」的情况兜底。
--
--
-- 这两列是什么
--
-- Claude / Codex 账号**自己**还剩多少（5 小时窗口、周限额之类）。它和
-- zt_galaxy_quota_grant 讲的不是同一件事，两者都要有，而且界面上要分开显示：
--
--   quota_grant          主人在控制台设的上限 —— 「他打算放多少出去」
--   upstream_usage_json  上游账号还让跑多少 —— 「上游实际还剩多少」
--
-- 前者填得比后者宽时，机器会在上游那儿撞限流，而平台这边看到的是「额度还剩大半」。
-- 在有这两列之前，这种情况只能从「这台机器怎么老是失败」反推。
--
-- 数据从哪来：节点把**本来就要发的**那些中转请求的响应头里的限流项捎回来
-- （anthropic-ratelimit-* / x-ratelimit-*），随心跳上报。**不额外打上游** ——
-- 探测那条路刻意不碰上游（「不该消耗主人的额度，也不该在上游留痕迹」），
-- 这里沿用同一条规矩。代价是机器闲着的时候这个数不更新，所以观测时刻单独一列，
-- 界面必须把它显示出来：三小时前的余量不能被读成此刻的。
--
-- 它**只给人看**：不参与派单、不参与计费。和 models_available_json 同一个性质。
-- 理由有两条 —— 上游回哪些头由上游说了算、随时会变；而节点自报的数没法验证。
--
--
-- 写入频率
--
-- 心跳是 15 秒一次，但服务端**只在这份数真的变了的时候才 UPDATE**
-- （见 service/galaxy/node.go 的 pendingUsageWrites）。不比就写的话，
-- 是每台机器每天四千多次空 UPDATE，而且全落在派单路径要读的这张表上。
--
--
-- 幂等：两列都用「先查 information_schema，已经在就跳过」的写法，反复执行安全。
-- 不用 DELIMITER、不建存储过程，理由见 20260916_galaxy_admin_indexes.sql。
--
-- 库：galaxy 那几个服务的 application.properties 里 sqlconn 指向的那个。


-- -------------------------------------------------------------------------
-- 1. upstream_usage_json —— 余量本身
--
-- 存的是一份 JSON：认出来的桶（bucket / window / limit / remaining / usedPercent /
-- reset / status）加上**原样的限流头**。原样那份是事后补解析器时唯一能对照的
-- 真实报文 —— 上游改一次头名，归一化就认不出来了，而那时候界面显示的是
-- 「未报」而不是一个错的数。
--
-- 4096 是上限不是预算：超长的整条丢弃、不截断（截一半的 JSON 解不动，
-- 而且每次心跳都会重写一遍）。
-- -------------------------------------------------------------------------

SET @have = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'zt_galaxy_contribution'
               AND COLUMN_NAME = 'upstream_usage_json');
SET @ddl = IF(@have > 0, 'SELECT 1',
  'ALTER TABLE `zt_galaxy_contribution` ADD COLUMN `upstream_usage_json` varchar(4096) AFTER `models_deny_json`');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- -------------------------------------------------------------------------
-- 2. upstream_usage_at —— 观测时刻
--
-- 单独一列而不是塞进 JSON 里：它是**每一次展示都必须一起出现**的东西，
-- 不该藏在一段要先解析才看得到的文本里。
--
-- 写成 `timestamp NULL DEFAULT NULL`，不能是裸 TIMESTAMP：
-- explicit_defaults_for_timestamp=OFF 时 MySQL 会给裸 TIMESTAMP 静默补上
-- NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP，那样这一列
-- 会跟着任何一次 UPDATE 改写，「观测于」就成了「最后改动于」。
-- -------------------------------------------------------------------------

SET @have = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'zt_galaxy_contribution'
               AND COLUMN_NAME = 'upstream_usage_at');
SET @ddl = IF(@have > 0, 'SELECT 1',
  'ALTER TABLE `zt_galaxy_contribution` ADD COLUMN `upstream_usage_at` timestamp NULL DEFAULT NULL AFTER `upstream_usage_json`');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- -------------------------------------------------------------------------
-- 跑完自己看一眼：两列都该在，而且 upstream_usage_at 必须是可空的。
--
--   SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
--   FROM information_schema.COLUMNS
--   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'zt_galaxy_contribution'
--     AND COLUMN_NAME LIKE 'upstream_usage%';
--
-- EXTRA 里出现 on update CURRENT_TIMESTAMP 就是上面第 2 段说的那个坑，要改回去。
--
-- 不用碰 Redis：这份数不进控制面，也不参与任何判定。
-- 老版本节点不报这两列，值一直是 NULL —— 界面显示「还没报过」，不是「余量为 0」。
--
-- 备用：客户端不让用 PREPARE / EXECUTE 时直接跑下面两条。
-- 不幂等 —— 列已经在会报 1060 Duplicate column name，那个错是无害的。
--
-- ALTER TABLE `zt_galaxy_contribution` ADD COLUMN `upstream_usage_json` varchar(4096) AFTER `models_deny_json`;
-- ALTER TABLE `zt_galaxy_contribution` ADD COLUMN `upstream_usage_at` timestamp NULL DEFAULT NULL AFTER `upstream_usage_json`;
-- -------------------------------------------------------------------------
