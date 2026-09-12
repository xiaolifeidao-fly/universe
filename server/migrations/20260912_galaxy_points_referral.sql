-- 使用者积分、分享返现、密钥明文取回。
--
-- 需求（2026-09-12）：使用端去掉自助充值，改成运营在管理端给使用者充积分（1 积分 = ¥1），
-- 使用者在 Orbit 用积分买套餐；通过分享链接注册的人每买一单，按套餐所绑模型的比例给邀请人返积分。
-- 密钥页的「使用」按钮要把密钥写进本机 Claude Code / Codex 配置，运营要随时看得到密钥去转交 ——
-- 两件事都要取得回明文，所以密钥表加一列密文（加密密钥在 galaxy.key_cipher_secret，不进库）。
--
-- 改了哪些：
--   zt_galaxy_consumer_key  + secret_cipher（明文密文）、model_id（来源套餐的模型，认 Claude / Codex 用）
--   zt_galaxy_package       + model_id（套餐绑定的模型，返现按它的比例）
--   zt_galaxy_order         + model_id（下单时的快照）、pay_method（points / channel）
--   zt_galaxy_model         + referral_bps（这个模型的返现比例，NULL 走全局默认）
--   新表 zt_galaxy_points_account / zt_galaxy_points_ledger / zt_galaxy_referral / zt_galaxy_setting
--
-- **必须先于新版 galaxy-api 部署执行**：新版的使用端注册会在同一个事务里写 zt_galaxy_referral，
-- 表不在的话注册整个失败；密钥签发、套餐和订单的读写也都带着新列。manager-api 同理。
--
-- 不回填：老密钥库里只有哈希，本来就解不出明文，换发一次即可；老账号的邀请码在本人第一次
-- 打开分享页时补上（邀请人留空 —— 事后补填等于让人随便认一个上家）；老订单 pay_method 为空，按 channel 看。
--
-- 幂等：列在不在先判断，表用 IF NOT EXISTS，重复执行安全。
-- 新环境直接跑 server/galaxy.sql 就够了，这份只给已经建过库的环境。

-- ---------- zt_galaxy_consumer_key ----------

SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_consumer_key'
     AND column_name = 'secret_cipher'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE `zt_galaxy_consumer_key`
     ADD COLUMN `secret_cipher` varchar(256) NULL DEFAULT NULL COMMENT ''sk- 明文的 AES-GCM 密文，空表示取不回'' AFTER `key_hash`',
  'SELECT ''zt_galaxy_consumer_key.secret_cipher 已存在，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_consumer_key'
     AND column_name = 'model_id'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE `zt_galaxy_consumer_key`
     ADD COLUMN `model_id` varchar(96) NULL DEFAULT NULL COMMENT ''来源套餐绑定的模型，只用于认类别与展示'' AFTER `order_id`',
  'SELECT ''zt_galaxy_consumer_key.model_id 已存在，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------- zt_galaxy_package ----------

SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_package'
     AND column_name = 'model_id'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE `zt_galaxy_package`
     ADD COLUMN `model_id` varchar(96) NULL DEFAULT NULL COMMENT ''绑定的模型，空为通用套餐；分享返现按它的比例算'' AFTER `rpm`',
  'SELECT ''zt_galaxy_package.model_id 已存在，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------- zt_galaxy_order ----------

SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_order'
     AND column_name = 'model_id'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE `zt_galaxy_order`
     ADD COLUMN `model_id` varchar(96) NULL DEFAULT NULL COMMENT ''下单时套餐绑定的模型快照'' AFTER `key_id`',
  'SELECT ''zt_galaxy_order.model_id 已存在，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_order'
     AND column_name = 'pay_method'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE `zt_galaxy_order`
     ADD COLUMN `pay_method` varchar(16) NULL DEFAULT NULL COMMENT ''points=积分；channel=支付渠道（空按 channel 看）'' AFTER `status`',
  'SELECT ''zt_galaxy_order.pay_method 已存在，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------- zt_galaxy_model ----------

SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_model'
     AND column_name = 'referral_bps'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE `zt_galaxy_model`
     ADD COLUMN `referral_bps` bigint NULL DEFAULT NULL COMMENT ''分享返现比例（万分之一），NULL 走全局默认，0 是不返'' AFTER `summary`',
  'SELECT ''zt_galaxy_model.referral_bps 已存在，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------- 新表 ----------

CREATE TABLE IF NOT EXISTS `zt_galaxy_points_account` (
  `id`            bigint AUTO_INCREMENT,
  `biz_line`      varchar(32),
  `owner_user_id` varchar(64),                                      -- 使用端账号 cu_…
  `balance`       bigint,                                           -- 微积分
  `updated_time`  datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_points_account` (`biz_line`,`owner_user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_galaxy_points_ledger` (
  `id`              bigint AUTO_INCREMENT,
  `biz_line`        varchar(32),
  `txn_id`          varchar(96),                                    -- 幂等键：recharge:<请求号> / order:<订单号>:pay|referral
  `owner_user_id`   varchar(64),
  `type`            varchar(16),                                    -- recharge/purchase/referral
  `amount`          bigint,                                         -- 微积分，入账为正、出账为负
  `balance_after`   bigint,
  `base_amount`     bigint,                                         -- 充值=实付金额（微元）；返现=那笔购买实付的积分
  `rate_bps`        bigint,                                         -- 返现比例快照（万分之一）
  `order_id`        varchar(64),
  `related_user_id` varchar(64),                                    -- 返现：下单的被邀请人
  `model_id`        varchar(96),
  `remark`          varchar(256),                                   -- 运营备注，使用端看不到
  `operator`        varchar(64),                                    -- 运营充值：经手的管理端账号
  `created_at`      datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_points_ledger` (`biz_line`,`txn_id`),
  INDEX `idx_gx_points_ledger_owner` (`biz_line`,`owner_user_id`,`created_at`),
  INDEX `idx_gx_points_ledger_type` (`biz_line`,`type`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_galaxy_referral` (
  `id`           bigint AUTO_INCREMENT,
  `biz_line`     varchar(32),
  `user_id`      varchar(64),                                       -- 使用端账号 cu_…
  `invite_code`  varchar(16),                                       -- 这个人的邀请码，大写
  `invited_by`   varchar(64),                                       -- 邀请人 cu_…，空表示自己注册的；注册后不可改
  `created_time` datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_referral_user` (`biz_line`,`user_id`),
  UNIQUE INDEX `uk_gx_referral_code` (`biz_line`,`invite_code`),
  INDEX `idx_gx_referral_inviter` (`biz_line`,`invited_by`,`created_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_galaxy_setting` (
  `id`           bigint AUTO_INCREMENT,
  `biz_line`     varchar(32),
  `setting_key`  varchar(64),
  `value`        varchar(1024),
  `updated_by`   varchar(64),                                       -- 管理端账号
  `updated_time` datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_setting` (`biz_line`,`setting_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
