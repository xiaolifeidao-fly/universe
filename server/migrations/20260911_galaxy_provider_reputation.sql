-- 提供者分散户 / 工作室，信誉按身份跟着账号或设备走。
--
-- 改之前：信誉是贡献表上的一列。贡献 id 带着 nodeId，而每配一次对就是一个新 nodeId ——
-- 解绑再配一次，这台机器所有贡献的信誉都回到 1。
--
-- 改之后：
--   散户（注册默认）  信誉跟着账号。名下几台机器共用一份，换机器、重新配对都不清零。
--   工作室（管理端设） 信誉跟着设备。节点在 hello 里报设备指纹（sha256，原始硬件 id 不出本机），
--                    每台机器各算各的，换账号去配也还是那份。
--
-- 扣分同时记在账号和设备两份上（zt_galaxy_reputation），读哪一份看账号当下的身份
-- （zt_galaxy_provider，没有行就是散户），所以管理端改身份不会让分数清零。
-- 分数只在出事时往下扣，平时按天回升（galaxy.reputation_recovery_per_day，默认 0.05）。
--
-- zt_galaxy_contribution.reputation 从此不再读写。这里不删列，也不把旧分数搬过来：
-- 上线时库里只有一条低于 1 的（0.95，那台机器已经撤销），丢掉可以接受。
--
-- 幂等：列在不在先判断，表用 IF NOT EXISTS。
SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_node'
     AND column_name = 'machine_fingerprint'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE `zt_galaxy_node`
     ADD COLUMN `machine_fingerprint` varchar(64) NULL DEFAULT NULL COMMENT ''设备指纹 sha256，工作室的信誉跟着它走；老版本节点不报，为空'' AFTER `resources_json`',
  'SELECT ''zt_galaxy_node.machine_fingerprint 已存在，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS `zt_galaxy_provider` (
  `id`            bigint AUTO_INCREMENT,
  `biz_line`      varchar(32),
  `owner_user_id` varchar(64),                                  -- 提供者用户标识
  `provider_type` varchar(16),                                  -- individual=散户，信誉跟着账号；studio=工作室，信誉跟着设备
  `updated_by`    varchar(64),                                  -- 最近一次改身份的管理端账号
  `created_time`  datetime(3) NULL,
  `updated_time`  datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_provider_owner` (`biz_line`,`owner_user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_galaxy_reputation` (
  `id`            bigint AUTO_INCREMENT,
  `biz_line`      varchar(32),
  `subject`       varchar(96),                                  -- account:<账号> / device:<设备指纹> / node:<nodeId>
  `reputation`    double,                                       -- 信誉分 0..1，截至 reputation_at；此后按天回升
  `reputation_at` timestamp NULL DEFAULT NULL,                  -- reputation 的结算时刻
  `created_time`  datetime(3) NULL,
  `updated_time`  datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_reputation_subject` (`biz_line`,`subject`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
