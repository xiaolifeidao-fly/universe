-- 共享端的邀请返现：分享者拉来的人贡献算力赚到积分时，平台额外奖励分享者一笔。
--
-- 和使用端那套分享（zt_galaxy_referral）是两回事，刻意不共用一张表：
-- 两端是两批人（pu_ / cu_），邀请码的命名空间混在一起时，一个共享端的码被填进
-- Orbit 的注册页会「查得到但返错人」。分开之后同一个人在两端各有一个码，
-- 各自返各自的，没有任何交叉。
--
-- 只返一层：奖励只按被邀请人**自己贡献算力**结算出来的积分算，奖励本身不再产生奖励，
-- 所以不存在链式分佣。谁邀请的谁在注册那一刻定死（invited_by 不可改）——
-- 改得动的话，返现归谁就成了「谁先去找运营」的问题。
CREATE TABLE IF NOT EXISTS `zt_galaxy_provider_referral` (
  `id`           bigint AUTO_INCREMENT,
  `biz_line`     varchar(32),
  `user_id`      varchar(64),                                   -- 共享端账号 pu_…
  `invite_code`  varchar(16),                                   -- 这个人的邀请码，大写
  `invited_by`   varchar(64),                                   -- 邀请人 pu_…，空表示自己注册的；注册后不可改
  `created_time` datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_provider_referral_user` (`biz_line`,`user_id`),
  UNIQUE INDEX `uk_gx_provider_referral_code` (`biz_line`,`invite_code`),
  INDEX `idx_gx_provider_referral_inviter` (`biz_line`,`invited_by`,`created_time`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 邀请奖励记在供给侧账本上（type=referral，负数的 ref_clawback 是申诉追回时的反向流水），
-- related_user_id 记的是「这笔奖励是谁跑出来的」，也就是被邀请人。
--
-- 不在邀请关系表上放一个累加的计数器：计数器和账本迟早对不上，而账本是唯一权威。
-- 按人汇总一次 group by 就够，邀请页也不是高频页面。
--
-- 重复执行会报 1060（MySQL 8.0 没有 ADD COLUMN IF NOT EXISTS），忽略即可。
ALTER TABLE `zt_galaxy_provider_ledger`
  ADD COLUMN `related_user_id` varchar(64) DEFAULT '' COMMENT '邀请奖励：这笔奖励来自哪个被邀请人（pu_…）；其它类型为空' AFTER `unit_id`;
