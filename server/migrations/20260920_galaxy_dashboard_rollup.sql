-- 管理端仪表盘：用量汇总表 + 额度快照的窗口键索引。
--
-- 这一轮有**一张新表和一条新索引**，两样都必须跑 —— 新表不建，仪表盘的
-- 「今日消耗」第一次读就报「表不存在」。
--
-- 首选做法不是跑这份 SQL，而是：
--
--     cd server/galaxy-api && go run ./cmd/galaxyinit
--
-- 表结构的唯一出处是 service/galaxy/internal/repository/model.go，galaxyinit 按它
-- AutoMigrate。这份 SQL 与那份模型导出来的建表语句逐字一致（见 ddldump_test.go），
-- 只给「目标环境跑不了 galaxyinit」的情况兜底。
--
--
-- 1. zt_galaxy_usage_rollup —— 按小时的用量与金额汇总
--
-- 为什么要垫这一张：仪表盘要「今天消耗了多少 token、收了多少、结出去多少，
-- 按 Claude / Codex 分开」。量在 zt_galaxy_meter_record 上、钱在消费与供给两本账上、
-- 而「是 Claude 还是 Codex」只有 zt_galaxy_unit 上的模型说得清 —— 每问一次，
-- 就要把当天最大的三张表各扫一遍、每一行再回 unit 表查一次模型。
-- 而仪表盘是会挂在大屏上自动刷新的页面：直接查等于让最贵的那条查询按秒重复。
--
-- 按小时不按天：小时桶封口之后不会再变（行的 created_at 就是它自己的写入时刻，
-- 没有迟到的行），算一次能一直用。按天的话，当天那一桶到半夜之前一直是活的。
--
-- 谁写它：Hub 巡检每轮把刚封口的小时补上；仪表盘读到没算过的小时也会现算一次
-- 写回去。两条路写的是同一份**绝对值**、按唯一键整行覆盖 —— 所以重复跑、
-- 多实例同时跑都没有副作用，也不需要「谁是唯一写入者」这条约束。
--
-- 它是**派生数据**：整表删掉也不丢账，下次读到哪个小时就重算哪个小时。
--
--
-- 2. idx_gx_quota_window_key —— 额度快照按窗口键查
--
-- 「全池此刻还剩多少额度」手上只有当下生效的那几个窗口键，没有 cid；而原来的
-- 唯一键 (biz_line, cid, unit, window_key) 是按 cid 打头的，跳过第二列就用不上，
-- 只能全表扫。这张表按 (cid, unit, 窗口键) 一行一行地堆、**旧窗口从不清理**，
-- 所以它不是一张小表：机器数 × 单位数 × 天数。
--
-- 建索引走 ONLINE DDL（显式 ALGORITHM=INPLACE, LOCK=NONE），不锁表，
-- 但要把整张表读一遍。挑低峰跑。
--
-- 幂等：反复执行安全。索引那一段先数一下 information_schema，已经在就跳过 ——
-- MySQL 没有 CREATE INDEX IF NOT EXISTS，这是不带存储过程的标准做法
-- （不用 DELIMITER 的理由见 20260916_galaxy_admin_indexes.sql）。
--
-- 库：galaxy 那几个服务的 application.properties 里 sqlconn 指向的那个
--     （和 manager-api 是同一个库，见 server/SCHEMA.md）。


-- -------------------------------------------------------------------------
-- 1. 用量汇总表
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `zt_galaxy_usage_rollup` (
  `id`              bigint AUTO_INCREMENT,
  `biz_line`        varchar(32),
  `stat_hour`       datetime(3),                                  -- 小时桶起点，整点
  `category`        varchar(16),                                  -- claude/codex/video/other；空串是这个小时的标记行
  `unit`            varchar(48),                                  -- 计量单位，与 zt_galaxy_meter_record.unit 同一套
  `amount`          bigint,                                       -- 该计量单位的合计，量纲随 unit 而定，跨单位相加没有意义
  `consumer_amount` bigint,                                       -- 使用端结算金额（微元），取自消费侧账本 type=settle
  `provider_amount` bigint,                                       -- 共享端结算金额（微元），取自供给侧账本 type=settle
  `rolled_at`       timestamp NULL DEFAULT NULL,                  -- 这一桶最近一次算出来的时刻
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_usage_rollup` (`biz_line`,`stat_hour`,`category`,`unit`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 每个算过的小时都有一行 category 与 unit 都是空串的**标记行**，哪怕那个小时
-- 一条流水都没有。没有它就分不出「这个小时没有量」和「这个小时还没算过」，
-- 空闲时段会被反复重算。读的时候要把它滤掉 —— 别手工删这些行。


-- -------------------------------------------------------------------------
-- 2. 额度快照的窗口键索引
-- -------------------------------------------------------------------------

SET @have = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'zt_galaxy_quota_window'
               AND INDEX_NAME = 'idx_gx_quota_window_key');
SET @ddl = IF(@have > 0, 'SELECT 1',
  'ALTER TABLE `zt_galaxy_quota_window` ADD INDEX `idx_gx_quota_window_key` (`biz_line`,`window_key`), ALGORITHM=INPLACE, LOCK=NONE');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- -------------------------------------------------------------------------
-- 跑完自己看一眼：表在、索引在。
--
--   SHOW CREATE TABLE zt_galaxy_usage_rollup;
--   SELECT INDEX_NAME FROM information_schema.STATISTICS
--   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'zt_galaxy_quota_window'
--   GROUP BY INDEX_NAME;
--
-- 不用碰 Redis。额度窗口这一档新增了 5h（zt_galaxy_quota_grant.window 可以是 '5h'），
-- 那是代码里的事，不改表结构 —— 老的 day/week/month/total 行照旧生效。
--
-- 备用：客户端不让用 PREPARE / EXECUTE 时，直接跑下面这条。
-- 不幂等 —— 索引已经在会报 1061 Duplicate key name，那个错是无害的。
--
-- ALTER TABLE `zt_galaxy_quota_window` ADD INDEX `idx_gx_quota_window_key` (`biz_line`,`window_key`), ALGORITHM=INPLACE, LOCK=NONE;
-- -------------------------------------------------------------------------
