-- =========================================================================
-- 模型广场：9 个模型 × 各自的**分组** = 47 个在卖的档次
--
-- 这份文件是 galaxy_model_effort_seed.sql 的继任者（2026-09-22）：同一批价，
-- 换成挂在**模型分组**上。推理强度不再是计价维度，而是分组的一条属性 ——
-- 一个分组卖哪几档强度、卖不卖快速，写在分组行上；请求带来的强度不在表里就被夹到
-- 表里最浅的一档，分组没开快速就把请求体里的快速标记改写掉（contract.GroupPolicy）。
--
-- **分组名是对外的**（使用端建密钥、共享端选接单、官网模型页都显示它），所以这里
-- 用的是「轻量 / 标准 / 深度 / 极深 / 至深」这类说得清档次的词，而不是上游的档位名
-- （low…max 是上游的内部刻度，摆给使用者看等于让上游的字段名替平台解释自己在卖什么）。
-- 名字是起点，运营随时可以改 —— 改名不影响任何一行价，价认的是 group_id。
--
-- 全部 upsert，**重复执行安全**，按各自的唯一键落位：
--   uk_gx_model       = (biz_line, model_id)
--   uk_gx_model_group = (biz_line, group_id)
--   uk_gx_price       = (biz_line, kind, model_id, group_id, unit, effective_from)
--
-- group_id 由 (biz_line, model_id, 档位) 推出来，**和 20260922 那条迁移算的是同一个值** ——
-- 先跑过迁移的库再跑这份文件，落在同一批分组上，不会翻倍。
--
-- 量纲：整数微元，÷1_000_000 得「元」。price 是**每百万 token** 的价。
-- 计费口径 cost = amount × price ÷ 1_000_000（billing.go 的 priceScale）。
--
-- ⚠️ 前置条件（按「线上库常落后于 migrations」的实际情况，跑之前先盘一遍）：
--   1. 建表：server/galaxy.sql（新建库已含 zt_galaxy_model_group 与带 group_id 的 uk_gx_price）
--   2. 存量库要确认这几条迁移都跑过、而且跑完整了：
--        20260919_galaxy_price_model.sql      给价目表加 model_id
--        20260919_galaxy_provider_price.sql   给价目表加 provider_price
--        20260922_galaxy_model_group.sql      建分组表、价目表换 group_id（多步！）
--      盘点语句：
--        SELECT column_name FROM information_schema.columns
--         WHERE table_schema=DATABASE() AND table_name='zt_galaxy_price';
--   3. 兜底价：跑过 galaxy_seed.sql 或 galaxyinit。这份文件只铺 output 一个单位，
--      input / cache_read / cache_write 全靠 (model_id='', group_id='') 的兜底行 ——
--      那几行不在的话，那些单位会**静默按 0 计费**，不报错。
--      盘点语句：
--        SELECT unit FROM zt_galaxy_price
--         WHERE biz_line='galaxy' AND kind='llm.chat' AND model_id='' AND group_id='';
--
-- 三段，可以分开跑：
--   1. 分组（不涉及钱）
--   2. 价目（涉及钱）
--   3. 跑完自检
--
-- 模型目录本身不在这份文件里 —— 它没变，仍然由 galaxy_seed.sql / 管理端维护。
-- =========================================================================

-- effective_from 是 **TIMESTAMP** 列，写进去的字面量按会话时区折成 UTC 存，
-- 而它在唯一键里 —— 换一个时区的客户端重跑，同一串 '2026-01-01 00:00:00' 会落在
-- 另一个瞬间，于是不走 ON DUPLICATE KEY 而是**再插一整套行**。钉死它：
SET time_zone = '+08:00';

-- 半迁移态的硬断言：只建了分组表、价目表还没换唯一键时，下面这批行会在旧键上
-- 互相覆盖成每个模型一行，静默按最后一行的价收钱。宁可在这里炸。
--
-- 炸法是「查一张名字就是提示语的表」，**不能用 SIGNAL**：SIGNAL 不支持预处理协议，
-- `PREPARE ... FROM @guard` 会先报一句 1295 This command is not supported in the
-- prepared statement protocol yet —— 断言确实拦住了，但报出来的话和你要看的那句
-- 毫无关系，而客户端要是「出错继续」，后面几段照样往下跑。踩过一次。
SET @indexed := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_price'
     AND index_name = 'uk_gx_price' AND column_name = 'group_id'
);
SET @guard := IF(@indexed > 0,
  'SELECT ''uk_gx_price 含 group_id，继续'' AS precheck',
  'SELECT * FROM `【停】先跑完 migrations/20260922_galaxy_model_group.sql 再跑这份种子`');
