-- 共享算力池：机器上那两个**外部工具**（claude / codex）落四列。
--
-- 首选做法不是跑这份 SQL，而是：
--
--     cd server/galaxy-api && go run ./cmd/galaxyinit
--
-- 表结构的唯一出处是 service/galaxy/internal/repository/model.go，galaxyinit 按它
-- AutoMigrate。这份只给「目标环境跑不了 galaxyinit」的情况兜底。
--
--
-- 这四列是什么
--
-- 在这之前，「远端那台机器上 claude 装没装、是什么版本」平台是不知道的 —— 主人只能
-- ssh 上去看，装和升也只能在机器上手敲。现在节点每次心跳自报一次，控制台点一下就能
-- 让那台机器自己装：
--
--   tools_json         节点自报的一份 dto.NodeToolReport 数组：每个工具的本机版本、
--                      上游最新版、要不要升，以及**正在装的那一个走到哪了**
--   tool_command_id    控制台点下时生成的指令 id。节点在心跳的 job 里把它原样报回，
--                      Hub 看到就知道「机器领走了」，不再重发
--   tool_command_name  要装 / 升哪一个：claude 或 codex。**只有名字，没有命令** ——
--                      装什么包、怎么装在节点自己那张固定表里（原则 8：在我的机器上
--                      执行什么，这条边界不信任 Hub）
--   tool_command_at    点下那一刻。十分钟没人来领就作废：机器几小时后回来突然开始
--                      装东西，比没装上更糟
--
-- 它和 upgrade_* 那组列讲的不是一回事：那组升的是 ai-bridge 自己（要验签、换文件、
-- 重启进程），这组装的是它调用的两个命令行，失败了也只是这台机器少一种能力。
--
-- tools_json 只给人看，平台不拿它做任何判定（不派单、不计费）—— 同
-- upstream_usage_json 的性质：节点自报的数没法验证。
--
--
-- 写入频率
--
-- 心跳 15 秒一次，但服务端**只在这份 JSON 真的变了的时候才 UPDATE**
-- （见 service/galaxy/nodetools.go 的 saveNodeTools）。装东西那几十秒里它每一跳都在变，
-- 那是应该写的；平时一天也写不了几次。
--
-- 幂等：四列都用「先查 information_schema，已经在就跳过」的写法，反复执行安全。
-- 不用 DELIMITER、不建存储过程，理由见 20260916_galaxy_admin_indexes.sql。
--
-- 库：galaxy 那几个服务的 application.properties 里 sqlconn 指向的那个。


-- -------------------------------------------------------------------------
-- 1. tools_json —— 节点自报的工具状态
--
-- text 而不是 varchar：两个工具时才两三百字节，但里面还带着正在装的那一条进度
-- （阶段、百分比、npm 最后一行输出），而服务端对超过 8KB 的整份丢弃、不截断。
-- -------------------------------------------------------------------------

SET @have = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'zt_galaxy_node'
               AND COLUMN_NAME = 'tools_json');
SET @ddl = IF(@have > 0, 'SELECT 1',
  'ALTER TABLE `zt_galaxy_node` ADD COLUMN `tools_json` text AFTER `upgrade_updated_at`');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- -------------------------------------------------------------------------
-- 2. tool_command_id —— 待下发指令的 id
-- -------------------------------------------------------------------------

SET @have = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'zt_galaxy_node'
               AND COLUMN_NAME = 'tool_command_id');
SET @ddl = IF(@have > 0, 'SELECT 1',
  'ALTER TABLE `zt_galaxy_node` ADD COLUMN `tool_command_id` varchar(40) AFTER `tools_json`');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- -------------------------------------------------------------------------
-- 3. tool_command_name —— 装 / 升哪一个
-- -------------------------------------------------------------------------

SET @have = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'zt_galaxy_node'
               AND COLUMN_NAME = 'tool_command_name');
SET @ddl = IF(@have > 0, 'SELECT 1',
  'ALTER TABLE `zt_galaxy_node` ADD COLUMN `tool_command_name` varchar(32) AFTER `tool_command_id`');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- -------------------------------------------------------------------------
-- 4. tool_command_at —— 点下那一刻
--
-- 写成 `timestamp NULL DEFAULT NULL`，不能是裸 TIMESTAMP：
-- explicit_defaults_for_timestamp=OFF 时 MySQL 会静默补上
-- NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP，那样它会跟着
-- 任何一次 UPDATE 改写 —— 一条永远「刚刚点下」的指令，十分钟的作废时限就失效了。
-- -------------------------------------------------------------------------

SET @have = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'zt_galaxy_node'
               AND COLUMN_NAME = 'tool_command_at');
SET @ddl = IF(@have > 0, 'SELECT 1',
  'ALTER TABLE `zt_galaxy_node` ADD COLUMN `tool_command_at` timestamp NULL DEFAULT NULL AFTER `tool_command_name`');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- -------------------------------------------------------------------------
-- 跑完自己看一眼：四列都该在，而且 tool_command_at 必须是可空的。
--
--   SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
--   FROM information_schema.COLUMNS
--   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'zt_galaxy_node'
--     AND (COLUMN_NAME = 'tools_json' OR COLUMN_NAME LIKE 'tool_command%');
--
-- EXTRA 里出现 on update CURRENT_TIMESTAMP 就是上面第 4 段说的那个坑，要改回去。
--
-- 不用碰 Redis：这几列不进控制面，也不参与任何判定。
-- 老版本节点不报工具，tools_json 一直是空 —— 控制台那一格什么都不画，
-- 而且「安装」按钮会直说「这台机器的 ai-bridge 还不认识这个功能」。
--
-- 备用：客户端不让用 PREPARE / EXECUTE 时直接跑下面四条。
-- 不幂等 —— 列已经在会报 1060 Duplicate column name，那个错是无害的。
--
-- ALTER TABLE `zt_galaxy_node` ADD COLUMN `tools_json` text AFTER `upgrade_updated_at`;
-- ALTER TABLE `zt_galaxy_node` ADD COLUMN `tool_command_id` varchar(40) AFTER `tools_json`;
-- ALTER TABLE `zt_galaxy_node` ADD COLUMN `tool_command_name` varchar(32) AFTER `tool_command_id`;
-- ALTER TABLE `zt_galaxy_node` ADD COLUMN `tool_command_at` timestamp NULL DEFAULT NULL AFTER `tool_command_name`;
-- -------------------------------------------------------------------------
