-- 节点接入方式：poll（节点长轮询领活）与 export（Hub 主动回连节点公网地址）。
--
-- 为什么加在 node 而不是 contribution：接入方式是「这台机器怎么和 Hub 通信」，
-- 是传输层属性，与它共享了哪几条能力无关。一台机器上的所有贡献必然共用同一条通道。
ALTER TABLE `zt_galaxy_node`
  ADD COLUMN `access_mode`         varchar(16)  DEFAULT 'poll' COMMENT 'poll=节点长轮询领活；export=Hub 回连节点公网地址' AFTER `contract_version`,
  ADD COLUMN `endpoint_url`        varchar(255) DEFAULT ''     COMMENT 'export：Hub 回连的公网基地址' AFTER `access_mode`,
  ADD COLUMN `endpoint_secret`     varchar(128) DEFAULT ''     COMMENT 'export：回连密钥。节点生成、注册时上报，Hub 必须持有明文才能出示' AFTER `endpoint_url`,
  ADD COLUMN `endpoint_status`     varchar(16)  DEFAULT ''     COMMENT 'export：最近一次回连探测结果 ok/unreachable' AFTER `endpoint_secret`,
  ADD COLUMN `endpoint_error`      varchar(255) DEFAULT ''     COMMENT 'export：最近一次回连失败的原因，人话，直接展示' AFTER `endpoint_status`,
  ADD COLUMN `endpoint_checked_at` timestamp NULL DEFAULT NULL COMMENT 'export：最近一次回连探测时刻' AFTER `endpoint_error`;

-- 提供者接入密钥。单独部署的 rust bridge 用它自助注册节点，代替配对码。
--
-- 与配对码的分工：配对码是**一次性、10 分钟有效**，给可视化客户端用（人在两个
-- 界面之间搬一个六位码）；接入密钥是**长期**的，给无人值守的服务器用 —— 那种机器
-- 上没人能去点一下「生成配对码」，重启一次就得有人值班的接入方式不成立。
--
-- 明文只在签发那一刻返回一次，库里存 sha256，与算力密钥同一套做法。
CREATE TABLE IF NOT EXISTS `zt_galaxy_provider_key` (
  `id`            bigint AUTO_INCREMENT,
  `biz_line`      varchar(32),                                  -- 业务线，池内固定 galaxy
  `key_id`        varchar(64),                                  -- 匿名标识 gpk_…，日志与列表里用它
  `key_hash`      varchar(64),                                  -- gpk- 明文的 sha256
  `owner_user_id` varchar(64),                                  -- 归属的提供者：用这把密钥注册的机器算他的
  `alias`         varchar(64),                                  -- 主人给这把密钥起的名字
  `terms_version` varchar(32),                                  -- 签发时的条款版本，注册时再校验一次
  `status`        varchar(16),                                  -- active/revoked
  `last_used_at`  timestamp NULL DEFAULT NULL,                  -- 最近一次注册成功
  `last_node_id`  varchar(64),                                  -- 最近一次注册出来的节点
  `expires_at`    timestamp NULL DEFAULT NULL,                  -- 空表示不过期
  `created_time`  datetime(3) NULL,
  `updated_time`  datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_provider_key_id` (`biz_line`,`key_id`),
  UNIQUE INDEX `uk_gx_provider_key_hash` (`biz_line`,`key_hash`),
  INDEX `idx_gx_provider_key_owner` (`biz_line`,`owner_user_id`,`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
