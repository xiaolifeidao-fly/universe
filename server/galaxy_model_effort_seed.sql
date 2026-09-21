-- =========================================================================
-- 模型广场：9 个模型 × 各自的推理强度 = 47 个组合
--
-- 全部 upsert，**重复执行安全**，按各自的唯一键落位：
--   uk_gx_model = (biz_line, model_id)
--   uk_gx_price = (biz_line, kind, model_id, effort, unit, effective_from)
--
-- 量纲：整数微元，÷1_000_000 得「元」。price 是**每百万 token** 的价。
-- 计费口径 cost = amount × price ÷ 1_000_000（billing.go 的 priceScale）。
--
-- ⚠️ 前置条件（按你这套「线上库常落后于 migrations」的实际情况，跑之前先盘一遍）：
--   1. 建表：server/galaxy.sql（新建库已含 effort 列与含 effort 的 uk_gx_price）
--   2. 存量库还要确认这三条迁移都跑过，而且**跑完整了**：
--        20260919_galaxy_price_model.sql      给价目表加 model_id
--        20260919_galaxy_provider_price.sql   给价目表加 provider_price
--        20260920_galaxy_price_effort.sql     加 effort 列 **并换唯一键**（两步！）
--      盘点语句：
--        SELECT column_name FROM information_schema.columns
--         WHERE table_schema=DATABASE() AND table_name='zt_galaxy_price';
--   3. 兜底价：跑过 galaxy_seed.sql 或 galaxyinit。这份文件只铺 output 一个单位，
--      input / cache_read / cache_write 全靠 (model_id='', effort='') 的兜底行 ——
--      那几行不在的话，那些单位会**静默按 0 计费**，不报错。
--      盘点语句：
--        SELECT unit FROM zt_galaxy_price
--         WHERE biz_line='galaxy' AND kind='llm.chat' AND model_id='' AND effort='';
--
-- 四段，可以分开跑：
--   1. 模型目录（不涉及钱）
--   2. 只留这 9 个（把其余模型下架）—— 可选，跑之前先看命中集
--   3. 价目（涉及钱）
--   4. 跑完自检
--
-- ⚠️ **跑在 galaxy_seed.sql 之后，而且之后别再回头跑它。** 两份文件对
--   claude-opus-5 / claude-sonnet-5 / claude-fable-5-1 / gpt-5.6-terra 写同一个唯一键，
--   字段值不一样（context_tokens 200000 vs 1000000、sort_order、summary、featured），
--   两边都是 upsert，**谁后跑谁说了算**。更要紧的是 galaxy_seed.sql 还会把
--   claude-haiku-4-5-20251001 重新插成 listed=1，把第 2 段的下架整个撤销。
--   模型目录以这份文件为准；galaxy_seed.sql 从此只当价目表（第 1 段）的出处。
-- =========================================================================

-- effective_from 是 **TIMESTAMP** 列，写进去的字面量按会话时区折成 UTC 存，
-- 而它在唯一键里 —— 换一个时区的客户端重跑，同一串 '2026-01-01 00:00:00' 会落在
-- 另一个瞬间，于是不走 ON DUPLICATE KEY 而是**再插一整套行**。钉死它：
SET time_zone = '+08:00';


-- -------------------------------------------------------------------------
-- 0. 组合清单
--
-- 这张表是从**本机的两个客户端**里问出来的，不是推的：
--
--   Claude   `claude --effort bogus` → 「Valid values: low, medium, high, xhigh, max.」
--            逐模型的能力位（max_effort / xhigh_effort）取自 Claude Code 内置的
--            「Hand-maintained baked-in model catalog」。
--            CLI 里那个 **ultracode 不是一档**：它 =「xhigh + 动态工作流编排，
--            只对本会话生效」（二进制原话），上线时 effort 字段写的就是 xhigh。
--
--   Codex    ~/.codex/.codex-global-state.json 的活工具 schema：
--            「supported reasoning efforts: low, medium, high, xhigh, max, ultra」。
--            比 ~/.codex/models_cache.json 新（后者里 gpt-5.5 还是空数组）。
--
--   模型               族      档位                             组合
--   ----------------  ------  -------------------------------  ----
--   claude-opus-5     claude  low medium high xhigh max           5
--   claude-opus-4-8   claude  low medium high xhigh max           5
--   claude-fable-5-1  claude  low medium high xhigh max           5
--   claude-sonnet-5   claude  low medium high xhigh max           5
--   gpt-6-astra       gpt     low medium high xhigh max ultra     6
--   gpt-5.6-sol       gpt     low medium high xhigh max ultra     6
--   gpt-5.6-terra     gpt     low medium high xhigh max ultra     6
--   gpt-5.6-luna      gpt     low medium high xhigh max           5
--   gpt-5.5           gpt     low medium high xhigh               4
--   --------------------------------------------------------  ----
--                                                        合计    47
--
-- model_id 必须是**客户端真会发出来的那一串**：你说的「6.0astra」本机不存在，
-- 真串是 gpt-6-astra。填错了请求匹配不上，会静默走兜底价。
-- -------------------------------------------------------------------------


