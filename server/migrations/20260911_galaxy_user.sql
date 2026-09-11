-- Galaxy 账号体系从任务宇宙独立出来。
--
-- 改之前：Nova / Orbit 登录用的是任务宇宙的账号（zt_identity_user，POST /api/auth/login），
-- 池内表里的 owner_user_id 存的是那边的数字主键，令牌和 web-api 通用。
--
-- 改之后：Galaxy 有自己的账号表 zt_galaxy_user。共享端（Nova）和使用端（Orbit）是两批人，
-- 各注册各的，user_id 带端的前缀（pu_ / cu_），池内表里存的换成这个；令牌是 Galaxy 自己签的，
-- 两端之间、和任务宇宙之间都不通用。
--
-- 这份脚本做三件事：
--   1. 建 zt_galaxy_user
--   2. 名下有 Galaxy 数据的任务宇宙账号，在用到的那一端各建一个同名 Galaxy 账号，沿用原密码
--      （同一套 bcrypt），user_id 是 pu_legacy_<原 id> / cu_legacy_<原 id> —— 一眼看得出是迁过来的
--   3. 把池内表里纯数字的 owner 改成对应的 legacy id
--
-- **顺序：先跑这份，再发新版 galaxy-api、manager-api 和 Nova / Orbit。** 两个服务都要读这张表：
-- galaxy-api 没有它登录注册全挂，manager-api 的「节点与贡献」要按它查机器主人的名字，缺表整页报错。
-- 另外，新注册入口一开，有人可能抢先注册了老用户的用户名，第 2 步只好给老账号换成 <用户名>-legacy<原 id>。
-- 老用户的名下数据不会跟着同名的新账号走 —— 那等于谁先抢到用户名谁拿走别人的积分。
--
-- 最稳妥的做法是先停 galaxy-api 再跑：迁移和新版上线之间，老服务还会按数字 id 往池内表里写。
-- 那段时间写进来的行，重跑一次这份脚本会接着改掉；但积分账户、信誉这两张表按 owner 唯一，
-- 老服务要是给同一个人新建了一行数字 owner 的，重跑会在那一句报 1062，要人工把两行并起来。
--
-- 幂等：建表 IF NOT EXISTS；建账号前按 user_id 查重；改 owner 只改纯数字的值，改过的不再改。
-- 中途失败修好了直接重跑即可 —— 包括「第 2 步建账号报错、客户端却选了出错继续、第 3 步照样
-- 把 owner 改完了」这种半截状态：第 2 步收集老 owner 时，已经改成 legacy id 的也算，重跑会把缺的账号补上。
--
-- 依赖：20260907_galaxy_dispute、20260910_galaxy_payout、20260911_galaxy_node_access_mode、
--      20260911_galaxy_provider_reputation 已经跑过（要用到它们建的表）。
--
-- 不改任务宇宙的任何表，zt_identity_user 只读。
-- Redis 里节点快照上的 ownerUserId 不用管：节点下一次 hello 会按库里的新值重建。


-- -------------------------------------------------------------------------
-- 1. 账号表（与 server/galaxy.sql 一致）
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `zt_galaxy_user` (
  `id`                   bigint AUTO_INCREMENT,
  `biz_line`             varchar(32),
  `user_id`              varchar(40),
  `side`                 varchar(16),
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
  UNIQUE INDEX `uk_gx_user_name` (`biz_line`,`side`,`username`),
  INDEX `idx_gx_user_side` (`biz_line`,`side`,`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- -------------------------------------------------------------------------
-- 2. 老账号：先把「谁在哪一端有数据」收进临时表，再建账号
--
-- 必须在第 3 步改 owner 之前收：改完就认不出哪些是老的了。所以已经带 legacy 前缀的也收 ——
-- 上一次跑到一半（owner 改了、账号没建成）时，只有从它们身上才找得回是谁。
-- 一个人两端都有数据（既挂机又买额度）就建两个账号，这正是新规则下该有的样子。
--
-- 临时表显式写 utf8mb4：不写就继承库的默认字符集（线上库是 utf8mb3），它的 side 列要和
-- zt_galaxy_user.side 比较，两边排序规则不一致时 MySQL 会报 1267。
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

-- 建账号。用户名在那一端已经被占了（新入口先开、有人抢注）就加后缀，不和别人的账号合并。
-- 任务宇宙里停用的账号迁过来也是停用。子查询里的端写成字面量，不直接拿临时表的列去比（见上面 1267）。
INSERT INTO `zt_galaxy_user`
  (`biz_line`, `user_id`, `side`, `username`, `display_name`, `password_hash`, `status`,
   `must_change_password`, `token_version`, `created_time`, `updated_time`)
SELECT 'galaxy',
       CONCAT(IF(o.`side` = 'provider', 'pu_legacy_', 'cu_legacy_'), u.`id`),
       o.`side`,
       IF(EXISTS (SELECT 1 FROM `zt_galaxy_user` g
                   WHERE g.`biz_line` = 'galaxy' AND g.`side` = IF(o.`side` = 'provider', 'provider', 'consumer')
                     AND g.`username` = LOWER(TRIM(u.`username`))),
          CONCAT(LOWER(TRIM(u.`username`)), '-legacy', u.`id`),
          LOWER(TRIM(u.`username`))),
       u.`display_name`,
       u.`password_hash`,
       IF(u.`status` = 'active', 'active', 'disabled'),
       false, 1, NOW(3), NOW(3)
FROM `tmp_gx_legacy_owner` o
JOIN `zt_identity_user` u ON u.`id` = o.`identity_id`
WHERE NOT EXISTS (
  SELECT 1 FROM `zt_galaxy_user` g
   WHERE g.`biz_line` = 'galaxy'
     AND g.`user_id` = CONCAT(IF(o.`side` = 'provider', 'pu_legacy_', 'cu_legacy_'), u.`id`)
);

DROP TEMPORARY TABLE IF EXISTS `tmp_gx_legacy_owner`;


-- -------------------------------------------------------------------------
-- 3. 池内表的 owner 换成 Galaxy 账号的 id
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
--   SELECT user_id, side, username, status FROM zt_galaxy_user WHERE user_id LIKE '%legacy%';
--   -- 下面每一条都应该是 0：
--   SELECT COUNT(*) FROM zt_galaxy_node         WHERE owner_user_id REGEXP '^[0-9]+$';
--   SELECT COUNT(*) FROM zt_galaxy_consumer_key WHERE owner_user_id REGEXP '^[0-9]+$';
--   SELECT COUNT(*) FROM zt_galaxy_order        WHERE user_id REGEXP '^[0-9]+$';
-- -------------------------------------------------------------------------
