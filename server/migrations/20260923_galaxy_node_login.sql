-- 共享算力池：远端登录（让机器上的 claude / codex 自己登上游订阅）落五列。
--
-- 首选做法不是跑这份 SQL，而是：
--
--     cd server/galaxy-api && go run ./cmd/galaxyinit
--
-- 表结构的唯一出处是 service/galaxy/internal/repository/model.go，galaxyinit 按它
-- AutoMigrate。这份只给「目标环境跑不了 galaxyinit」的情况兜底。
--
--
-- 这五列是什么
--
-- 在这之前，一台没有图形界面的机器要登录 claude 或 codex，只能 ssh 上去手敲；
-- 而「这台机器上的 claude 到底登没登」平台也答不上来 —— 节点报的只有版本号。
-- 现在控制台点一下就能让那台机器自己登：
--
--   logins_json         节点自报的一份 dto.NodeLoginReport 数组：授权地址、短码、
--                       这一次走到哪了
--   login_command_id    控制台点下时生成的指令 id。节点在心跳的 commandId 里原样报回
--   login_command_name  登录哪一个：claude 或 codex。**只有名字，没有命令** ——
--                       跑什么在节点自己那张固定表里（原则 8）
--   login_command_code  主人在浏览器里授权完粘回来的那串一次性授权码
--   login_command_at    点下那一刻。十五分钟没结果就作废
--
-- 为什么要有 login_command_code 这一列（这是这次改动里唯一需要解释的东西）
--
--   codex 走设备码：机器拿到短码和地址，主人在任意一台有浏览器的设备上输码，机器自己
--   轮询换 token。**单向**，这一列用不上。
--
--   claude 没有设备码流程。`claude auth login` 打印一条授权地址，主人授权完由
--   platform.claude.com 的托管回调页把码显示出来，而机器那边的进程**卡在 stdin 上
--   等这串码**。所以必须有回程：码经这一列搭下一跳心跳送回那台机器。
--
--   回程为什么不单开一条连接：poll 接入的机器 Hub 根本连不上它（只有 export 节点有
--   入站面），机房里的机器多半是 poll。心跳是唯一的下行。
--
-- 这串码不是凭据，是一次性的、几分钟就过期的授权码，**送达即清**
-- （见 service/galaxy/nodelogin.go 的 clearLoginCommand）。换来的 token 只落在那台
-- 机器上，Hub 这边从头到尾看不到。
--
-- 和 tool_command_* 那组列是**两条独立的槽**：一台机器可以一边装 codex 一边登录
-- claude，共用一个槽会互相顶掉。
--
--
-- 写入频率
--
-- 同 tools_json：只在这份 JSON 真的变了的时候才 UPDATE（见 saveNodeLogins）。
-- 登录那几分钟节点会把心跳提到 5 秒一跳，那期间它确实每跳都在变 —— 那是应该写的；
-- 没人登录时一天也写不了几次。
--
-- 幂等：五列都用「先查 information_schema，已经在就跳过」的写法，反复执行安全。
--
-- 库：galaxy 那几个服务的 application.properties 里 sqlconn 指向的那个。


-- -------------------------------------------------------------------------
-- 1. logins_json —— 节点自报的登录会话
--
-- text 而不是 varchar：一条会话里带着完整的授权地址（claude 那条有 400 多字符）、
-- 短码、以及失败时 CLI 的原话，服务端对超过 8KB 的整份丢弃、不截断。
-- -------------------------------------------------------------------------

SET @have = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'zt_galaxy_node'
               AND COLUMN_NAME = 'logins_json');
SET @ddl = IF(@have > 0, 'SELECT 1',
  'ALTER TABLE `zt_galaxy_node` ADD COLUMN `logins_json` text AFTER `tool_command_at`');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- -------------------------------------------------------------------------
-- 2. login_command_id —— 待下发指令的 id
-- -------------------------------------------------------------------------

