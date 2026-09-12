-- ai-bridge 的版本分发与远程升级。
--
-- 两件事：平台要有地方放安装包（运营在管理端上传，字节进 OSS，这里只存元数据），
-- 机器要能被控制台一键升上去（升级状态挂在节点那一行，心跳时下发指令）。
--
-- 升级状态为什么挂在 zt_galaxy_node 而不是单开一张指令表：心跳每 15 秒本来就要读
-- 这一行（生效配置从它算出来），挂在上面不多一次查询；而「同一台机器同时只有一次
-- 升级在跑」本来就是业务约束，多行历史除了对账没人看。真要追溯升到过哪一版，
-- 看的是节点报上来的 bridge_version 变化。
--
-- 注意：MySQL 8.0 不支持 ADD COLUMN IF NOT EXISTS（那是 MariaDB 的写法，
-- 在 MySQL 上报 1064），所以下面是直接 ADD —— 重复执行会报 1060，忽略即可。

ALTER TABLE `zt_galaxy_node`
  ADD COLUMN `bridge_platform`      varchar(32)  DEFAULT ''     COMMENT '节点自报的平台名，如 linux-x64；老版本节点不报，为空' AFTER `bridge_version`,
  ADD COLUMN `bridge_distribution`  varchar(16)  DEFAULT ''     COMMENT 'cli=独立部署的命令行，能自升级；nova=随 Nova 应用分发；空=老版本节点' AFTER `bridge_platform`,
  ADD COLUMN `upgrade_blocker`      varchar(255) DEFAULT ''     COMMENT '节点自报的「此刻为什么不能远程升级」，人话，直接展示；空表示可以' AFTER `bridge_distribution`,
  ADD COLUMN `upgrade_id`           varchar(40)  DEFAULT ''     COMMENT '最近一次升级指令的 id，节点按它回报，对不上的回报一律忽略' AFTER `upgrade_blocker`,
  ADD COLUMN `upgrade_version`      varchar(32)  DEFAULT ''     COMMENT '最近一次升级的目标版本' AFTER `upgrade_id`,
  ADD COLUMN `upgrade_from_version` varchar(32)  DEFAULT ''     COMMENT '发起升级那一刻机器上的版本，用来显示「已从 x 升到 y」' AFTER `upgrade_version`,
  ADD COLUMN `upgrade_status`       varchar(16)  DEFAULT ''     COMMENT 'pending/downloading/installing/restarting/succeeded/failed；空=从没升级过' AFTER `upgrade_from_version`,
  ADD COLUMN `upgrade_message`      varchar(255) DEFAULT ''     COMMENT '最近一次升级的说明或失败原因，人话，直接展示' AFTER `upgrade_status`,
  ADD COLUMN `upgrade_requested_at` timestamp NULL DEFAULT NULL COMMENT '控制台点「升级」的时刻' AFTER `upgrade_message`,
  ADD COLUMN `upgrade_updated_at`   timestamp NULL DEFAULT NULL COMMENT '升级状态最近一次变化的时刻，卡住多久算超时按它算' AFTER `upgrade_requested_at`;

-- 发布出去的 ai-bridge 安装包。一个版本一个平台一行。
--
-- 字节在 OSS（object_key 指过去），这里只有「哪个版本、哪个平台、多大、校验值、签名」。
-- 签名是 Ed25519，签的是「版本 + 平台 + sha256」这三样，私钥离线保管、公钥编进
-- ai-bridge 自己。节点只装验得过签名的包 —— Hub、数据库、OSS 任何一个被改了，
-- 推下去的东西也装不上，这正是远程升级敢做的前提（节点不信任 Hub 的老规矩，
-- 见 doc/galaxy 的原则 8）。
--
-- 下架不删行：历史订单式的道理 —— 机器上报的版本要能对得上它当初装的是哪一个包。
CREATE TABLE IF NOT EXISTS `zt_galaxy_bridge_release` (
  `id`           bigint AUTO_INCREMENT,
  `biz_line`     varchar(32),                                   -- 业务线，池内固定 galaxy
  `release_id`   varchar(40),                                   -- 业务键 br_…
  `version`      varchar(32),                                   -- 语义版本，如 0.2.0
  `platform`     varchar(32),                                   -- linux-x64 / darwin-arm64 / windows-x64 …
  `file_name`    varchar(128),                                  -- ai-bridge-<版本>-<平台>.tar.gz（windows 是 .zip）
  `object_key`   varchar(255),                                  -- OSS 对象键，含部署配置的 prefix
  `size`         bigint,                                        -- 字节数
  `sha256`       varchar(64),                                   -- 整个压缩包的 sha256，小写十六进制
  `signature`    varchar(128),                                  -- 发布签名（Ed25519，base64），节点装之前先验它
  `notes`        text,                                          -- 版本说明，控制台与门户原样展示
  `status`       varchar(16),                                   -- published/withdrawn；下架的不再作为升级目标，也不出现在下载清单里
  `published_by` varchar(64),                                   -- 上传的管理端账号
  `published_at` timestamp NULL DEFAULT NULL,                   -- 最近一次发布的时刻
  `created_time` datetime(3) NULL,
  `updated_time` datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_bridge_release_id` (`biz_line`,`release_id`),
  UNIQUE INDEX `uk_gx_bridge_release_target` (`biz_line`,`version`,`platform`),
  INDEX `idx_gx_bridge_release_platform` (`biz_line`,`platform`,`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
