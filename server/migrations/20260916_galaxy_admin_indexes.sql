-- 共享算力池：给管理端新增的那几页补索引。
--
-- **这是这一轮唯一的表结构变更，而且它是可选的。**
-- 新页面一条列都没加、一张表都没建；不跑这份，功能一样是通的，只是几条查询会慢。
--
--
-- 为什么原来的索引不够用：
--
-- 这些表上的索引都是按「某个人的那些行」建的 —— 第一列 biz_line，第二列是
-- owner / key_id / cid / unit_id 之类的主体。用户侧的查询永远带着主体
-- （「我的账本」「这台机器的偏差」），走得很好。
--
-- 而运营侧的查询**没有主体**：它问的是「最近 30 天全站的账本」「今天全池在跑什么」。
-- 跳过第二列之后，第三列的 created_at 就用不上了 —— MySQL 只能按 biz_line 扫一遍
-- 再排序。表小的时候无所谓，这几张不是小表：单元表和三本账都是一次请求写若干行。
--
-- 所以补的都是 (biz_line, 时间, 分组列) 这个形状：时间管住范围，第三列让
-- 「按类型 / 状态分组计数」那一步能在索引里做完。
--
--
-- 没补的，也说清楚：
--
--   zt_galaxy_payout、zt_galaxy_order  运营侧查询同样没有主体，但这两张表一行
--   对应一笔申请 / 一笔订单，量级和用户数同阶，不和请求数同阶。几万行的 filesort
--   是几毫秒的事。等到「订单列表打开明显变慢」再补 (biz_line, status, created_time)，
--   现在补是在给一张不疼的表加写入成本。
--
--
-- 跑之前要知道的：
--
--   建二级索引走 ONLINE DDL（下面每条都显式写了 ALGORITHM=INPLACE, LOCK=NONE），
--   **不锁表**，但要把整张表读一遍、写一份索引，时间和 I/O 跟表的大小成正比。
--   zt_galaxy_unit 和三本账是这套系统里最大的几张表 —— 挑低峰跑，一段一段跑，
--   别开一个事务把五条包在一起。
--
--
-- 这份脚本**不用 DELIMITER，也不建存储过程**：每一条都是独立的、以分号结尾的语句。
--
--   上一版用存储过程做幂等，而 DELIMITER 是 mysql 命令行客户端自己的指令、不是 SQL。
--   图形客户端（DataGrip / Navicat / DBeaver）按分号切语句，会把过程体从中间劈开，
--   报一串 1064，然后每条 CALL 都说「过程不存在」。迁移脚本不该依赖某一个客户端。
--
--   幂等靠「先数一下 information_schema，已经在就换成一句 SELECT 1」——
--   MySQL 没有 CREATE INDEX IF NOT EXISTS，这是不带过程的标准做法。
--   跑完看结果：某一段返回一个 1，表示那条索引本来就在、跳过了。反复执行安全。
--
--   要是你的客户端连 PREPARE / EXECUTE 也不让用（少数连接池代理会挡），
--   直接用文件末尾那五条**朴素 ALTER**。它们不幂等 —— 索引已经在会报
--   1061 Duplicate key name，那个错本身是无害的，看到就说明这一条不用再建。
--
-- 库：galaxy 那几个服务的 application.properties 里 sqlconn 指向的那个
--     （和 manager-api 是同一个库，见 server/SCHEMA.md）。


-- -------------------------------------------------------------------------
-- 1. 运行工单（/galaxy/units、运营总览的「今天的工单」）
--
-- 查的是 WHERE biz_line = ? AND created_time >= ? [AND state = ?]
--        ORDER BY created_time DESC，以及按 state 分组计数。
-- 第三列放 state：分组那一步就不用回表了。
--
-- 这是最大的一张表 —— 一次请求一行，重试再多一行。先跑它，心里有数。
-- -------------------------------------------------------------------------

SET @have = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'zt_galaxy_unit'
               AND INDEX_NAME = 'idx_gx_unit_admin');
SET @ddl = IF(@have > 0, 'SELECT 1',
  'ALTER TABLE `zt_galaxy_unit` ADD INDEX `idx_gx_unit_admin` (`biz_line`,`created_time`,`state`), ALGORITHM=INPLACE, LOCK=NONE');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- -------------------------------------------------------------------------
-- 2. 使用侧账本（/galaxy/ledger）
--
-- 三本账查的都是 WHERE biz_line = ? AND created_at >= ? [AND type IN (...)]
--        ORDER BY created_at DESC，以及按 type 分组求和。
-- -------------------------------------------------------------------------