SET @have = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'zt_galaxy_node'
               AND COLUMN_NAME = 'login_command_id');
SET @ddl = IF(@have > 0, 'SELECT 1',
  'ALTER TABLE `zt_galaxy_node` ADD COLUMN `login_command_id` varchar(40) AFTER `logins_json`');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- -------------------------------------------------------------------------
-- 3. login_command_name —— 登录哪一个
-- -------------------------------------------------------------------------

SET @have = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'zt_galaxy_node'
               AND COLUMN_NAME = 'login_command_name');
SET @ddl = IF(@have > 0, 'SELECT 1',
  'ALTER TABLE `zt_galaxy_node` ADD COLUMN `login_command_name` varchar(32) AFTER `login_command_id`');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- -------------------------------------------------------------------------
-- 4. login_command_code —— 主人粘回来的一次性授权码
--
-- varchar(255)：两边的码都在几十个字符以内，这个数只防一个超长输入把 UPDATE 打回来
-- （服务端也按同一个数先挡一次，见 loginCodeMax）。
-- -------------------------------------------------------------------------

SET @have = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'zt_galaxy_node'
               AND COLUMN_NAME = 'login_command_code');
SET @ddl = IF(@have > 0, 'SELECT 1',
  'ALTER TABLE `zt_galaxy_node` ADD COLUMN `login_command_code` varchar(255) AFTER `login_command_name`');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- -------------------------------------------------------------------------
-- 5. login_command_at —— 点下那一刻
--
-- 同 tool_command_at：必须写成 `timestamp NULL DEFAULT NULL`，不能是裸 TIMESTAMP。
-- explicit_defaults_for_timestamp=OFF 时 MySQL 会静默补上 ON UPDATE CURRENT_TIMESTAMP，
-- 那样它会跟着任何一次 UPDATE 改写 —— 一条永远「刚刚点下」的指令，作废时限就失效了。
-- -------------------------------------------------------------------------

SET @have = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'zt_galaxy_node'
               AND COLUMN_NAME = 'login_command_at');
SET @ddl = IF(@have > 0, 'SELECT 1',
  'ALTER TABLE `zt_galaxy_node` ADD COLUMN `login_command_at` timestamp NULL DEFAULT NULL AFTER `login_command_code`');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;


-- -------------------------------------------------------------------------
-- 跑完自己看一眼：五列都该在，而且 login_command_at 必须是可空的。
--
--   SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
--   FROM information_schema.COLUMNS
--   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'zt_galaxy_node'
--     AND (COLUMN_NAME = 'logins_json' OR COLUMN_NAME LIKE 'login_command%');
--
-- EXTRA 里出现 on update CURRENT_TIMESTAMP 就是上面第 5 段说的那个坑，要改回去。
--
-- 不用碰 Redis：这几列不进控制面，也不参与任何判定。
-- 老版本节点不认识登录指令，logins_json 一直是空 —— 控制台那一格什么都不画，
-- 而且「登录」按钮会直说「这台机器的 ai-bridge 还不认识这个功能」。
--
-- 备用：客户端不让用 PREPARE / EXECUTE 时直接跑下面五条。
-- 不幂等 —— 列已经在会报 1060 Duplicate column name，那个错是无害的。
--
-- ALTER TABLE `zt_galaxy_node` ADD COLUMN `logins_json` text AFTER `tool_command_at`;
-- ALTER TABLE `zt_galaxy_node` ADD COLUMN `login_command_id` varchar(40) AFTER `logins_json`;
-- ALTER TABLE `zt_galaxy_node` ADD COLUMN `login_command_name` varchar(32) AFTER `login_command_id`;
-- ALTER TABLE `zt_galaxy_node` ADD COLUMN `login_command_code` varchar(255) AFTER `login_command_name`;
-- ALTER TABLE `zt_galaxy_node` ADD COLUMN `login_command_at` timestamp NULL DEFAULT NULL AFTER `login_command_code`;
-- -------------------------------------------------------------------------