-- -------------------------------------------------------------------------
-- 1. 模型目录（zt_galaxy_model）
--
-- 这张表只管「模型广场上怎么把这个模型讲清楚」，不参与计价、不参与派单。
--
-- ⚠️ ON DUPLICATE KEY UPDATE **刻意不含 listed / featured / sort_order**。
-- 那三列是运营在管理端自己调的：上游断供时手工下架一个模型，任何人重跑一次
-- 这份「幂等」种子就会把它重新置 1，模型广场上又冒出来一个调不动的模型。
-- 新行的初始值仍由下面的 VALUES 决定；老行保持运营现状。
-- 真要强制上架这 9 个，单跑第 2 段末尾那条注释掉的 UPDATE。
--
-- 同理不动 created_time、list_input_price / list_output_price / list_cache_price
-- —— 后三个是**官方参考价**（卡片上划掉的那道线），见第 3 段末尾。
-- -------------------------------------------------------------------------

INSERT INTO `zt_galaxy_model`
  (`biz_line`, `model_id`, `display_name`, `vendor`, `family`, `kind`,
   `context_tokens`, `max_output_tokens`,
   `currency`, `tags_json`, `summary`, `badge_text`, `badge_tone`,
   `listed`, `featured`, `sort_order`, `created_time`, `updated_time`)
VALUES
  -- ---- Claude ----
  ('galaxy', 'claude-opus-5', 'Claude Opus 5', 'anthropic', 'claude', 'llm.chat',
   1000000, 128000, 'CNY', '["复杂推理","长代码库","Agent"]',
   '最强的一档，交给它的是那种想清楚比写得快更重要的活。',
   '主推', 'hot', 1, 1, 10, NOW(3), NOW(3)),

  ('galaxy', 'claude-opus-4-8', 'Claude Opus 4.8', 'anthropic', 'claude', 'llm.chat',
   1000000, 128000, 'CNY', '["复杂推理","上一代 Opus"]',
   '上一代 Opus，能力接近而价格更友好，跑批量任务时值得先试它。',
   '', '', 1, 0, 20, NOW(3), NOW(3)),

  ('galaxy', 'claude-fable-5-1', 'Claude Fable 5.1', 'anthropic', 'claude', 'llm.chat',
   1000000, 128000, 'CNY', '["长文本","写作","最深推理"]',
   '最能打也最贵的一档，上游单价是 Opus 的两倍，留给真正难的活。',
   '', '', 1, 0, 30, NOW(3), NOW(3)),

  ('galaxy', 'claude-sonnet-5', 'Claude Sonnet 5', 'anthropic', 'claude', 'llm.chat',
   1000000, 128000, 'CNY', '["日常编码","速度均衡","Claude Code"]',
   '日常写代码的默认选择，快、稳、便宜，Claude Code 里跑得最多的就是它。',
   '性价比', 'value', 1, 1, 40, NOW(3), NOW(3)),

  -- ---- Codex / GPT ----
  ('galaxy', 'gpt-6-astra', 'GPT-6 Astra', 'openai', 'gpt', 'llm.chat',
   0, 0, 'CNY', '["OpenAI 兼容","Codex","旗舰"]',
   '这一族最能打的一档，复杂又吃力的活交给它。',
   '首发', 'new', 1, 1, 50, NOW(3), NOW(3)),

  ('galaxy', 'gpt-5.6-sol', 'GPT-5.6 Sol', 'openai', 'gpt', 'llm.chat',
   272000, 0, 'CNY', '["OpenAI 兼容","Codex","Agent"]',
   '最新的一线 Agent 编码模型。',
   '', '', 1, 1, 60, NOW(3), NOW(3)),

  ('galaxy', 'gpt-5.6-terra', 'GPT-5.6 Terra', 'openai', 'gpt', 'llm.chat',
   272000, 0, 'CNY', '["OpenAI 兼容","Codex","均衡"]',
   '日常活的均衡档，Codex CLI 与 OpenAI SDK 改个 base_url 就能用。',
   '均衡', 'neutral', 1, 0, 70, NOW(3), NOW(3)),

  ('galaxy', 'gpt-5.6-luna', 'GPT-5.6 Luna', 'openai', 'gpt', 'llm.chat',
   272000, 0, 'CNY', '["OpenAI 兼容","Codex","低成本"]',
   '快而便宜的一档，量大单次简单的活用它最划算。',
   '', '', 1, 0, 80, NOW(3), NOW(3)),

  ('galaxy', 'gpt-5.5', 'GPT-5.5', 'openai', 'gpt', 'llm.chat',
   272000, 0, 'CNY', '["OpenAI 兼容","复杂编码","研究"]',
   '面向复杂编码、研究与真实工作的一档。',
   '', '', 1, 0, 90, NOW(3), NOW(3))