SET @have = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'zt_galaxy_consumer_ledger'
               AND INDEX_NAME = 'idx_gx_consumer_ledger_admin');
SET @ddl = IF(@have > 0, 'SELECT 1',
  'ALTER TABLE `zt_galaxy_consumer_ledger` ADD INDEX `idx_gx_consumer_ledger_admin` (`biz_line`,`created_at`,`type`), ALGORITHM=INPLACE, LOCK=NONE');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- -------------------------------------------------------------------------
-- 3. 供给侧账本
-- -------------------------------------------------------------------------

SET @have = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'zt_galaxy_provider_ledger'
               AND INDEX_NAME = 'idx_gx_provider_ledger_admin');
SET @ddl = IF(@have > 0, 'SELECT 1',
  'ALTER TABLE `zt_galaxy_provider_ledger` ADD INDEX `idx_gx_provider_ledger_admin` (`biz_line`,`created_at`,`type`), ALGORITHM=INPLACE, LOCK=NONE');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- -------------------------------------------------------------------------
-- 4. 平台侧账本
--
-- 这张表此前**一个时间索引都没有**（只有 (biz_line, txn_id) 的唯一键），
-- 而它恰恰是这一轮才第一次被读 —— 毛利与坏账写了很久，没人查过。
-- -------------------------------------------------------------------------

SET @have = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'zt_galaxy_platform_ledger'
               AND INDEX_NAME = 'idx_gx_platform_ledger_admin');
SET @ddl = IF(@have > 0, 'SELECT 1',
  'ALTER TABLE `zt_galaxy_platform_ledger` ADD INDEX `idx_gx_platform_ledger_admin` (`biz_line`,`created_at`,`type`), ALGORITHM=INPLACE, LOCK=NONE');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- -------------------------------------------------------------------------
-- 5. 用量偏差（/galaxy/mismatches）
--
-- 查的是 WHERE biz_line = ? AND created_at >= ? ORDER BY created_at DESC，
-- 以及按 cid 分组数「谁反复上榜」—— 那个排行才是这一页的结论，
-- 而 cid 原来不在任何索引里。
-- -------------------------------------------------------------------------

SET @have = (SELECT COUNT(*) FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'zt_galaxy_usage_mismatch'
               AND INDEX_NAME = 'idx_gx_usage_mismatch_admin');
SET @ddl = IF(@have > 0, 'SELECT 1',
  'ALTER TABLE `zt_galaxy_usage_mismatch` ADD INDEX `idx_gx_usage_mismatch_admin` (`biz_line`,`created_at`,`cid`), ALGORITHM=INPLACE, LOCK=NONE');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- -------------------------------------------------------------------------
-- 跑完自己看一眼：五条都该在。
--
--   SELECT TABLE_NAME, INDEX_NAME
--   FROM information_schema.STATISTICS
--   WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME LIKE '%\_admin'
--   GROUP BY TABLE_NAME, INDEX_NAME;
--
-- 不用碰 Redis：这份只改索引，和管理端的菜单 / 权限缓存无关。
-- -------------------------------------------------------------------------
-- 备用：朴素写法
--
-- 客户端不让用 PREPARE / EXECUTE 时，把下面五条取消注释单独跑。
-- 不幂等 —— 索引已经在会报 1061 Duplicate key name，那个错是无害的。
-- -------------------------------------------------------------------------
--
-- ALTER TABLE `zt_galaxy_unit`            ADD INDEX `idx_gx_unit_admin`            (`biz_line`,`created_time`,`state`), ALGORITHM=INPLACE, LOCK=NONE;
-- ALTER TABLE `zt_galaxy_consumer_ledger` ADD INDEX `idx_gx_consumer_ledger_admin` (`biz_line`,`created_at`,`type`),    ALGORITHM=INPLACE, LOCK=NONE;
-- ALTER TABLE `zt_galaxy_provider_ledger` ADD INDEX `idx_gx_provider_ledger_admin` (`biz_line`,`created_at`,`type`),    ALGORITHM=INPLACE, LOCK=NONE;
-- ALTER TABLE `zt_galaxy_platform_ledger` ADD INDEX `idx_gx_platform_ledger_admin` (`biz_line`,`created_at`,`type`),    ALGORITHM=INPLACE, LOCK=NONE;
-- ALTER TABLE `zt_galaxy_usage_mismatch`  ADD INDEX `idx_gx_usage_mismatch_admin`  (`biz_line`,`created_at`,`cid`),     ALGORITHM=INPLACE, LOCK=NONE;
