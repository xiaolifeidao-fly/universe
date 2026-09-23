-- 共享算力池：登录留痕表。
--
-- 首选做法不是跑这份 SQL，而是：
--
--     cd server/galaxy-api && go run ./cmd/galaxyinit
--
-- 表结构的唯一出处是 service/galaxy/internal/repository/model.go，galaxyinit 按它
-- AutoMigrate。这份只给「目标环境跑不了 galaxyinit」的情况兜底。
--
--
-- 这张表是什么
--
-- 两端（共享端 Nova、使用端 Orbit）每一次登录尝试的流水，成功与失败都记。
-- 在这次改动之前，Galaxy 的两端登录**什么都不留**：被人拿着一串用户名扫过一轮
-- 之后，库里和日志里都不会有任何痕迹，连「什么时候开始的」都答不出来。
-- （管理端那边一直有 zt_manager_login_record，只是从来没人读它。）
--
-- 它是**证据**，不是闸门。同一次改动加的那道「连续失败就暂时拒绝」的闸，计数在
-- Redis 上（键 `<galaxy.redis_namespace>:login:<side>:u:<用户名>` 与 `…:ip:<地址>`，
-- 15 分钟自己过期）—— 判定要的是 INCR 那种原子性，按表里的行数算的话，一次并发
-- 打过来的几百个请求会同时读到「才失败 0 次」，于是一起放行。
--
-- 所以这张表**不在登录的关键路径上**：写不进去只记一行日志，登录照常。
--
--
-- 几个刻意的选择
--
--   不按端分表    账号表是按端分的（zt_galaxy_provider_user / _consumer_user），
--                 理由是「漏写 side 的查询会把另一端的人当成本人」。那条理由在
--                 流水上不成立：漏写 side 最多是多看到几行，而追一个人在两端都被
--                 试过什么，恰恰需要一次查两端。所以 side 只是一列。
--   username 照记  账号不存在时也落一行，user_id 留空。「有人拿着一串不存在的
--                 用户名在扫」本身就是要留下来的事实。
--   ip 只作线索    取的是 X-Forwarded-For 的第一跳，经代理转发过来，实际上是访问者
--                 自己填的。不参与任何鉴权或归属判断。
--
--
-- 幂等：CREATE TABLE IF NOT EXISTS，反复执行安全。
--
-- 库：galaxy 那几个服务的 application.properties 里 sqlconn 指向的那个。


CREATE TABLE IF NOT EXISTS `zt_galaxy_login_record` (
  `id`           bigint AUTO_INCREMENT,
  `biz_line`     varchar(32),
  `side`         varchar(16),
  `user_id`      varchar(40),
  `username`     varchar(64),
  `ip`           varchar(64),
  `user_agent`   varchar(256),
  `success`      boolean DEFAULT false,
  `reason`       varchar(128),
  `created_time` datetime(3) NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_gx_login_name` (`biz_line`,`side`,`username`,`created_time` desc),
  INDEX `idx_gx_login_ip` (`biz_line`,`ip`,`created_time` desc)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- -------------------------------------------------------------------------
-- 跑完自己看一眼：
--
--   SELECT COUNT(*) FROM information_schema.TABLES
--   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'zt_galaxy_login_record';
--
-- 然后在任意一端登录一次（成功一次、故意错一次），表里应该各多一行：
--
--   SELECT side, username, ip, success, reason, created_time
--   FROM zt_galaxy_login_record ORDER BY id DESC LIMIT 10;
--
-- 闸本身不需要迁移，Redis 上那几个键用到才建、15 分钟自己过期。要临时给某个被
-- 锁住的人解锁，删掉对应的键即可（不必重启服务）：
--
--   DEL <galaxy.redis_namespace>:login:consumer:u:<用户名>
--
-- 管理端那一侧同理，前缀是 <manager.redis_namespace>:login:u:<用户名>。
-- -------------------------------------------------------------------------