ON DUPLICATE KEY UPDATE
  `display_name`      = VALUES(`display_name`),
  `vendor`            = VALUES(`vendor`),
  `family`            = VALUES(`family`),
  `kind`              = VALUES(`kind`),
  `context_tokens`    = VALUES(`context_tokens`),
  `max_output_tokens` = VALUES(`max_output_tokens`),
  `tags_json`         = VALUES(`tags_json`),
  `summary`           = VALUES(`summary`),
  `badge_text`        = VALUES(`badge_text`),
  `badge_tone`        = VALUES(`badge_tone`),
  `currency`          = VALUES(`currency`),
  `updated_time`      = NOW(3);


-- -------------------------------------------------------------------------
-- 2. 只留这 9 个：其余模型下架（**可选**）
--
-- ⚠️ 跑之前先看命中集。这条会把当前在架、但不在名单里的模型置为 listed=0，
-- 它们会立刻从模型广场、门户、共享端模型页上消失（三处都是 ListModels(biz, true)）。
-- 已经在跑的请求不受影响、历史账单也不受影响，但共享者会看不到自己正在跑的模型。
-- -------------------------------------------------------------------------

-- 先看会动到谁：
SELECT `model_id`, `display_name`, `listed`, `featured`
  FROM `zt_galaxy_model`
 WHERE `biz_line` = 'galaxy'
   AND `model_id` NOT IN (
         'claude-opus-5', 'claude-opus-4-8', 'claude-fable-5-1', 'claude-sonnet-5',
         'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'
       )
   AND (`listed` = 1 OR `featured` = 1);

-- 确认之后再跑这条：
UPDATE `zt_galaxy_model`
   SET `listed` = 0, `featured` = 0, `updated_time` = NOW(3)
 WHERE `biz_line` = 'galaxy'
   AND `model_id` NOT IN (
         'claude-opus-5', 'claude-opus-4-8', 'claude-fable-5-1', 'claude-sonnet-5',
         'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'
       )
   AND (`listed` = 1 OR `featured` = 1);   -- 已下架的不再改，重跑不产生无谓写入

-- 第 1 段刻意不覆盖 listed/featured/sort_order（见那一段的说明）。
-- 如果确实要把这 9 个强制拉回上架状态，单独跑这条：
-- UPDATE `zt_galaxy_model` SET `listed` = 1, `updated_time` = NOW(3)
--  WHERE `biz_line` = 'galaxy' AND `listed` = 0
--    AND `model_id` IN ('claude-opus-5','claude-opus-4-8','claude-fable-5-1','claude-sonnet-5',
--                       'gpt-6-astra','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','gpt-5.5');


-- -------------------------------------------------------------------------
-- 3. 价目（zt_galaxy_price）—— 9 行基准 + 47 行分档 = 56 行
--
-- 价**不是我拍的**，两个数都来自 Claude Code 内置的模型目录：
--
--   a) 官方价档 pricing（USD / 百万 token，上游的真实标价）
--        tier_2_10                   input $2   output $10   cache_read $0.2
--        tier_5_25                   input $5   output $25   cache_read $0.5
--        tier_10_50_cache_read_0_25  input $10  output $50   cache_read $0.25
--      → claude-sonnet-5 = tier_2_10、opus-5 / opus-4-8 = tier_5_25、
--        claude-fable-5-1 = tier_10_50_cache_read_0_25
--
--   b) 每个模型自带的 effort_cost_index（以 high = 1 归一）
--        opus-5      low 0.67  medium 0.76  high 1  xhigh 1.60  max 1.70
--        opus-4-8    low 0.72  medium 0.90  high 1  xhigh 1.65  max 1.88
--        fable-5-1   low 0.75  medium 0.86  high 1  xhigh 1.38  max 1.74
--        sonnet-5    low 0.47  medium 0.74  high 1  xhigh 2.41  max 5.59
--
--      注意 sonnet-5 的 max 是它自己 high 的 **5.59 倍**，opus-5 只有 1.70 倍 ——
--      各家各档的陡峭程度差很远，拿一张统一倍率表套所有模型必然有一边算错。
--
-- 算法：price = 现有兜底 output 价 ¥15.00 × (该模型 output 价档 ÷ 25) × 该档系数
--        也就是把 tier_5_25 锚在你现在的 ¥15.00 上，其余模型按上游比例缩放：
--        sonnet ¥6.00、opus ¥15.00、fable ¥30.00。结算价 = 对外价 × 0.7（既有口径）。
--
-- ⚠️ GPT 那五个**本机既没有价档也没有成本系数**，基准沿用 ¥15.00，
--    档位倍率用的是一条**假设**阶梯（low 0.7 / medium 0.85 / high 1 /
--    xhigh 1.6 / max 2.5 / ultra 3.5）。这部分要你自己定。
--
-- **每个模型多一行 effort=''**：模型广场卡片取价传的就是空串
--   （portal.go:271、providermodels.go:91 都是 resolvePrices(rows, kind, model, "")），
--   而 resolvePrices 会把所有 effort 非空的行滤掉。没有这一行，9 张卡片会全部
--   显示成 kind 兜底价并被标「统一价」，42 行分档价一个都不露脸。
--   它同时兜住「铺漏的档」：gpt 一族的 none / minimal 没铺，落到这一行而不是
--   跨模型共用的 kind 兜底价。值取该模型的默认档（claude=high、gpt=medium）。
--
-- **为什么只铺 output**：强度改变的是「想多久」，reasoning token 全落在 output
--   这一桶里（contract 的 UnitReasoningTokens 是 UnitOutputTokens 的子集）。
--   input 与缓存跟强度无关，按四级回落走兜底价即可。
--
-- ⚠️ 这些是**绝对值不是倍率**。以后给某个模型调价，属于它的那 5-7 行要一起改；
--   只改 effort='' 那一行不会生效 —— 取价的第 4 层永远盖住第 3 层，与 effective_from
--   谁新谁旧无关。
-- -------------------------------------------------------------------------

