-- Galaxy 账号体系从任务宇宙独立出来，两端各一张表。
--
-- 改之前：Nova / Orbit 登录用的是任务宇宙的账号（zt_identity_user，POST /api/auth/login），
-- 池内表里的 owner_user_id 存的是那边的数字主键，令牌和 web-api 通用。
--
-- 改之后：Galaxy 有自己的账号表，而且共享端（Nova）和使用端（Orbit）各一张：
-- zt_galaxy_provider_user 和 zt_galaxy_consumer_user。两端是两批人，各注册各的，
-- user_id 带端的前缀（pu_ / cu_），池内表里存的换成这个；令牌是 Galaxy 自己签的，
-- 两端之间、和任务宇宙之间都不通用。
--
-- 两张表的列一模一样 —— 分表不是为了让两端长得不一样，是为了它们在库里没有交集：
-- 查账号必须先说清是哪一端，漏掉端的查询查不出东西来，而不是安安静静地把另一端的人捞出来。
--
-- 这份脚本做四件事：
--   1. 建 zt_galaxy_provider_user 和 zt_galaxy_consumer_user
--   2. 这份脚本的**上一版**建的是一张两端共用的 zt_galaxy_user。那张表还在的话，
--      按它的 side 列把行搬进对应的新表（旧表不删，留作后路）
--   3. 名下有 Galaxy 数据的任务宇宙账号，在用到的那一端各建一个同名 Galaxy 账号，沿用原密码
--      （同一套 bcrypt），user_id 是 pu_legacy_<原 id> / cu_legacy_<原 id> —— 一眼看得出是迁过来的
--   4. 把池内表里纯数字的 owner 改成对应的 legacy id
--
-- 第 2 步必须在第 3 步之前：反过来的话，同一个 legacy 账号会先从任务宇宙建一遍、
-- 再从旧表搬一遍，第二遍撞用户名唯一键。
--
-- **顺序：先跑这份，再发新版 galaxy-api、manager-api 和 Nova / Orbit。** 两个服务都要读这两张表：
-- galaxy-api 没有它们登录注册全挂，manager-api 的「节点与贡献」要按共享端那张查机器主人的名字，
-- 缺表整页报错。
-- 另外，新注册入口一开，有人可能抢先注册了老用户的用户名，第 3 步只好给老账号换成 <用户名>-legacy<原 id>。
-- 老用户的名下数据不会跟着同名的新账号走 —— 那等于谁先抢到用户名谁拿走别人的积分。
--
-- 最稳妥的做法是先停 galaxy-api 再跑：迁移和新版上线之间，老服务还会按数字 id 往池内表里写，
-- 也还会往旧的 zt_galaxy_user 里写新注册的账号。那段时间进来的行，重跑一次这份脚本会接着搬、
-- 接着改；但积分账户、信誉这两张表按 owner 唯一，老服务要是给同一个人新建了一行数字 owner 的，
-- 重跑会在那一句报 1062，要人工把两行并起来。
--
-- 幂等：建表 IF NOT EXISTS；搬行、建账号都先按 user_id 查重；改 owner 只改纯数字的值，改过的不再改。
-- 中途失败修好了直接重跑即可 —— 包括「第 3 步建账号报错、客户端却选了出错继续、第 4 步照样
-- 把 owner 改完了」这种半截状态：第 3 步收集老 owner 时，已经改成 legacy id 的也算，重跑会把缺的账号补上。
--
-- 依赖：20260907_galaxy_dispute、20260910_galaxy_payout、20260911_galaxy_node_access_mode、
--      20260911_galaxy_provider_reputation 已经跑过（要用到它们建的表）。
--
-- 不改任务宇宙的任何表，zt_identity_user 只读。
-- Redis 里节点快照上的 ownerUserId 不用管：节点下一次 hello 会按库里的新值重建。


