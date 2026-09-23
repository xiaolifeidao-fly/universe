-- 共享算力池：上游余量下限落一列。
--
-- 首选做法不是跑这份 SQL，而是：
--
--     cd server/galaxy-api && go run ./cmd/galaxyinit
--
-- 表结构的唯一出处是 service/galaxy/internal/repository/model.go，galaxyinit 按它
-- AutoMigrate。这份只给「目标环境跑不了 galaxyinit」的情况兜底。
--
--
-- 这一列是什么
--
-- 主人给自己的订阅留的那条线：上游某个窗口只剩这么多的时候，这条贡献就不再接新单，
-- 剩下的额度留给自己用。形状是一个数组：
--
--     [{"window":"5h","percent":10},{"window":"7d","percent":20}]
--
-- window 为空表示**任一窗口**（上游报几个窗口、各叫什么由上游说了算，主人多半
-- 只想说一句「快用完了就别接了」）。percent 是**剩余**百分比的下限，剩余 ≤ 它就停。
-- 必填，默认 [{"window":"","percent":0}] —— 剩 0 才停，也就是和加这条线之前一样。
-- 空字符串按这个默认解，所以**存量行不必回填**。
--
--
-- 它推翻了 20260920_galaxy_upstream_usage.sql 里的一句话
--
-- 那份迁移写着 upstream_usage_json「只给人看：不参与派单、不参与计费」，理由是
-- 上游回什么由上游说了算、而节点自报的数没法验证。两条理由今天仍然成立，
-- 但中间变了一件事：**余量的来源换了**。
--
--   以前  从中转响应的限流头里捎 —— 机器闲着就不更新
--   现在  节点每 5 分钟问本机的 claude / codex 自己（`claude /usage`、codex `/status`，
--         见 client/…/pool/usage_probe.rs），跟有没有人派活无关
--
-- 这个区别是决定性的：拿「只在跑活时才更新」的数当闸门会死锁 —— 低于线 → 不接单 →
-- 没有请求 → 数字永远不刷新 → 永远不接单。换成定时探测之后，窗口重置后的下一轮
-- 探测就会把数带回来，闸门自己打开。
--
-- 那两条理由留下的痕迹是判定的**单向性**（见 service/galaxy/upstreamfloor.go）：
--
--   认得出来的窗口 + 余量低于线   → 不接单
--   认不出来 / 没采到 / 解不动     → 照常接单
--
-- 也就是说这条线只会让一台机器少接活，不会让它多接活。反过来把「不知道」当成
-- 「没余量」的话，上游改一次输出格式就能让全网的机器一起静默退出池子。
--
--
-- 幂等：先查 information_schema，已经在就跳过，反复执行安全。
-- 不用 DELIMITER、不建存储过程，理由见 20260916_galaxy_admin_indexes.sql。
--
-- 库：galaxy 那几个服务的 application.properties 里 sqlconn 指向的那个。


SET @have = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'zt_galaxy_contribution'
               AND COLUMN_NAME = 'upstream_floor_json');
SET @ddl = IF(@have > 0, 'SELECT 1',
  'ALTER TABLE `zt_galaxy_contribution` ADD COLUMN `upstream_floor_json` varchar(512) AFTER `upstream_usage_at`');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- -------------------------------------------------------------------------
-- 跑完自己看一眼：
--
--   SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
--   FROM information_schema.COLUMNS
--   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'zt_galaxy_contribution'
--     AND COLUMN_NAME = 'upstream_floor_json';
--
-- Redis 不用动，也不用清：控制面里那份 contrib 哈希多两个字段
-- （upstreamFloor 规则、upstreamLeft 观测），老哈希里没有它们时按
-- 「默认那条线 + 不知道余量」解，也就是这次改动之前的行为。节点下一次 hello、
-- 或者主人在控制台按一次保存，就会把规则写进去；观测跟着心跳走，最迟 15 秒。
--
-- 备用：客户端不让用 PREPARE / EXECUTE 时直接跑下面这条。
-- 不幂等 —— 列已经在会报 1060 Duplicate column name，那个错是无害的。
--
-- ALTER TABLE `zt_galaxy_contribution` ADD COLUMN `upstream_floor_json` varchar(512) AFTER `upstream_usage_at`;
-- -------------------------------------------------------------------------
