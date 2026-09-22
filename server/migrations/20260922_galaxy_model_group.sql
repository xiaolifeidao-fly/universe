-- 模型分组：把「推理强度」从对外的计价维度撤下来，换成一个模型底下的若干个分组。
--
-- 2026-09-21 上线的按强度定价（20260920_galaxy_price_effort.sql）把 effort 做成了
-- 计价键的一维，界面上也跟着把档位摆了出来。它有两个走不下去的地方：
--
--   1. 档位名是**上游的内部刻度**（output_config.effort / reasoning.effort）。摆给使用者看，
--      等于把平台在卖什么这件事，交给上游的字段名去解释；上游改一次词表，门户就得跟着改。
--   2. 客户端说了算。深档与快速都直接换算成钱，而拨旋钮的是客户端的默认值，
--      不是买单的人做的选择 —— 平台按一个价收，上游按另一个价扣，差额全由平台垫。
--
-- 换成分组之后：**价目挂在分组上，密钥选中分组才签得出来，共享者把分组加进车道才接得到单**。
-- 强度与快速变成分组的属性（分组卖哪几档、卖不卖快速），请求带上来的值一律先过这道闸：
-- 不在档位表里的夹到表里最浅的一档，分组没开快速的把请求体里的快速标记改写掉。
--
-- **要在发新版 galaxy-api / galaxy-consumer-api / galaxy-hub-api / manager-api 之前跑。**
-- 新版的取价、保存、删除都带 group_id，缺列会让 zt_galaxy_price 上的每一次读写都报 1054，
-- 也就是全站不计费、不结算；zt_galaxy_unit 缺列则会让派单那一刻的 INSERT 整条失败，
-- 请求直接打不进来。
--
-- 幂等：每一步各自判一次存在性，重复执行不会报 1050 / 1060 / 1061。

-- 1) 分组表。
--
--    group_id 是业务键（mg_…），不是自增 id —— 它会被写进密钥、贡献、单元行和价目行，
--    跨表引用一律用字符串业务键（表设计铁律）。
--
--    efforts_json 空数组 = **不限**：请求带什么档就按什么档打上游。它和「一档都不卖」
--    不是一回事，后者在业务上没有意义（那就是不卖这个模型）。
--
--    is_default 是模型的默认分组：老密钥（groups_json 为空）与没选分组的路径落在它上面。
--    同一个模型最多一个默认分组，靠 uk_gx_model_group_default 保证 —— 它只对
--    is_default = 1 的行生效，所以那一列用 NULL 表示「不是默认」，而不是 0。
CREATE TABLE IF NOT EXISTS `zt_galaxy_model_group` (
  `id`           bigint AUTO_INCREMENT,
  `biz_line`     varchar(32),
  `group_id`     varchar(64),                                  -- 业务键 mg_…，对外只露它
  `model_id`     varchar(96),                                  -- 所属模型，与 zt_galaxy_model.model_id 对齐
  `name`         varchar(64),                                  -- 分组名，界面上使用者看到的就是它
  `summary`      varchar(256),                                 -- 一句话说明，卡片上那行
  `efforts_json` varchar(512),                                 -- 绑定的推理强度数组，空=不限
  `allow_fast`   boolean DEFAULT false,                        -- 卖不卖「快速」
  `listed`       boolean DEFAULT true,                         -- 下架的分组不进候选，老密钥照旧能用
  `is_default`   tinyint(1) DEFAULT NULL,                      -- 1=该模型的默认分组；NULL=不是（唯一索引不拦 NULL）
  `sort_order`   bigint DEFAULT 0,
  `created_time` datetime(3) NULL,
  `updated_time` datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_model_group` (`biz_line`,`group_id`),
  UNIQUE INDEX `uk_gx_model_group_name` (`biz_line`,`model_id`,`name`),
  UNIQUE INDEX `uk_gx_model_group_default` (`biz_line`,`model_id`,`is_default`),
  INDEX `idx_gx_model_group_model` (`biz_line`,`model_id`,`listed`,`sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2) 价目表加分组维度。