-- 半迁移态的硬断言：只加了 effort 列、没换唯一键时，下面这批行会在同一条 INSERT 里
-- 互相覆盖成每个模型一行（旧键不含 effort），静默按最后一行的价收钱。宁可在这里炸。
-- 写成 PREPARE + SIGNAL（和 migrations/ 里那些迁移同一种写法）。
-- 别用 `SELECT IF(@ok=1, 1, (SELECT 1 FROM 不存在的表))` 那种花招：MySQL 在**准备阶段**
-- 就解析全部表名，两个分支都要解析得开，于是它会无条件报错 —— 键是好的也照样拦你。
SET @uk_ok := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_price'
     AND index_name = 'uk_gx_price' AND column_name = 'effort'
);
SET @guard := IF(@uk_ok = 1,
  'SELECT ''uk_gx_price 含 effort，继续'' AS precheck',
  'SIGNAL SQLSTATE ''45000'' SET MESSAGE_TEXT = ''uk_gx_price 里没有 effort：20260920_galaxy_price_effort.sql 的第 2 步（换索引）没跑完。现在插下去，同一个模型的几档会在旧键上互相覆盖成一行，低档按最贵那档收钱，且不报错。''');
PREPARE guard_stmt FROM @guard;
EXECUTE guard_stmt;
DEALLOCATE PREPARE guard_stmt;

INSERT INTO `zt_galaxy_price`
  (`biz_line`, `kind`, `model_id`, `effort`, `unit`, `effective_from`,
   `price`, `currency`, `provider_price`, `provider_share`)