PREPARE guard_stmt FROM @guard;
EXECUTE guard_stmt;
DEALLOCATE PREPARE guard_stmt;


-- -------------------------------------------------------------------------
-- 1. 分组
--
-- 每个模型一组「按深浅排开」的分组，每个分组只绑它自己那一档强度。
-- 另外每个模型一个**默认分组**（is_default = 1）：没选分组的老密钥落在它上面，
-- 这里指定的是各族的官方默认档（Claude high / Codex medium），也就是不分组时的行为。
--
-- allow_fast 是种子的起点：浅档开快速（快速通道的意义在这儿），深档不开 ——
-- 深档本来就慢，而快速在上游那边更贵。运营按实际成本自己调。
-- -------------------------------------------------------------------------

-- 1a) 先撤掉迁移建的那个占位分组。
--
-- 迁移（20260922）给**每个**模型建了一个叫「标准」、不限强度、允许快速的默认分组，
-- 作用是「跑完迁移之后行为和跑之前一模一样」。这份种子要卖的是另一套东西：同一个模型
-- 按深浅摆开的几档，其中也有一个叫「标准」（medium 那一档）。两者同名、同模型，
-- 撞在 uk_gx_model_group_name 上。
--
-- **不能指望 ON DUPLICATE KEY UPDATE 把它们合一块。** 这张表有三个唯一键
-- （group_id / (model,name) / (model,is_default)），而这批行会同时撞上后两个：
-- 「标准」撞名字、默认那一档撞 is_default。实测这么插下去，MySQL 直接甩
-- `1062 Duplicate entry 'galaxy-claude-opus-5-标准' for key 'uk_gx_model_group_name'`，
-- ODKU 没接住 —— 官方文档对多唯一键的表本来就直说了不建议用它。
--
-- 所以这一段的写法是：**让 group_id 成为唯一可能撞的键**（1a 删掉同名的占位分组、
-- 1b 不写 is_default、1c 单独设默认）。这样 ODKU 的语义没有第二种解释。
--
-- 所以先按**迁移算出来的那个确定 id**（md5(biz_line|model|'default')）把占位分组删掉，
-- 只删这 9 个模型的、只删 id 对得上的那一行：认名字会误删运营自己建的「标准」。
-- 这时候还没有任何密钥选得中它（密钥要在使用端自己选，而分组才刚建出来）。
DELETE FROM `zt_galaxy_model_group`
 WHERE `biz_line` = 'galaxy'
   AND `model_id` IN ('claude-opus-5', 'claude-opus-4-8', 'claude-fable-5-1', 'claude-sonnet-5', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5')
   AND `group_id` = CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|',`model_id`,'|default')), 1, 24)));


-- 1b) 分组本体。**这里一律不写 is_default**（见 1c）：带着它插，就会同时撞
-- (model,name) 和 (model,is_default) 两个唯一键，又回到上面那个 1062。
INSERT INTO `zt_galaxy_model_group`
  (`biz_line`, `group_id`, `model_id`, `name`, `summary`, `efforts_json`, `allow_fast`, `listed`, `is_default`, `sort_order`, `created_time`, `updated_time`)