--
--    NOT NULL DEFAULT '' 的理由和 model_id 那一列一模一样：MySQL 的唯一索引不拦 NULL，
--    这一列要是可空，两行「同 kind 同模型同单位同生效时刻、group_id 都是 NULL」
--    能一起插进去，取价时先拿到哪行全看运气。
--
--    空串在这里的含义是「**该模型的通价**」（model_id 非空时）或「该 kind 的兜底价」
--    （model_id 也空时），不是「叫空串的分组」。取价三级回落：
--      kind 兜底 → 模型通价 → 分组价，越具体越晚盖，每一级按单位分别盖。
SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_price'
     AND column_name = 'group_id'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE `zt_galaxy_price`
     ADD COLUMN `group_id` varchar(64) NOT NULL DEFAULT ''''
     COMMENT ''模型分组，空=该模型的通价'' AFTER `model_id`',
  'SELECT ''zt_galaxy_price.group_id 已存在，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 3) 目录里每个模型建一个默认分组「标准」。
--
--    它不带任何档位（不限）、允许快速 —— 也就是和加分组之前的行为**完全一样**。
--    存量密钥没选分组，走的就是它。运营要卖出差别来，再新建「深度」「快速」这些分组。
--
--    名字里不出现上游的档位名：分组名是对外的，而档位名是上游的内部刻度（本次改造的起因）。
INSERT INTO `zt_galaxy_model_group`
  (`biz_line`,`group_id`,`model_id`,`name`,`summary`,`efforts_json`,`allow_fast`,`listed`,`is_default`,`sort_order`,`created_time`,`updated_time`)
SELECT m.`biz_line`,
       CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT(m.`biz_line`,'|',m.`model_id`,'|default')), 1, 24))),
       m.`model_id`, '标准', '', '[]', 1, 1, 1, 0, NOW(3), NOW(3)
  FROM `zt_galaxy_model` m
 WHERE NOT EXISTS (
         SELECT 1 FROM `zt_galaxy_model_group` g
          WHERE g.`biz_line` = m.`biz_line` AND g.`model_id` = m.`model_id`);

-- 4) 已经按强度定过价的那些行，一档折成一个分组。
--
--    **折出来的分组是下架状态（listed = 0）**，而且名字是临时的。这是有意的：
--    档位名不能直接摆给使用者看，运营必须先给它起一个说得清楚的名字（「深度思考」之类）
--    再上架。在那之前这些价躺着不生效 —— 生效的是模型通价，也就是这一档原先的回落目标。
--
--    分组 id 由 (biz_line, model_id, effort) 推出来，重复执行算出同一个 id，不会翻倍。
INSERT INTO `zt_galaxy_model_group`
  (`biz_line`,`group_id`,`model_id`,`name`,`summary`,`efforts_json`,`allow_fast`,`listed`,`is_default`,`sort_order`,`created_time`,`updated_time`)
SELECT s.`biz_line`,
       CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT(s.`biz_line`,'|',s.`model_id`,'|',s.`effort`)), 1, 24))),
       s.`model_id`,
       CONCAT('待命名分组 ', s.`effort`),
       '由按强度定价迁移而来：先改名、确认价钱，再上架',
       CONCAT('["', s.`effort`, '"]'),
       1, 0, NULL, 0, NOW(3), NOW(3)
  FROM (SELECT DISTINCT `biz_line`, `model_id`, `effort`
          FROM `zt_galaxy_price`
         WHERE `effort` <> '' AND `model_id` <> '') s
 WHERE NOT EXISTS (
         SELECT 1 FROM `zt_galaxy_model_group` g
          WHERE g.`biz_line` = s.`biz_line`
            AND g.`group_id` = CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT(s.`biz_line`,'|',s.`model_id`,'|',s.`effort`)), 1, 24))));

-- 5) 把那些价搬进各自的分组，强度列清空。
UPDATE `zt_galaxy_price`
   SET `group_id` = CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT(`biz_line`,'|',`model_id`,'|',`effort`)), 1, 24))),
       `effort` = ''
 WHERE `effort` <> '' AND `model_id` <> '' AND `group_id` = '';

-- 6) 跨模型的强度行（model_id 为空、effort 非空，「所有模型的某一档统一加价」）没有对应物：
--    分组属于某一个模型。它们在新的唯一键下会和同组的其它行撞成重复，所以这里删掉。
--
--    先报数再删：种子脚本从来不产生这种行（galaxy_model_effort_seed.sql 全部带 model_id），
--    所以正常情况下这一句影响 0 行。真有行被删掉时，运营要按模型重新建分组把它们补回来。
SELECT COUNT(*) AS `将删除的跨模型强度行` FROM `zt_galaxy_price` WHERE `effort` <> '' AND `model_id` = '';
DELETE FROM `zt_galaxy_price` WHERE `effort` <> '' AND `model_id` = '';

-- 7) 唯一键从 (biz_line, kind, model_id, effort, unit, effective_from)
--    换成 (biz_line, kind, model_id, group_id, unit, effective_from)。
--
--    group_id 排在 model_id 之后、unit 之前：取价的 ORDER BY 必须和索引同列序才走得上
--    索引顺序（见 ListEffectivePrices），而回落是「模型比分组更粗」的顺序 —— 一致。
--
--    跑到这里时 effort 已经全是 ''（第 5、6 步），新旧两个键在这批数据上等价，撞不出重复。
SET @indexed := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_price'
     AND index_name = 'uk_gx_price' AND column_name = 'group_id'
);
SET @sql := IF(@indexed = 0,
  'ALTER TABLE `zt_galaxy_price`
     DROP INDEX `uk_gx_price`,
     ADD UNIQUE INDEX `uk_gx_price` (`biz_line`,`kind`,`model_id`,`group_id`,`unit`,`effective_from`)',
  'SELECT ''uk_gx_price 已含 group_id，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 8) 价目表丢掉强度列。
--
--    留着它才是危险的：两个维度都在表上，而取价只看其中一个，库里就能躺下一行
--    「填了强度、永远匹配不上」的价，且没有任何地方会报错 —— 这正是这次要消灭的那类故障。
--    单元行上的 effort 留着（那是事实记录，见第 11 步），价目行上的不留。
SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_price'
     AND column_name = 'effort'
);
SET @sql := IF(@exists > 0,
  'ALTER TABLE `zt_galaxy_price` DROP COLUMN `effort`',
  'SELECT ''zt_galaxy_price.effort 已移除，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 9) 密钥选中的分组。
--
--    空 = 不限（存量密钥）：每个模型都落在它的默认分组上，行为和加分组之前一样。
--    新签的密钥一律要选，见 CreateConsumerKey。
SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_consumer_key'
     AND column_name = 'groups_json'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE `zt_galaxy_consumer_key`
     ADD COLUMN `groups_json` varchar(1024) NULL
     COMMENT ''选中的模型分组数组，空=不限（走各模型的默认分组）'' AFTER `model_tier_json`',
  'SELECT ''zt_galaxy_consumer_key.groups_json 已存在，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 10) 贡献加入的分组。
--
--     空 = 不限（存量贡献）：跑这次迁移不会让任何一台在线的机器掉出候选。
--     主人在共享设置里确认之后才会写具体的分组。
SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_contribution'
     AND column_name = 'groups_json'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE `zt_galaxy_contribution`
     ADD COLUMN `groups_json` varchar(4096) NULL
     COMMENT ''加入的模型分组数组，空=不限'' AFTER `models_deny_json`',
  'SELECT ''zt_galaxy_contribution.groups_json 已存在，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 11) 单元行记下这一次落在哪个分组、是不是按快速跑的。
--
--     和 effort 那一列同样不是冗余：结算在请求跑完之后，账单与争议追回更是事后几天
--     才重新取价，那时 Redis 里的信封早过期了，唯一能回答「当初按哪个分组收的」就是这一列。
SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_unit'
     AND column_name = 'group_id'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE `zt_galaxy_unit`
     ADD COLUMN `group_id` varchar(64) NULL
     COMMENT ''模型分组，计价键的一部分'' AFTER `effort`',
  'SELECT ''zt_galaxy_unit.group_id 已存在，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_unit'
     AND column_name = 'fast'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE `zt_galaxy_unit`
     ADD COLUMN `fast` boolean NOT NULL DEFAULT false
     COMMENT ''这一次是否按快速跑（分组允许才可能为真）'' AFTER `group_id`',
  'SELECT ''zt_galaxy_unit.fast 已存在，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 12) 自检。
--     a) 每个已上架的模型都要有分组，否则使用端签不出能用它的密钥。
SELECT m.`model_id` AS `没有分组的已上架模型`
  FROM `zt_galaxy_model` m
 WHERE m.`listed` = 1
   AND NOT EXISTS (SELECT 1 FROM `zt_galaxy_model_group` g
                    WHERE g.`biz_line` = m.`biz_line` AND g.`model_id` = m.`model_id`);
--     b) 价目行引用的分组必须存在。指向不存在的分组 = 这行价永远匹配不上。
SELECT p.`model_id`, p.`group_id` AS `指向不存在分组的价目行`
  FROM `zt_galaxy_price` p
 WHERE p.`group_id` <> ''
   AND NOT EXISTS (SELECT 1 FROM `zt_galaxy_model_group` g
                    WHERE g.`biz_line` = p.`biz_line` AND g.`group_id` = p.`group_id`);
