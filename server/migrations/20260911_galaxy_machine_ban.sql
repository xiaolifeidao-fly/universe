-- 平台封禁跟着设备走，不再只记在节点记录上。
--
-- 改之前：封禁是 zt_galaxy_node.banned，只管那一个 nodeId。每配一次对就是一个新 nodeId，
-- 配对闸本来也不看封禁的节点 —— 被封的机器解绑重配、或者换个账号去配，回来的就是一条干净的记录。
--
-- 改之后：报过设备指纹的节点，封的是它的指纹（本表），和提供者是散户还是工作室无关。
-- 请求路径看的仍是 zt_galaxy_node.banned：封禁 / 解封时带这个指纹的节点记录一起改，
-- 新配出来的记录在 hello 报上指纹时补标。没报过指纹的老节点只能封节点那一行，和以前一样。
-- 指纹是节点自己报的，改过的客户端可以伪造；它挡的是正常客户端重新配对、换账号。
--
-- 解封不删行，banned 改回 false：谁、为什么封过要查得到。
--
-- 不回填。已有的封禁都还按节点记：被封的节点过不了鉴权、到不了 hello，一般根本没报过指纹。
-- 真有报过指纹的，在管理端对它解封再封禁一次，就换成按设备封了。在迁移里直接改的话，
-- 同一台设备上的其他节点会被标上封禁，却不经过摘控制面、关贡献那一步。
--
-- 和 20260911_galaxy_provider_reputation.sql 谁先跑都行：machine_fingerprint 列是那边加的，
-- 这里的索引要用到它，所以同样带着判断把列补上，定义和那边一字不差。
--
-- 幂等：列和索引在不在先判断，表用 IF NOT EXISTS。
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

-- 封禁时按设备改节点行。没有这个索引，那条 UPDATE 要扫全表、把每台机器的行都锁上，心跳写节点行时全得等它。
SET @exists := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_node'
     AND index_name = 'idx_gx_node_fingerprint'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE `zt_galaxy_node` ADD INDEX `idx_gx_node_fingerprint` (`biz_line`,`machine_fingerprint`)',
  'SELECT ''zt_galaxy_node.idx_gx_node_fingerprint 已存在，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS `zt_galaxy_machine_ban` (
  `id`                  bigint AUTO_INCREMENT,
  `biz_line`            varchar(32),
  `machine_fingerprint` varchar(64),                            -- 设备指纹 sha256，同 zt_galaxy_node.machine_fingerprint
  `banned`              boolean,                                -- 是否封禁中；解封改回 false，不删行
  `reason`              varchar(255),                           -- 最近一次封禁 / 解封填的原因
  `updated_by`          varchar(64),                            -- 最近一次操作的管理端账号
  `created_time`        datetime(3) NULL,
  `updated_time`        datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_machine_ban_fingerprint` (`biz_line`,`machine_fingerprint`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