VALUES
  -- ---------- claude-opus-5 ----------
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-opus-5','|','low')), 1, 24))), 'claude-opus-5', '轻量', '浅思考，适合改点小东西', '["low"]', 1, 1, NULL, 0, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-opus-5','|','medium')), 1, 24))), 'claude-opus-5', '标准', '常规思考深度，日常开发默认这一档', '["medium"]', 1, 1, NULL, 10, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-opus-5','|','high')), 1, 24))), 'claude-opus-5', '深度', '想得更久，复杂问题一次说清', '["high"]', 0, 1, NULL, 20, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-opus-5','|','xhigh')), 1, 24))), 'claude-opus-5', '极深', '长链推理，疑难排查与大改动', '["xhigh"]', 0, 1, NULL, 30, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-opus-5','|','max')), 1, 24))), 'claude-opus-5', '至深', '最深的常规档，慢且贵', '["max"]', 0, 1, NULL, 40, NOW(3), NOW(3)),
  -- ---------- claude-opus-4-8 ----------
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-opus-4-8','|','low')), 1, 24))), 'claude-opus-4-8', '轻量', '浅思考，适合改点小东西', '["low"]', 1, 1, NULL, 0, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-opus-4-8','|','medium')), 1, 24))), 'claude-opus-4-8', '标准', '常规思考深度，日常开发默认这一档', '["medium"]', 1, 1, NULL, 10, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-opus-4-8','|','high')), 1, 24))), 'claude-opus-4-8', '深度', '想得更久，复杂问题一次说清', '["high"]', 0, 1, NULL, 20, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-opus-4-8','|','xhigh')), 1, 24))), 'claude-opus-4-8', '极深', '长链推理，疑难排查与大改动', '["xhigh"]', 0, 1, NULL, 30, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-opus-4-8','|','max')), 1, 24))), 'claude-opus-4-8', '至深', '最深的常规档，慢且贵', '["max"]', 0, 1, NULL, 40, NOW(3), NOW(3)),
  -- ---------- claude-fable-5-1 ----------
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-fable-5-1','|','low')), 1, 24))), 'claude-fable-5-1', '轻量', '浅思考，适合改点小东西', '["low"]', 1, 1, NULL, 0, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-fable-5-1','|','medium')), 1, 24))), 'claude-fable-5-1', '标准', '常规思考深度，日常开发默认这一档', '["medium"]', 1, 1, NULL, 10, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-fable-5-1','|','high')), 1, 24))), 'claude-fable-5-1', '深度', '想得更久，复杂问题一次说清', '["high"]', 0, 1, NULL, 20, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-fable-5-1','|','xhigh')), 1, 24))), 'claude-fable-5-1', '极深', '长链推理，疑难排查与大改动', '["xhigh"]', 0, 1, NULL, 30, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-fable-5-1','|','max')), 1, 24))), 'claude-fable-5-1', '至深', '最深的常规档，慢且贵', '["max"]', 0, 1, NULL, 40, NOW(3), NOW(3)),
  -- ---------- claude-sonnet-5 ----------
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-sonnet-5','|','low')), 1, 24))), 'claude-sonnet-5', '轻量', '浅思考，适合改点小东西', '["low"]', 1, 1, NULL, 0, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-sonnet-5','|','medium')), 1, 24))), 'claude-sonnet-5', '标准', '常规思考深度，日常开发默认这一档', '["medium"]', 1, 1, NULL, 10, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-sonnet-5','|','high')), 1, 24))), 'claude-sonnet-5', '深度', '想得更久，复杂问题一次说清', '["high"]', 0, 1, NULL, 20, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-sonnet-5','|','xhigh')), 1, 24))), 'claude-sonnet-5', '极深', '长链推理，疑难排查与大改动', '["xhigh"]', 0, 1, NULL, 30, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-sonnet-5','|','max')), 1, 24))), 'claude-sonnet-5', '至深', '最深的常规档，慢且贵', '["max"]', 0, 1, NULL, 40, NOW(3), NOW(3)),
  -- ---------- gpt-6-astra ----------
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-6-astra','|','low')), 1, 24))), 'gpt-6-astra', '轻量', '浅思考，适合改点小东西', '["low"]', 1, 1, NULL, 0, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-6-astra','|','medium')), 1, 24))), 'gpt-6-astra', '标准', '常规思考深度，日常开发默认这一档', '["medium"]', 1, 1, NULL, 10, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-6-astra','|','high')), 1, 24))), 'gpt-6-astra', '深度', '想得更久，复杂问题一次说清', '["high"]', 0, 1, NULL, 20, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-6-astra','|','xhigh')), 1, 24))), 'gpt-6-astra', '极深', '长链推理，疑难排查与大改动', '["xhigh"]', 0, 1, NULL, 30, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-6-astra','|','max')), 1, 24))), 'gpt-6-astra', '至深', '最深的常规档，慢且贵', '["max"]', 0, 1, NULL, 40, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-6-astra','|','ultra')), 1, 24))), 'gpt-6-astra', '极限', '极限深度，只在真的需要时用', '["ultra"]', 0, 1, NULL, 50, NOW(3), NOW(3)),
  -- ---------- gpt-5.6-sol ----------
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-sol','|','low')), 1, 24))), 'gpt-5.6-sol', '轻量', '浅思考，适合改点小东西', '["low"]', 1, 1, NULL, 0, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-sol','|','medium')), 1, 24))), 'gpt-5.6-sol', '标准', '常规思考深度，日常开发默认这一档', '["medium"]', 1, 1, NULL, 10, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-sol','|','high')), 1, 24))), 'gpt-5.6-sol', '深度', '想得更久，复杂问题一次说清', '["high"]', 0, 1, NULL, 20, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-sol','|','xhigh')), 1, 24))), 'gpt-5.6-sol', '极深', '长链推理，疑难排查与大改动', '["xhigh"]', 0, 1, NULL, 30, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-sol','|','max')), 1, 24))), 'gpt-5.6-sol', '至深', '最深的常规档，慢且贵', '["max"]', 0, 1, NULL, 40, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-sol','|','ultra')), 1, 24))), 'gpt-5.6-sol', '极限', '极限深度，只在真的需要时用', '["ultra"]', 0, 1, NULL, 50, NOW(3), NOW(3)),
  -- ---------- gpt-5.6-terra ----------
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-terra','|','low')), 1, 24))), 'gpt-5.6-terra', '轻量', '浅思考，适合改点小东西', '["low"]', 1, 1, NULL, 0, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-terra','|','medium')), 1, 24))), 'gpt-5.6-terra', '标准', '常规思考深度，日常开发默认这一档', '["medium"]', 1, 1, NULL, 10, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-terra','|','high')), 1, 24))), 'gpt-5.6-terra', '深度', '想得更久，复杂问题一次说清', '["high"]', 0, 1, NULL, 20, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-terra','|','xhigh')), 1, 24))), 'gpt-5.6-terra', '极深', '长链推理，疑难排查与大改动', '["xhigh"]', 0, 1, NULL, 30, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-terra','|','max')), 1, 24))), 'gpt-5.6-terra', '至深', '最深的常规档，慢且贵', '["max"]', 0, 1, NULL, 40, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-terra','|','ultra')), 1, 24))), 'gpt-5.6-terra', '极限', '极限深度，只在真的需要时用', '["ultra"]', 0, 1, NULL, 50, NOW(3), NOW(3)),
  -- ---------- gpt-5.6-luna ----------
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-luna','|','low')), 1, 24))), 'gpt-5.6-luna', '轻量', '浅思考，适合改点小东西', '["low"]', 1, 1, NULL, 0, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-luna','|','medium')), 1, 24))), 'gpt-5.6-luna', '标准', '常规思考深度，日常开发默认这一档', '["medium"]', 1, 1, NULL, 10, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-luna','|','high')), 1, 24))), 'gpt-5.6-luna', '深度', '想得更久，复杂问题一次说清', '["high"]', 0, 1, NULL, 20, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-luna','|','xhigh')), 1, 24))), 'gpt-5.6-luna', '极深', '长链推理，疑难排查与大改动', '["xhigh"]', 0, 1, NULL, 30, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-luna','|','max')), 1, 24))), 'gpt-5.6-luna', '至深', '最深的常规档，慢且贵', '["max"]', 0, 1, NULL, 40, NOW(3), NOW(3)),
  -- ---------- gpt-5.5 ----------
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.5','|','low')), 1, 24))), 'gpt-5.5', '轻量', '浅思考，适合改点小东西', '["low"]', 1, 1, NULL, 0, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.5','|','medium')), 1, 24))), 'gpt-5.5', '标准', '常规思考深度，日常开发默认这一档', '["medium"]', 1, 1, NULL, 10, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.5','|','high')), 1, 24))), 'gpt-5.5', '深度', '想得更久，复杂问题一次说清', '["high"]', 0, 1, NULL, 20, NOW(3), NOW(3)),
  ('galaxy', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.5','|','xhigh')), 1, 24))), 'gpt-5.5', '极深', '长链推理，疑难排查与大改动', '["xhigh"]', 0, 1, NULL, 30, NOW(3), NOW(3))
-- 冲突时更新：名字与说明可能改过，但 **is_default 不在更新列里** ——
-- 运营在管理端改过默认分组之后，重跑这份种子不该把它改回来。
ON DUPLICATE KEY UPDATE
  `name` = VALUES(`name`), `summary` = VALUES(`summary`),
  `efforts_json` = VALUES(`efforts_json`), `allow_fast` = VALUES(`allow_fast`),
  `sort_order` = VALUES(`sort_order`), `updated_time` = NOW(3);


-- 1c) 设默认分组，两句：先全清、再立一个。
--
-- 分两句而不是在上面那条 INSERT 里带 is_default：同一个模型同时只能有一个默认分组
-- （uk_gx_model_group_default 靠「NULL 不参与唯一性」保证），插的时候带上它就会
-- 和已有的默认分组撞键。先清后立，中间那一瞬没有默认分组，撞不出重复。
--
-- 立哪一个：各族**官方默认档**那一组（Claude 的 high = 「深度」，Codex 的 medium =
-- 「标准」）。没选分组的老密钥落在它上面，所以它必须等于「不选分组时上游真会跑的那一档」，
-- 否则那些密钥会在毫不知情的情况下换了一档深浅、换了一份价。
UPDATE `zt_galaxy_model_group`
   SET `is_default` = NULL, `updated_time` = NOW(3)
 WHERE `biz_line` = 'galaxy' AND `model_id` IN ('claude-opus-5', 'claude-opus-4-8', 'claude-fable-5-1', 'claude-sonnet-5', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5');

UPDATE `zt_galaxy_model_group`
   SET `is_default` = 1, `updated_time` = NOW(3)
 WHERE `biz_line` = 'galaxy'
   AND `model_id` IN ('claude-opus-5', 'claude-opus-4-8', 'claude-fable-5-1', 'claude-sonnet-5', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5')
   AND `group_id` = CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|',`model_id`,'|',
       IF(`model_id` LIKE 'claude%', 'high', 'medium'))), 1, 24)));