VALUES
  -- ---------- claude-opus-5（5 档）· 官方价档 tier_5_25（output $25/M → 基准 ¥15.00）· 厂商系数 ----------
  ('galaxy', 'llm.chat', 'claude-opus-5'    , ''       , 'llm.output_tokens', '2026-01-01 00:00:00',  15000000, 'CNY',  10500000, 0.7),   -- 不分强度＝默认档 high ¥15.00
  ('galaxy', 'llm.chat', 'claude-opus-5'    , 'low'    , 'llm.output_tokens', '2026-01-01 00:00:00',  10050000, 'CNY',   7035000, 0.7),   -- ×0.67  ¥10.05 / ¥7.04
  ('galaxy', 'llm.chat', 'claude-opus-5'    , 'medium' , 'llm.output_tokens', '2026-01-01 00:00:00',  11400000, 'CNY',   7980000, 0.7),   -- ×0.76  ¥11.40 / ¥7.98
  ('galaxy', 'llm.chat', 'claude-opus-5'    , 'high'   , 'llm.output_tokens', '2026-01-01 00:00:00',  15000000, 'CNY',  10500000, 0.7),   -- ×1     ¥15.00 / ¥10.50
  ('galaxy', 'llm.chat', 'claude-opus-5'    , 'xhigh'  , 'llm.output_tokens', '2026-01-01 00:00:00',  24000000, 'CNY',  16800000, 0.7),   -- ×1.6   ¥24.00 / ¥16.80
  ('galaxy', 'llm.chat', 'claude-opus-5'    , 'max'    , 'llm.output_tokens', '2026-01-01 00:00:00',  25500000, 'CNY',  17850000, 0.7),   -- ×1.7   ¥25.50 / ¥17.85

  -- ---------- claude-opus-4-8（5 档）· 官方价档 tier_5_25（output $25/M → 基准 ¥15.00）· 厂商系数 ----------
  ('galaxy', 'llm.chat', 'claude-opus-4-8'  , ''       , 'llm.output_tokens', '2026-01-01 00:00:00',  15000000, 'CNY',  10500000, 0.7),   -- 不分强度＝默认档 high ¥15.00
  ('galaxy', 'llm.chat', 'claude-opus-4-8'  , 'low'    , 'llm.output_tokens', '2026-01-01 00:00:00',  10800000, 'CNY',   7560000, 0.7),   -- ×0.72  ¥10.80 / ¥7.56
  ('galaxy', 'llm.chat', 'claude-opus-4-8'  , 'medium' , 'llm.output_tokens', '2026-01-01 00:00:00',  13500000, 'CNY',   9450000, 0.7),   -- ×0.9   ¥13.50 / ¥9.45
  ('galaxy', 'llm.chat', 'claude-opus-4-8'  , 'high'   , 'llm.output_tokens', '2026-01-01 00:00:00',  15000000, 'CNY',  10500000, 0.7),   -- ×1     ¥15.00 / ¥10.50
  ('galaxy', 'llm.chat', 'claude-opus-4-8'  , 'xhigh'  , 'llm.output_tokens', '2026-01-01 00:00:00',  24750000, 'CNY',  17325000, 0.7),   -- ×1.65  ¥24.75 / ¥17.32
  ('galaxy', 'llm.chat', 'claude-opus-4-8'  , 'max'    , 'llm.output_tokens', '2026-01-01 00:00:00',  28200000, 'CNY',  19740000, 0.7),   -- ×1.88  ¥28.20 / ¥19.74

  -- ---------- claude-fable-5-1（5 档）· 官方价档 tier_10_50_cache_read_0_25（output $50/M → 基准 ¥30.00）· 厂商系数 ----------
  ('galaxy', 'llm.chat', 'claude-fable-5-1' , ''       , 'llm.output_tokens', '2026-01-01 00:00:00',  30000000, 'CNY',  21000000, 0.7),   -- 不分强度＝默认档 high ¥30.00
  ('galaxy', 'llm.chat', 'claude-fable-5-1' , 'low'    , 'llm.output_tokens', '2026-01-01 00:00:00',  22500000, 'CNY',  15750000, 0.7),   -- ×0.75  ¥22.50 / ¥15.75
  ('galaxy', 'llm.chat', 'claude-fable-5-1' , 'medium' , 'llm.output_tokens', '2026-01-01 00:00:00',  25800000, 'CNY',  18060000, 0.7),   -- ×0.86  ¥25.80 / ¥18.06
  ('galaxy', 'llm.chat', 'claude-fable-5-1' , 'high'   , 'llm.output_tokens', '2026-01-01 00:00:00',  30000000, 'CNY',  21000000, 0.7),   -- ×1     ¥30.00 / ¥21.00
  ('galaxy', 'llm.chat', 'claude-fable-5-1' , 'xhigh'  , 'llm.output_tokens', '2026-01-01 00:00:00',  41400000, 'CNY',  28980000, 0.7),   -- ×1.38  ¥41.40 / ¥28.98
  ('galaxy', 'llm.chat', 'claude-fable-5-1' , 'max'    , 'llm.output_tokens', '2026-01-01 00:00:00',  52200000, 'CNY',  36540000, 0.7),   -- ×1.74  ¥52.20 / ¥36.54

  -- ---------- claude-sonnet-5（5 档）· 官方价档 tier_2_10（output $10/M → 基准 ¥6.00）· 厂商系数 ----------
  ('galaxy', 'llm.chat', 'claude-sonnet-5'  , ''       , 'llm.output_tokens', '2026-01-01 00:00:00',   6000000, 'CNY',   4200000, 0.7),   -- 不分强度＝默认档 high ¥6.00
  ('galaxy', 'llm.chat', 'claude-sonnet-5'  , 'low'    , 'llm.output_tokens', '2026-01-01 00:00:00',   2820000, 'CNY',   1974000, 0.7),   -- ×0.47  ¥2.82 / ¥1.97
  ('galaxy', 'llm.chat', 'claude-sonnet-5'  , 'medium' , 'llm.output_tokens', '2026-01-01 00:00:00',   4440000, 'CNY',   3108000, 0.7),   -- ×0.74  ¥4.44 / ¥3.11
  ('galaxy', 'llm.chat', 'claude-sonnet-5'  , 'high'   , 'llm.output_tokens', '2026-01-01 00:00:00',   6000000, 'CNY',   4200000, 0.7),   -- ×1     ¥6.00 / ¥4.20
  ('galaxy', 'llm.chat', 'claude-sonnet-5'  , 'xhigh'  , 'llm.output_tokens', '2026-01-01 00:00:00',  14460000, 'CNY',  10122000, 0.7),   -- ×2.41  ¥14.46 / ¥10.12
  ('galaxy', 'llm.chat', 'claude-sonnet-5'  , 'max'    , 'llm.output_tokens', '2026-01-01 00:00:00',  33540000, 'CNY',  23478000, 0.7),   -- ×5.59  ¥33.54 / ¥23.48

  -- ---------- gpt-6-astra（6 档）· 基准沿用兜底价 ¥15.00 · 假设阶梯（本机无价档、无系数） ----------
  ('galaxy', 'llm.chat', 'gpt-6-astra'      , ''       , 'llm.output_tokens', '2026-01-01 00:00:00',  12750000, 'CNY',   8925000, 0.7),   -- 不分强度＝默认档 medium ¥12.75
  ('galaxy', 'llm.chat', 'gpt-6-astra'      , 'low'    , 'llm.output_tokens', '2026-01-01 00:00:00',  10500000, 'CNY',   7350000, 0.7),   -- ×0.7   ¥10.50 / ¥7.35
  ('galaxy', 'llm.chat', 'gpt-6-astra'      , 'medium' , 'llm.output_tokens', '2026-01-01 00:00:00',  12750000, 'CNY',   8925000, 0.7),   -- ×0.85  ¥12.75 / ¥8.93
  ('galaxy', 'llm.chat', 'gpt-6-astra'      , 'high'   , 'llm.output_tokens', '2026-01-01 00:00:00',  15000000, 'CNY',  10500000, 0.7),   -- ×1     ¥15.00 / ¥10.50
  ('galaxy', 'llm.chat', 'gpt-6-astra'      , 'xhigh'  , 'llm.output_tokens', '2026-01-01 00:00:00',  24000000, 'CNY',  16800000, 0.7),   -- ×1.6   ¥24.00 / ¥16.80
  ('galaxy', 'llm.chat', 'gpt-6-astra'      , 'max'    , 'llm.output_tokens', '2026-01-01 00:00:00',  37500000, 'CNY',  26250000, 0.7),   -- ×2.5   ¥37.50 / ¥26.25
  ('galaxy', 'llm.chat', 'gpt-6-astra'      , 'ultra'  , 'llm.output_tokens', '2026-01-01 00:00:00',  52500000, 'CNY',  36750000, 0.7),   -- ×3.5   ¥52.50 / ¥36.75

  -- ---------- gpt-5.6-sol（6 档）· 基准沿用兜底价 ¥15.00 · 假设阶梯（本机无价档、无系数） ----------
  ('galaxy', 'llm.chat', 'gpt-5.6-sol'      , ''       , 'llm.output_tokens', '2026-01-01 00:00:00',  12750000, 'CNY',   8925000, 0.7),   -- 不分强度＝默认档 medium ¥12.75
  ('galaxy', 'llm.chat', 'gpt-5.6-sol'      , 'low'    , 'llm.output_tokens', '2026-01-01 00:00:00',  10500000, 'CNY',   7350000, 0.7),   -- ×0.7   ¥10.50 / ¥7.35
  ('galaxy', 'llm.chat', 'gpt-5.6-sol'      , 'medium' , 'llm.output_tokens', '2026-01-01 00:00:00',  12750000, 'CNY',   8925000, 0.7),   -- ×0.85  ¥12.75 / ¥8.93
  ('galaxy', 'llm.chat', 'gpt-5.6-sol'      , 'high'   , 'llm.output_tokens', '2026-01-01 00:00:00',  15000000, 'CNY',  10500000, 0.7),   -- ×1     ¥15.00 / ¥10.50
  ('galaxy', 'llm.chat', 'gpt-5.6-sol'      , 'xhigh'  , 'llm.output_tokens', '2026-01-01 00:00:00',  24000000, 'CNY',  16800000, 0.7),   -- ×1.6   ¥24.00 / ¥16.80
  ('galaxy', 'llm.chat', 'gpt-5.6-sol'      , 'max'    , 'llm.output_tokens', '2026-01-01 00:00:00',  37500000, 'CNY',  26250000, 0.7),   -- ×2.5   ¥37.50 / ¥26.25
  ('galaxy', 'llm.chat', 'gpt-5.6-sol'      , 'ultra'  , 'llm.output_tokens', '2026-01-01 00:00:00',  52500000, 'CNY',  36750000, 0.7),   -- ×3.5   ¥52.50 / ¥36.75

  -- ---------- gpt-5.6-terra（6 档）· 基准沿用兜底价 ¥15.00 · 假设阶梯（本机无价档、无系数） ----------
  ('galaxy', 'llm.chat', 'gpt-5.6-terra'    , ''       , 'llm.output_tokens', '2026-01-01 00:00:00',  12750000, 'CNY',   8925000, 0.7),   -- 不分强度＝默认档 medium ¥12.75
  ('galaxy', 'llm.chat', 'gpt-5.6-terra'    , 'low'    , 'llm.output_tokens', '2026-01-01 00:00:00',  10500000, 'CNY',   7350000, 0.7),   -- ×0.7   ¥10.50 / ¥7.35
  ('galaxy', 'llm.chat', 'gpt-5.6-terra'    , 'medium' , 'llm.output_tokens', '2026-01-01 00:00:00',  12750000, 'CNY',   8925000, 0.7),   -- ×0.85  ¥12.75 / ¥8.93
  ('galaxy', 'llm.chat', 'gpt-5.6-terra'    , 'high'   , 'llm.output_tokens', '2026-01-01 00:00:00',  15000000, 'CNY',  10500000, 0.7),   -- ×1     ¥15.00 / ¥10.50
  ('galaxy', 'llm.chat', 'gpt-5.6-terra'    , 'xhigh'  , 'llm.output_tokens', '2026-01-01 00:00:00',  24000000, 'CNY',  16800000, 0.7),   -- ×1.6   ¥24.00 / ¥16.80
  ('galaxy', 'llm.chat', 'gpt-5.6-terra'    , 'max'    , 'llm.output_tokens', '2026-01-01 00:00:00',  37500000, 'CNY',  26250000, 0.7),   -- ×2.5   ¥37.50 / ¥26.25
  ('galaxy', 'llm.chat', 'gpt-5.6-terra'    , 'ultra'  , 'llm.output_tokens', '2026-01-01 00:00:00',  52500000, 'CNY',  36750000, 0.7),   -- ×3.5   ¥52.50 / ¥36.75

  -- ---------- gpt-5.6-luna（5 档）· 基准沿用兜底价 ¥15.00 · 假设阶梯（本机无价档、无系数） ----------
  ('galaxy', 'llm.chat', 'gpt-5.6-luna'     , ''       , 'llm.output_tokens', '2026-01-01 00:00:00',  12750000, 'CNY',   8925000, 0.7),   -- 不分强度＝默认档 medium ¥12.75
  ('galaxy', 'llm.chat', 'gpt-5.6-luna'     , 'low'    , 'llm.output_tokens', '2026-01-01 00:00:00',  10500000, 'CNY',   7350000, 0.7),   -- ×0.7   ¥10.50 / ¥7.35
  ('galaxy', 'llm.chat', 'gpt-5.6-luna'     , 'medium' , 'llm.output_tokens', '2026-01-01 00:00:00',  12750000, 'CNY',   8925000, 0.7),   -- ×0.85  ¥12.75 / ¥8.93
  ('galaxy', 'llm.chat', 'gpt-5.6-luna'     , 'high'   , 'llm.output_tokens', '2026-01-01 00:00:00',  15000000, 'CNY',  10500000, 0.7),   -- ×1     ¥15.00 / ¥10.50
  ('galaxy', 'llm.chat', 'gpt-5.6-luna'     , 'xhigh'  , 'llm.output_tokens', '2026-01-01 00:00:00',  24000000, 'CNY',  16800000, 0.7),   -- ×1.6   ¥24.00 / ¥16.80
  ('galaxy', 'llm.chat', 'gpt-5.6-luna'     , 'max'    , 'llm.output_tokens', '2026-01-01 00:00:00',  37500000, 'CNY',  26250000, 0.7),   -- ×2.5   ¥37.50 / ¥26.25

  -- ---------- gpt-5.5（4 档）· 基准沿用兜底价 ¥15.00 · 假设阶梯（本机无价档、无系数） ----------
  ('galaxy', 'llm.chat', 'gpt-5.5'          , ''       , 'llm.output_tokens', '2026-01-01 00:00:00',  12750000, 'CNY',   8925000, 0.7),   -- 不分强度＝默认档 medium ¥12.75
  ('galaxy', 'llm.chat', 'gpt-5.5'          , 'low'    , 'llm.output_tokens', '2026-01-01 00:00:00',  10500000, 'CNY',   7350000, 0.7),   -- ×0.7   ¥10.50 / ¥7.35
  ('galaxy', 'llm.chat', 'gpt-5.5'          , 'medium' , 'llm.output_tokens', '2026-01-01 00:00:00',  12750000, 'CNY',   8925000, 0.7),   -- ×0.85  ¥12.75 / ¥8.93
  ('galaxy', 'llm.chat', 'gpt-5.5'          , 'high'   , 'llm.output_tokens', '2026-01-01 00:00:00',  15000000, 'CNY',  10500000, 0.7),   -- ×1     ¥15.00 / ¥10.50
  ('galaxy', 'llm.chat', 'gpt-5.5'          , 'xhigh'  , 'llm.output_tokens', '2026-01-01 00:00:00',  24000000, 'CNY',  16800000, 0.7)   -- ×1.6   ¥24.00 / ¥16.80