-- -------------------------------------------------------------------------
-- 1. 两张账号表（与 server/galaxy.sql 一致）
--
-- 索引名两张表相同：MySQL 的索引名只在表内唯一，不必给它们起两套名字。
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `zt_galaxy_provider_user` (
  `id`                   bigint AUTO_INCREMENT,
  `biz_line`             varchar(32),
  `user_id`              varchar(40),
  `username`             varchar(64),
  `display_name`         varchar(128),
  `password_hash`        varchar(255),
  `status`               varchar(16),
  `must_change_password` boolean DEFAULT false,
  `token_version`        bigint DEFAULT 1,
  `last_login_at`        timestamp null default null,
  `updated_by`           varchar(64),
  `created_time`         datetime(3) NULL,
  `updated_time`         datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_user_id` (`biz_line`,`user_id`),
  UNIQUE INDEX `uk_gx_user_name` (`biz_line`,`username`),
  INDEX `idx_gx_user_status` (`biz_line`,`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_galaxy_consumer_user` (
  `id`                   bigint AUTO_INCREMENT,
  `biz_line`             varchar(32),
  `user_id`              varchar(40),
  `username`             varchar(64),
  `display_name`         varchar(128),
  `password_hash`        varchar(255),
  `status`               varchar(16),
  `must_change_password` boolean DEFAULT false,
  `token_version`        bigint DEFAULT 1,
  `last_login_at`        timestamp null default null,
  `updated_by`           varchar(64),
  `created_time`         datetime(3) NULL,
  `updated_time`         datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_user_id` (`biz_line`,`user_id`),
  UNIQUE INDEX `uk_gx_user_name` (`biz_line`,`username`),
  INDEX `idx_gx_user_status` (`biz_line`,`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- -------------------------------------------------------------------------
-- 2. 上一版建的两端共用表 zt_galaxy_user：按 side 把行搬进对应的新表
--
-- 库里没有那张表（全新环境，第一次跑的就是这一版）时整段跳过 —— 所以要动态拼语句：
-- 直接写 SELECT ... FROM zt_galaxy_user 的话，全新库上会报 1146「表不存在」。
--
-- 旧表里的用户名在同一端内本来就唯一（旧唯一键是 biz_line + side + username），
-- 按端拆开之后还是唯一的，搬不会撞 uk_gx_user_name。
-- 自增 id 不搬：那是行号不是身份，身份是 user_id。
--
-- 旧表不删也不改名。确认新表数据无误、服务跑起来之后再手工 DROP：
--   DROP TABLE `zt_galaxy_user`;
-- -------------------------------------------------------------------------

SET @legacy_table := (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'zt_galaxy_user'
);

SET @statement := IF(@legacy_table > 0,
  'INSERT INTO `zt_galaxy_provider_user`
     (`biz_line`,`user_id`,`username`,`display_name`,`password_hash`,`status`,
      `must_change_password`,`token_version`,`last_login_at`,`updated_by`,`created_time`,`updated_time`)
   SELECT o.`biz_line`, o.`user_id`, o.`username`, o.`display_name`, o.`password_hash`, o.`status`,
          o.`must_change_password`, o.`token_version`, o.`last_login_at`, o.`updated_by`,
          o.`created_time`, o.`updated_time`
     FROM `zt_galaxy_user` o
    WHERE o.`side` = ''provider''
      AND NOT EXISTS (SELECT 1 FROM `zt_galaxy_provider_user` n
                       WHERE n.`biz_line` = o.`biz_line` AND n.`user_id` = o.`user_id`)',
  'SELECT 1');
PREPARE move_provider_users FROM @statement;
EXECUTE move_provider_users;
DEALLOCATE PREPARE move_provider_users;

SET @statement := IF(@legacy_table > 0,
  'INSERT INTO `zt_galaxy_consumer_user`
     (`biz_line`,`user_id`,`username`,`display_name`,`password_hash`,`status`,
      `must_change_password`,`token_version`,`last_login_at`,`updated_by`,`created_time`,`updated_time`)
   SELECT o.`biz_line`, o.`user_id`, o.`username`, o.`display_name`, o.`password_hash`, o.`status`,
          o.`must_change_password`, o.`token_version`, o.`last_login_at`, o.`updated_by`,
          o.`created_time`, o.`updated_time`
     FROM `zt_galaxy_user` o
    WHERE o.`side` = ''consumer''
      AND NOT EXISTS (SELECT 1 FROM `zt_galaxy_consumer_user` n
                       WHERE n.`biz_line` = o.`biz_line` AND n.`user_id` = o.`user_id`)',
  'SELECT 1');
PREPARE move_consumer_users FROM @statement;
EXECUTE move_consumer_users;
DEALLOCATE PREPARE move_consumer_users;


-- -------------------------------------------------------------------------
-- 3. 老账号：先把「谁在哪一端有数据」收进临时表，再建账号
--
-- 必须在第 4 步改 owner 之前收：改完就认不出哪些是老的了。所以已经带 legacy 前缀的也收 ——
-- 上一次跑到一半（owner 改了、账号没建成）时，只有从它们身上才找得回是谁。
-- 一个人两端都有数据（既挂机又买额度）就建两个账号，这正是新规则下该有的样子。
--
-- 临时表显式写 utf8mb4：不写就继承库的默认字符集（线上库是 utf8mb3），排序规则和
-- zt_galaxy_* 那几张 utf8mb4 的表对不上时，拿它的列去和表列比较会报 1267。
-- -------------------------------------------------------------------------

DROP TEMPORARY TABLE IF EXISTS `tmp_gx_legacy_owner`;
CREATE TEMPORARY TABLE `tmp_gx_legacy_owner` (
  `side`        varchar(16) NOT NULL,
  `identity_id` bigint      NOT NULL,
  PRIMARY KEY (`side`, `identity_id`)
) DEFAULT CHARSET=utf8mb4;

-- 共享端：机器、贡献、配对码、接入密钥、积分、提现、身份、被申诉的贡献主人、信誉、条款同意
INSERT IGNORE INTO `tmp_gx_legacy_owner` SELECT 'provider', CAST(REPLACE(`owner_user_id`, 'pu_legacy_', '') AS UNSIGNED) FROM `zt_galaxy_node`           WHERE `biz_line` = 'galaxy' AND `owner_user_id` REGEXP '^(pu_legacy_)?[0-9]+$';
INSERT IGNORE INTO `tmp_gx_legacy_owner` SELECT 'provider', CAST(REPLACE(`owner_user_id`, 'pu_legacy_', '') AS UNSIGNED) FROM `zt_galaxy_contribution`   WHERE `biz_line` = 'galaxy' AND `owner_user_id` REGEXP '^(pu_legacy_)?[0-9]+$';
INSERT IGNORE INTO `tmp_gx_legacy_owner` SELECT 'provider', CAST(REPLACE(`owner_user_id`, 'pu_legacy_', '') AS UNSIGNED) FROM `zt_galaxy_pairing_code`   WHERE `biz_line` = 'galaxy' AND `owner_user_id` REGEXP '^(pu_legacy_)?[0-9]+$';
INSERT IGNORE INTO `tmp_gx_legacy_owner` SELECT 'provider', CAST(REPLACE(`owner_user_id`, 'pu_legacy_', '') AS UNSIGNED) FROM `zt_galaxy_provider_key`   WHERE `biz_line` = 'galaxy' AND `owner_user_id` REGEXP '^(pu_legacy_)?[0-9]+$';
INSERT IGNORE INTO `tmp_gx_legacy_owner` SELECT 'provider', CAST(REPLACE(`owner_user_id`, 'pu_legacy_', '') AS UNSIGNED) FROM `zt_galaxy_credit_account` WHERE `biz_line` = 'galaxy' AND `owner_user_id` REGEXP '^(pu_legacy_)?[0-9]+$';
INSERT IGNORE INTO `tmp_gx_legacy_owner` SELECT 'provider', CAST(REPLACE(`owner_user_id`, 'pu_legacy_', '') AS UNSIGNED) FROM `zt_galaxy_provider_ledger` WHERE `biz_line` = 'galaxy' AND `owner_user_id` REGEXP '^(pu_legacy_)?[0-9]+$';
INSERT IGNORE INTO `tmp_gx_legacy_owner` SELECT 'provider', CAST(REPLACE(`owner_user_id`, 'pu_legacy_', '') AS UNSIGNED) FROM `zt_galaxy_payout`         WHERE `biz_line` = 'galaxy' AND `owner_user_id` REGEXP '^(pu_legacy_)?[0-9]+$';
INSERT IGNORE INTO `tmp_gx_legacy_owner` SELECT 'provider', CAST(REPLACE(`owner_user_id`, 'pu_legacy_', '') AS UNSIGNED) FROM `zt_galaxy_provider`       WHERE `biz_line` = 'galaxy' AND `owner_user_id` REGEXP '^(pu_legacy_)?[0-9]+$';
INSERT IGNORE INTO `tmp_gx_legacy_owner` SELECT 'provider', CAST(REPLACE(`provider_user_id`, 'pu_legacy_', '') AS UNSIGNED) FROM `zt_galaxy_dispute`    WHERE `biz_line` = 'galaxy' AND `provider_user_id` REGEXP '^(pu_legacy_)?[0-9]+$';
INSERT IGNORE INTO `tmp_gx_legacy_owner` SELECT 'provider', CAST(REPLACE(SUBSTRING(`subject`, 9), 'pu_legacy_', '') AS UNSIGNED) FROM `zt_galaxy_reputation` WHERE `biz_line` = 'galaxy' AND `subject` REGEXP '^account:(pu_legacy_)?[0-9]+$';
INSERT IGNORE INTO `tmp_gx_legacy_owner` SELECT 'provider', CAST(REPLACE(`user_id`, 'pu_legacy_', '') AS UNSIGNED) FROM `zt_galaxy_consent_record`       WHERE `biz_line` = 'galaxy' AND `subject_type` = 'provider' AND `user_id` REGEXP '^(pu_legacy_)?[0-9]+$';

-- 使用端：算力密钥、订单、自己提的申诉、数据告知确认
INSERT IGNORE INTO `tmp_gx_legacy_owner` SELECT 'consumer', CAST(REPLACE(`owner_user_id`, 'cu_legacy_', '') AS UNSIGNED) FROM `zt_galaxy_consumer_key`   WHERE `biz_line` = 'galaxy' AND `owner_user_id` REGEXP '^(cu_legacy_)?[0-9]+$';
INSERT IGNORE INTO `tmp_gx_legacy_owner` SELECT 'consumer', CAST(REPLACE(`user_id`, 'cu_legacy_', '') AS UNSIGNED) FROM `zt_galaxy_order`                WHERE `biz_line` = 'galaxy' AND `user_id` REGEXP '^(cu_legacy_)?[0-9]+$';
INSERT IGNORE INTO `tmp_gx_legacy_owner` SELECT 'consumer', CAST(REPLACE(`owner_user_id`, 'cu_legacy_', '') AS UNSIGNED) FROM `zt_galaxy_dispute`        WHERE `biz_line` = 'galaxy' AND `owner_user_id` REGEXP '^(cu_legacy_)?[0-9]+$';
INSERT IGNORE INTO `tmp_gx_legacy_owner` SELECT 'consumer', CAST(REPLACE(`user_id`, 'cu_legacy_', '') AS UNSIGNED) FROM `zt_galaxy_consent_record`       WHERE `biz_line` = 'galaxy' AND `subject_type` = 'consumer' AND `user_id` REGEXP '^(cu_legacy_)?[0-9]+$';

-- 建账号，两端各一条 INSERT —— 一条语句写不了两张表。
-- 用户名在那一端已经被占了（新入口先开、有人抢注，或者第 2 步搬过来的同名账号）就加后缀，
-- 不和别人的账号合并。任务宇宙里停用的账号迁过来也是停用。
INSERT INTO `zt_galaxy_provider_user`
  (`biz_line`, `user_id`, `username`, `display_name`, `password_hash`, `status`,
   `must_change_password`, `token_version`, `created_time`, `updated_time`)
SELECT 'galaxy',
       CONCAT('pu_legacy_', u.`id`),
       IF(EXISTS (SELECT 1 FROM `zt_galaxy_provider_user` g
                   WHERE g.`biz_line` = 'galaxy' AND g.`username` = LOWER(TRIM(u.`username`))),
          CONCAT(LOWER(TRIM(u.`username`)), '-legacy', u.`id`),
          LOWER(TRIM(u.`username`))),
       u.`display_name`,
       u.`password_hash`,
       IF(u.`status` = 'active', 'active', 'disabled'),
       false, 1, NOW(3), NOW(3)
FROM `tmp_gx_legacy_owner` o
JOIN `zt_identity_user` u ON u.`id` = o.`identity_id`
WHERE o.`side` = 'provider'
  AND NOT EXISTS (
    SELECT 1 FROM `zt_galaxy_provider_user` g
     WHERE g.`biz_line` = 'galaxy' AND g.`user_id` = CONCAT('pu_legacy_', u.`id`)
  );

INSERT INTO `zt_galaxy_consumer_user`
  (`biz_line`, `user_id`, `username`, `display_name`, `password_hash`, `status`,
   `must_change_password`, `token_version`, `created_time`, `updated_time`)
SELECT 'galaxy',
       CONCAT('cu_legacy_', u.`id`),
       IF(EXISTS (SELECT 1 FROM `zt_galaxy_consumer_user` g
                   WHERE g.`biz_line` = 'galaxy' AND g.`username` = LOWER(TRIM(u.`username`))),
          CONCAT(LOWER(TRIM(u.`username`)), '-legacy', u.`id`),
          LOWER(TRIM(u.`username`))),
       u.`display_name`,
       u.`password_hash`,
       IF(u.`status` = 'active', 'active', 'disabled'),
       false, 1, NOW(3), NOW(3)
FROM `tmp_gx_legacy_owner` o
JOIN `zt_identity_user` u ON u.`id` = o.`identity_id`
WHERE o.`side` = 'consumer'
  AND NOT EXISTS (
    SELECT 1 FROM `zt_galaxy_consumer_user` g
     WHERE g.`biz_line` = 'galaxy' AND g.`user_id` = CONCAT('cu_legacy_', u.`id`)
  );

DROP TEMPORARY TABLE IF EXISTS `tmp_gx_legacy_owner`;


-- -------------------------------------------------------------------------
-- 4. 池内表的 owner 换成 Galaxy 账号的 id
--
-- 只改纯数字的值：新账号的 id 带前缀，改过一次的也带前缀，重跑不会再改。
-- 任务宇宙里已经删掉的账号，名下数据照样改成 legacy id —— 它们本来就没人能登录去看。
-- handled_by / updated_by 这类「哪个运营操作的」不动：那是当时操作者的留痕，不是归属。
-- -------------------------------------------------------------------------

UPDATE `zt_galaxy_node`           SET `owner_user_id` = CONCAT('pu_legacy_', `owner_user_id`) WHERE `biz_line` = 'galaxy' AND `owner_user_id` REGEXP '^[0-9]+$';
UPDATE `zt_galaxy_contribution`   SET `owner_user_id` = CONCAT('pu_legacy_', `owner_user_id`) WHERE `biz_line` = 'galaxy' AND `owner_user_id` REGEXP '^[0-9]+$';
UPDATE `zt_galaxy_pairing_code`   SET `owner_user_id` = CONCAT('pu_legacy_', `owner_user_id`) WHERE `biz_line` = 'galaxy' AND `owner_user_id` REGEXP '^[0-9]+$';
UPDATE `zt_galaxy_provider_key`   SET `owner_user_id` = CONCAT('pu_legacy_', `owner_user_id`) WHERE `biz_line` = 'galaxy' AND `owner_user_id` REGEXP '^[0-9]+$';
UPDATE `zt_galaxy_credit_account` SET `owner_user_id` = CONCAT('pu_legacy_', `owner_user_id`) WHERE `biz_line` = 'galaxy' AND `owner_user_id` REGEXP '^[0-9]+$';
UPDATE `zt_galaxy_provider_ledger` SET `owner_user_id` = CONCAT('pu_legacy_', `owner_user_id`) WHERE `biz_line` = 'galaxy' AND `owner_user_id` REGEXP '^[0-9]+$';
UPDATE `zt_galaxy_payout`         SET `owner_user_id` = CONCAT('pu_legacy_', `owner_user_id`) WHERE `biz_line` = 'galaxy' AND `owner_user_id` REGEXP '^[0-9]+$';
UPDATE `zt_galaxy_provider`       SET `owner_user_id` = CONCAT('pu_legacy_', `owner_user_id`) WHERE `biz_line` = 'galaxy' AND `owner_user_id` REGEXP '^[0-9]+$';
UPDATE `zt_galaxy_dispute`        SET `provider_user_id` = CONCAT('pu_legacy_', `provider_user_id`) WHERE `biz_line` = 'galaxy' AND `provider_user_id` REGEXP '^[0-9]+$';
UPDATE `zt_galaxy_reputation`     SET `subject` = CONCAT('account:pu_legacy_', SUBSTRING(`subject`, 9)) WHERE `biz_line` = 'galaxy' AND `subject` REGEXP '^account:[0-9]+$';

UPDATE `zt_galaxy_consumer_key`   SET `owner_user_id` = CONCAT('cu_legacy_', `owner_user_id`) WHERE `biz_line` = 'galaxy' AND `owner_user_id` REGEXP '^[0-9]+$';
UPDATE `zt_galaxy_order`          SET `user_id` = CONCAT('cu_legacy_', `user_id`) WHERE `biz_line` = 'galaxy' AND `user_id` REGEXP '^[0-9]+$';
UPDATE `zt_galaxy_dispute`        SET `owner_user_id` = CONCAT('cu_legacy_', `owner_user_id`) WHERE `biz_line` = 'galaxy' AND `owner_user_id` REGEXP '^[0-9]+$';

UPDATE `zt_galaxy_consent_record`
   SET `user_id` = CONCAT(IF(`subject_type` = 'provider', 'pu_legacy_', 'cu_legacy_'), `user_id`)
 WHERE `biz_line` = 'galaxy' AND `subject_type` IN ('provider', 'consumer') AND `user_id` REGEXP '^[0-9]+$';


-- -------------------------------------------------------------------------
-- 核对
--
--   SELECT user_id, username, status FROM zt_galaxy_provider_user;
--   SELECT user_id, username, status FROM zt_galaxy_consumer_user;
--
--   -- 旧表还在的话，两张新表的行数加起来应该和它一样多：
--   SELECT (SELECT COUNT(*) FROM zt_galaxy_provider_user)
--        + (SELECT COUNT(*) FROM zt_galaxy_consumer_user) AS moved,
--          (SELECT COUNT(*) FROM zt_galaxy_user)          AS legacy;
--
--   -- 每一端的 id 都该带自己的前缀，下面两条都应该是 0：
--   SELECT COUNT(*) FROM zt_galaxy_provider_user WHERE user_id NOT LIKE 'pu\_%';
--   SELECT COUNT(*) FROM zt_galaxy_consumer_user WHERE user_id NOT LIKE 'cu\_%';
--
--   -- 池内表里不该再有纯数字的 owner，下面每一条都应该是 0：
--   SELECT COUNT(*) FROM zt_galaxy_node         WHERE owner_user_id REGEXP '^[0-9]+$';
--   SELECT COUNT(*) FROM zt_galaxy_consumer_key WHERE owner_user_id REGEXP '^[0-9]+$';
--   SELECT COUNT(*) FROM zt_galaxy_order        WHERE user_id REGEXP '^[0-9]+$';
-- -------------------------------------------------------------------------