-- -------------------------------------------------------------------------
-- 2. 价目
--
-- 只铺 output 一个单位：强度与档次的成本差全部落在输出桶里（推理 token 计在 output）。
-- input / cache_read / cache_write 走兜底行，见文件头的前置条件第 3 条。
-- -------------------------------------------------------------------------

INSERT INTO `zt_galaxy_price`
  (`biz_line`, `kind`, `model_id`, `group_id`, `unit`, `effective_from`,
   `price`, `currency`, `provider_price`, `provider_share`)
VALUES
  -- ---------- claude-opus-5 ----------
  ('galaxy', 'llm.chat', 'claude-opus-5', '', 'llm.output_tokens', '2026-01-01 00:00:00',
   15000000, 'CNY', 10500000, 0.7),   -- 模型通价（没单独定价的分组按它收）＝默认档 high
  ('galaxy', 'llm.chat', 'claude-opus-5', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-opus-5','|','low')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   10050000, 'CNY', 7035000, 0.7),   -- 「轻量」 ×0.67  ¥10.05 / ¥7.04
  ('galaxy', 'llm.chat', 'claude-opus-5', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-opus-5','|','medium')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   11400000, 'CNY', 7980000, 0.7),   -- 「标准」 ×0.76  ¥11.40 / ¥7.98
  ('galaxy', 'llm.chat', 'claude-opus-5', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-opus-5','|','high')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   15000000, 'CNY', 10500000, 0.7),   -- 「深度」 ×1     ¥15.00 / ¥10.50
  ('galaxy', 'llm.chat', 'claude-opus-5', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-opus-5','|','xhigh')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   24000000, 'CNY', 16800000, 0.7),   -- 「极深」 ×1.6   ¥24.00 / ¥16.80
  ('galaxy', 'llm.chat', 'claude-opus-5', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-opus-5','|','max')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   25500000, 'CNY', 17850000, 0.7),   -- 「至深」 ×1.7   ¥25.50 / ¥17.85
  -- ---------- claude-opus-4-8 ----------
  ('galaxy', 'llm.chat', 'claude-opus-4-8', '', 'llm.output_tokens', '2026-01-01 00:00:00',
   15000000, 'CNY', 10500000, 0.7),   -- 模型通价（没单独定价的分组按它收）＝默认档 high
  ('galaxy', 'llm.chat', 'claude-opus-4-8', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-opus-4-8','|','low')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   10800000, 'CNY', 7560000, 0.7),   -- 「轻量」 ×0.72  ¥10.80 / ¥7.56
  ('galaxy', 'llm.chat', 'claude-opus-4-8', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-opus-4-8','|','medium')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   13500000, 'CNY', 9450000, 0.7),   -- 「标准」 ×0.9   ¥13.50 / ¥9.45
  ('galaxy', 'llm.chat', 'claude-opus-4-8', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-opus-4-8','|','high')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   15000000, 'CNY', 10500000, 0.7),   -- 「深度」 ×1     ¥15.00 / ¥10.50
  ('galaxy', 'llm.chat', 'claude-opus-4-8', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-opus-4-8','|','xhigh')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   24750000, 'CNY', 17325000, 0.7),   -- 「极深」 ×1.65  ¥24.75 / ¥17.32
  ('galaxy', 'llm.chat', 'claude-opus-4-8', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-opus-4-8','|','max')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   28200000, 'CNY', 19740000, 0.7),   -- 「至深」 ×1.88  ¥28.20 / ¥19.74
  -- ---------- claude-fable-5-1 ----------
  ('galaxy', 'llm.chat', 'claude-fable-5-1', '', 'llm.output_tokens', '2026-01-01 00:00:00',
   30000000, 'CNY', 21000000, 0.7),   -- 模型通价（没单独定价的分组按它收）＝默认档 high
  ('galaxy', 'llm.chat', 'claude-fable-5-1', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-fable-5-1','|','low')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   22500000, 'CNY', 15750000, 0.7),   -- 「轻量」 ×0.75  ¥22.50 / ¥15.75
  ('galaxy', 'llm.chat', 'claude-fable-5-1', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-fable-5-1','|','medium')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   25800000, 'CNY', 18060000, 0.7),   -- 「标准」 ×0.86  ¥25.80 / ¥18.06
  ('galaxy', 'llm.chat', 'claude-fable-5-1', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-fable-5-1','|','high')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   30000000, 'CNY', 21000000, 0.7),   -- 「深度」 ×1     ¥30.00 / ¥21.00
  ('galaxy', 'llm.chat', 'claude-fable-5-1', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-fable-5-1','|','xhigh')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   41400000, 'CNY', 28980000, 0.7),   -- 「极深」 ×1.38  ¥41.40 / ¥28.98
  ('galaxy', 'llm.chat', 'claude-fable-5-1', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-fable-5-1','|','max')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   52200000, 'CNY', 36540000, 0.7),   -- 「至深」 ×1.74  ¥52.20 / ¥36.54
  -- ---------- claude-sonnet-5 ----------
  ('galaxy', 'llm.chat', 'claude-sonnet-5', '', 'llm.output_tokens', '2026-01-01 00:00:00',
   6000000, 'CNY', 4200000, 0.7),   -- 模型通价（没单独定价的分组按它收）＝默认档 high
  ('galaxy', 'llm.chat', 'claude-sonnet-5', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-sonnet-5','|','low')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   2820000, 'CNY', 1974000, 0.7),   -- 「轻量」 ×0.47  ¥2.82 / ¥1.97
  ('galaxy', 'llm.chat', 'claude-sonnet-5', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-sonnet-5','|','medium')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   4440000, 'CNY', 3108000, 0.7),   -- 「标准」 ×0.74  ¥4.44 / ¥3.11
  ('galaxy', 'llm.chat', 'claude-sonnet-5', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-sonnet-5','|','high')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   6000000, 'CNY', 4200000, 0.7),   -- 「深度」 ×1     ¥6.00 / ¥4.20
  ('galaxy', 'llm.chat', 'claude-sonnet-5', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-sonnet-5','|','xhigh')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   14460000, 'CNY', 10122000, 0.7),   -- 「极深」 ×2.41  ¥14.46 / ¥10.12
  ('galaxy', 'llm.chat', 'claude-sonnet-5', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','claude-sonnet-5','|','max')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   33540000, 'CNY', 23478000, 0.7),   -- 「至深」 ×5.59  ¥33.54 / ¥23.48
  -- ---------- gpt-6-astra ----------
  ('galaxy', 'llm.chat', 'gpt-6-astra', '', 'llm.output_tokens', '2026-01-01 00:00:00',
   12750000, 'CNY', 8925000, 0.7),   -- 模型通价（没单独定价的分组按它收）＝默认档 medium
  ('galaxy', 'llm.chat', 'gpt-6-astra', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-6-astra','|','low')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   10500000, 'CNY', 7350000, 0.7),   -- 「轻量」 ×0.7   ¥10.50 / ¥7.35
  ('galaxy', 'llm.chat', 'gpt-6-astra', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-6-astra','|','medium')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   12750000, 'CNY', 8925000, 0.7),   -- 「标准」 ×0.85  ¥12.75 / ¥8.93
  ('galaxy', 'llm.chat', 'gpt-6-astra', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-6-astra','|','high')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   15000000, 'CNY', 10500000, 0.7),   -- 「深度」 ×1     ¥15.00 / ¥10.50
  ('galaxy', 'llm.chat', 'gpt-6-astra', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-6-astra','|','xhigh')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   24000000, 'CNY', 16800000, 0.7),   -- 「极深」 ×1.6   ¥24.00 / ¥16.80
  ('galaxy', 'llm.chat', 'gpt-6-astra', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-6-astra','|','max')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   37500000, 'CNY', 26250000, 0.7),   -- 「至深」 ×2.5   ¥37.50 / ¥26.25
  ('galaxy', 'llm.chat', 'gpt-6-astra', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-6-astra','|','ultra')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   52500000, 'CNY', 36750000, 0.7),   -- 「极限」 ×3.5   ¥52.50 / ¥36.75
  -- ---------- gpt-5.6-sol ----------
  ('galaxy', 'llm.chat', 'gpt-5.6-sol', '', 'llm.output_tokens', '2026-01-01 00:00:00',
   12750000, 'CNY', 8925000, 0.7),   -- 模型通价（没单独定价的分组按它收）＝默认档 medium
  ('galaxy', 'llm.chat', 'gpt-5.6-sol', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-sol','|','low')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   10500000, 'CNY', 7350000, 0.7),   -- 「轻量」 ×0.7   ¥10.50 / ¥7.35
  ('galaxy', 'llm.chat', 'gpt-5.6-sol', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-sol','|','medium')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   12750000, 'CNY', 8925000, 0.7),   -- 「标准」 ×0.85  ¥12.75 / ¥8.93
  ('galaxy', 'llm.chat', 'gpt-5.6-sol', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-sol','|','high')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   15000000, 'CNY', 10500000, 0.7),   -- 「深度」 ×1     ¥15.00 / ¥10.50
  ('galaxy', 'llm.chat', 'gpt-5.6-sol', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-sol','|','xhigh')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   24000000, 'CNY', 16800000, 0.7),   -- 「极深」 ×1.6   ¥24.00 / ¥16.80
  ('galaxy', 'llm.chat', 'gpt-5.6-sol', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-sol','|','max')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   37500000, 'CNY', 26250000, 0.7),   -- 「至深」 ×2.5   ¥37.50 / ¥26.25
  ('galaxy', 'llm.chat', 'gpt-5.6-sol', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-sol','|','ultra')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   52500000, 'CNY', 36750000, 0.7),   -- 「极限」 ×3.5   ¥52.50 / ¥36.75
  -- ---------- gpt-5.6-terra ----------
  ('galaxy', 'llm.chat', 'gpt-5.6-terra', '', 'llm.output_tokens', '2026-01-01 00:00:00',
   12750000, 'CNY', 8925000, 0.7),   -- 模型通价（没单独定价的分组按它收）＝默认档 medium
  ('galaxy', 'llm.chat', 'gpt-5.6-terra', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-terra','|','low')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   10500000, 'CNY', 7350000, 0.7),   -- 「轻量」 ×0.7   ¥10.50 / ¥7.35
  ('galaxy', 'llm.chat', 'gpt-5.6-terra', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-terra','|','medium')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   12750000, 'CNY', 8925000, 0.7),   -- 「标准」 ×0.85  ¥12.75 / ¥8.93
  ('galaxy', 'llm.chat', 'gpt-5.6-terra', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-terra','|','high')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   15000000, 'CNY', 10500000, 0.7),   -- 「深度」 ×1     ¥15.00 / ¥10.50
  ('galaxy', 'llm.chat', 'gpt-5.6-terra', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-terra','|','xhigh')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   24000000, 'CNY', 16800000, 0.7),   -- 「极深」 ×1.6   ¥24.00 / ¥16.80
  ('galaxy', 'llm.chat', 'gpt-5.6-terra', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-terra','|','max')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   37500000, 'CNY', 26250000, 0.7),   -- 「至深」 ×2.5   ¥37.50 / ¥26.25
  ('galaxy', 'llm.chat', 'gpt-5.6-terra', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-terra','|','ultra')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   52500000, 'CNY', 36750000, 0.7),   -- 「极限」 ×3.5   ¥52.50 / ¥36.75
  -- ---------- gpt-5.6-luna ----------
  ('galaxy', 'llm.chat', 'gpt-5.6-luna', '', 'llm.output_tokens', '2026-01-01 00:00:00',
   12750000, 'CNY', 8925000, 0.7),   -- 模型通价（没单独定价的分组按它收）＝默认档 medium
  ('galaxy', 'llm.chat', 'gpt-5.6-luna', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-luna','|','low')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   10500000, 'CNY', 7350000, 0.7),   -- 「轻量」 ×0.7   ¥10.50 / ¥7.35
  ('galaxy', 'llm.chat', 'gpt-5.6-luna', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-luna','|','medium')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   12750000, 'CNY', 8925000, 0.7),   -- 「标准」 ×0.85  ¥12.75 / ¥8.93
  ('galaxy', 'llm.chat', 'gpt-5.6-luna', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-luna','|','high')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   15000000, 'CNY', 10500000, 0.7),   -- 「深度」 ×1     ¥15.00 / ¥10.50
  ('galaxy', 'llm.chat', 'gpt-5.6-luna', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-luna','|','xhigh')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   24000000, 'CNY', 16800000, 0.7),   -- 「极深」 ×1.6   ¥24.00 / ¥16.80
  ('galaxy', 'llm.chat', 'gpt-5.6-luna', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.6-luna','|','max')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   37500000, 'CNY', 26250000, 0.7),   -- 「至深」 ×2.5   ¥37.50 / ¥26.25
  -- ---------- gpt-5.5 ----------
  ('galaxy', 'llm.chat', 'gpt-5.5', '', 'llm.output_tokens', '2026-01-01 00:00:00',
   12750000, 'CNY', 8925000, 0.7),   -- 模型通价（没单独定价的分组按它收）＝默认档 medium
  ('galaxy', 'llm.chat', 'gpt-5.5', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.5','|','low')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   10500000, 'CNY', 7350000, 0.7),   -- 「轻量」 ×0.7   ¥10.50 / ¥7.35
  ('galaxy', 'llm.chat', 'gpt-5.5', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.5','|','medium')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   12750000, 'CNY', 8925000, 0.7),   -- 「标准」 ×0.85  ¥12.75 / ¥8.93
  ('galaxy', 'llm.chat', 'gpt-5.5', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.5','|','high')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   15000000, 'CNY', 10500000, 0.7),   -- 「深度」 ×1     ¥15.00 / ¥10.50
  ('galaxy', 'llm.chat', 'gpt-5.5', CONCAT('mg_', UPPER(SUBSTRING(MD5(CONCAT('galaxy','|','gpt-5.5','|','xhigh')), 1, 24))), 'llm.output_tokens', '2026-01-01 00:00:00',
   24000000, 'CNY', 16800000, 0.7)    -- 「极深」 ×1.6   ¥24.00 / ¥16.80

ON DUPLICATE KEY UPDATE
  `price` = VALUES(`price`), `currency` = VALUES(`currency`),
  `provider_price` = VALUES(`provider_price`), `provider_share` = VALUES(`provider_share`);


-- -------------------------------------------------------------------------
-- 3. 自检
-- -------------------------------------------------------------------------

-- a) 每个模型的分组数，以及哪一个是默认分组。
SELECT `model_id`, COUNT(*) AS `分组数`,
       GROUP_CONCAT(`name` ORDER BY `sort_order`) AS `由浅到深`,
       MAX(IF(`is_default` = 1, `name`, NULL)) AS `默认分组`
  FROM `zt_galaxy_model_group`
 WHERE `biz_line` = 'galaxy'
 GROUP BY `model_id`
 ORDER BY `model_id`;

-- b) 每个模型都必须有那一行模型通价（group_id = ''），否则没单独定价的分组
--    会掉回 kind 兜底价 —— 那是一个和这批模型无关的数。
SELECT m.`model_id` AS `缺模型通价的模型`
  FROM `zt_galaxy_model_group` m
 WHERE m.`biz_line` = 'galaxy'
   AND NOT EXISTS (SELECT 1 FROM `zt_galaxy_price` p
                    WHERE p.`biz_line` = 'galaxy' AND p.`kind` = 'llm.chat'
                      AND p.`model_id` = m.`model_id` AND p.`group_id` = ''
                      AND p.`unit` = 'llm.output_tokens')
 GROUP BY m.`model_id`;

-- c) 价目行引用的分组必须存在。指向不存在的分组 = 这行价永远匹配不上。
SELECT p.`model_id`, p.`group_id` AS `指向不存在分组的价目行`
  FROM `zt_galaxy_price` p
 WHERE p.`biz_line` = 'galaxy' AND p.`group_id` <> ''
   AND NOT EXISTS (SELECT 1 FROM `zt_galaxy_model_group` g
                    WHERE g.`biz_line` = 'galaxy' AND g.`group_id` = p.`group_id`);

-- d) 兜底行还在不在（这份文件不铺它，但少了它 input / cache 会静默按 0 收）。
SELECT `unit`, `price` FROM `zt_galaxy_price`
 WHERE `biz_line` = 'galaxy' AND `kind` = 'llm.chat' AND `model_id` = '' AND `group_id` = ''
 ORDER BY `unit`;