ON DUPLICATE KEY UPDATE
  `price`          = VALUES(`price`),
  `currency`       = VALUES(`currency`),
  `provider_price` = VALUES(`provider_price`),
  `provider_share` = VALUES(`provider_share`);


-- -------------------------------------------------------------------------
-- 3b. 官方参考价（可选）：模型广场上划掉的那道线 + 「省 X%」
--
-- 上游标价是美元，而 list_* 三列必须和我们自己的价**同币种**（折扣要在同一币种
-- 内算，混着存汇率一动折扣就跟着飘）。汇率是你的商务输入，所以这段默认不跑。
-- 想跑就改 @usd_cny 再执行：
--
-- SET @usd_cny := 7.30;
-- UPDATE `zt_galaxy_model` SET
--   `list_input_price`  = ROUND(@usd_cny * 1000000 * CASE `model_id`
--       WHEN 'claude-sonnet-5' THEN 2 WHEN 'claude-opus-5' THEN 5
--       WHEN 'claude-opus-4-8' THEN 5 WHEN 'claude-fable-5-1' THEN 10 END),
--   `list_output_price` = ROUND(@usd_cny * 1000000 * CASE `model_id`
--       WHEN 'claude-sonnet-5' THEN 10 WHEN 'claude-opus-5' THEN 25
--       WHEN 'claude-opus-4-8' THEN 25 WHEN 'claude-fable-5-1' THEN 50 END),
--   `list_cache_price`  = ROUND(@usd_cny * 1000000 * CASE `model_id`
--       WHEN 'claude-sonnet-5' THEN 0.2 WHEN 'claude-opus-5' THEN 0.5
--       WHEN 'claude-opus-4-8' THEN 0.5 WHEN 'claude-fable-5-1' THEN 0.25 END),
--   `updated_time` = NOW(3)
--  WHERE `biz_line` = 'galaxy'
--    AND `model_id` IN ('claude-sonnet-5','claude-opus-5','claude-opus-4-8','claude-fable-5-1');
--
-- GPT 一族没有可引用的官方标价，留 0 = 不划线（比标一个编的数诚实）。


