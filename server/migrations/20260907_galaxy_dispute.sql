-- 争议工单（需求 S-09）。
--
-- 消费者与提供者互不可见，出了问题两边没法自己谈 —— 平台是唯一同时握着单元、
-- 计量与两本账的一方，所以争议只有「消费者建单 → 平台裁决」这一条路。
--
-- 工单钉在 (unit_id, attempt) 而不只是 unit_id：结算幂等键就是这两个，重跑过的
-- 单元每次尝试各自结算过一遍，只钉 unit_id 会让一次「支持申诉」把两次的钱都退掉。
--
-- 裁决成立不抹原始流水，而是在 zt_galaxy_{consumer,provider,platform}_ledger 上
-- 各记一笔反向的（refund / clawback / baddebt，幂等键加 :dispute 后缀）。
--
-- 与 server/galaxy.sql 中的同名表完全一致，都是 GORM 建表流程的原样抄录 ——
-- 刻意不写 COLUMN COMMENT、不加多余 DEFAULT、不写 NOT NULL，否则 AutoMigrate
-- 会把「库里有、模型里没有」判定为差异并改回去。
-- 目标库还没跑过 galaxyinit 的话直接跑 server/galaxy.sql，不用执行本文件。

CREATE TABLE IF NOT EXISTS `zt_galaxy_dispute` (
  `id`               bigint AUTO_INCREMENT,
  `biz_line`         varchar(32),
  `dispute_id`       varchar(40),                                                -- dp_ + ULID
  `unit_id`          varchar(40),
  `attempt`          bigint,
  `kind`             varchar(64),
  `key_id`           varchar(64),                                                -- 花钱的那把算力密钥
  `owner_user_id`    varchar(64),                                                -- 申诉人，即消费者
  `cid`              varchar(96),
  `provider_user_id` varchar(64),                                                -- 建单那一刻的贡献主人；追回打在他头上
  `reason`           varchar(32),                                                -- not_delivered/wrong_output/overcharged/forged/other
  `detail`           varchar(512),                                               -- 申诉人自述。界面明确劝阻粘贴请求内容 —— 那些平台本就不留存
  `status`           varchar(16),                                                -- open/reviewing/upheld/rejected/withdrawn
  `resolution`       varchar(512),                                               -- 运营的处理说明，会原样给到申诉人
  `refund_json`      varchar(512),                                               -- 实际退回的量，按计量单位。空表示成立但没有可退的钱
  `clawback_amount`  bigint DEFAULT 0,                                           -- 从提供者积分里扣回的金额
  `handled_by`       varchar(64),
  `handled_at`       timestamp null,
  `created_time`     datetime(3) NULL,
  `updated_time`     datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_dispute_id` (`biz_line`,`dispute_id`),
  UNIQUE INDEX `uk_gx_dispute_unit` (`biz_line`,`unit_id`,`attempt`),
  INDEX `idx_gx_dispute_owner` (`biz_line`,`owner_user_id`,`created_time` desc),
  INDEX `idx_gx_dispute_status` (`biz_line`,`status`,`created_time` desc),
  INDEX `idx_gx_dispute_contribution` (`biz_line`,`cid`,`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