-- -------------------------------------------------------------------------
-- 4. 跑完自检
-- -------------------------------------------------------------------------

-- 应当是 9
SELECT COUNT(*) AS listed_models
  FROM `zt_galaxy_model` WHERE `biz_line` = 'galaxy' AND `listed` = 1;

-- 每个模型的档数应与第 0 段那张表一致（不含 effort='' 的基准行）
SELECT `model_id`, COUNT(*) AS efforts, GROUP_CONCAT(`effort` ORDER BY `price`) AS levels
  FROM `zt_galaxy_price`
 WHERE `biz_line` = 'galaxy' AND `kind` = 'llm.chat' AND `effort` <> ''
 GROUP BY `model_id` ORDER BY `model_id`;

-- 每个模型都必须有那一行 effort=''，否则模型广场的卡片会掉回 kind 兜底价
SELECT `model_id` FROM `zt_galaxy_model` m
 WHERE m.`biz_line` = 'galaxy' AND m.`listed` = 1
   AND NOT EXISTS (SELECT 1 FROM `zt_galaxy_price` p
                    WHERE p.`biz_line` = 'galaxy' AND p.`kind` = 'llm.chat'
                      AND p.`model_id` = m.`model_id` AND p.`effort` = ''
                      AND p.`unit` = 'llm.output_tokens');

-- 档位名**按族**核对：并集清单查不出跨族填错（给 claude 铺 ultra 之类），
-- 而那种行不会报错，只会永远匹配不上任何一次请求。应当一行都查不出来。
SELECT `model_id`, `effort` FROM `zt_galaxy_price`
 WHERE `biz_line` = 'galaxy' AND `effort` <> ''
   AND ( (`model_id` LIKE 'claude%' AND `effort` NOT IN ('low','medium','high','xhigh','max'))
      OR (`model_id` LIKE 'gpt%'    AND `effort` NOT IN ('none','minimal','low','medium','high','xhigh','max','ultra')) );

-- 兜底行还在不在（这份文件只铺 output，其余单位全靠它）。应当有 input / cache_read /
-- cache_write_5m / cache_write_1h 四行；缺哪个，那个单位就在静默按 0 计费。
SELECT `unit`, `price` FROM `zt_galaxy_price`
 WHERE `biz_line` = 'galaxy' AND `kind` = 'llm.chat' AND `model_id` = '' AND `effort` = ''
 ORDER BY `unit`;
