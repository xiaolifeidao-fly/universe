-- =========================================================================
-- 模型商品定价：官方参考价（划线价）+ 对外单价 + 分组价
--
-- 2026-09-22。对标了两家同类中转站的公开价目，按**统一低约 6%** 定我们自己的价。
--
-- 这份文件铺三样东西，互不相干、可以分开跑：
--   1. zt_galaxy_model 的 list_input_price / list_output_price / list_cache_price
--      —— **只是展示**，门户拿它划线算「省 X%」，不参与一分钱的账。
--   2. zt_galaxy_price 的**模型通价**（group_id = ''）
--   3. zt_galaxy_price 的**分组价**（group_id = mg_…），当前每个模型各一个「标准」分组
--
-- 量纲：整数**微元**，÷1_000_000 得「元」；price 是**每百万 token** 的价。
-- 计费 cost = amount × price ÷ 1_000_000（billing.go 的 priceScale），逐笔向下取整。
--
-- 取价是三级回落，**按单位分别回落**（billing.go resolvePrices）：
--      0  (model='', group='')  该 kind 的兜底价 —— 界面上标「统一价」
--      1  (model=M,  group='')  这个模型的通价
--      2  (model=M,  group=G)   这个分组自己的价，最细，最后落下
-- 所以第 2、3 段的数**是一样的**：分组价是真正会被收的那一份；模型通价是没带分组的
-- 老密钥、以及将来新建但还没定价的分组的落点。两边同价 = 不管走哪条路都收同样的钱。
--
-- ⚠️ 跑之前务必读的三件事
--   a) **这是涨价，而且幅度不小。** 现在库里 Claude 全族走的是 ¥3.00 入 / ¥15.00 出
--      的兜底价（claude-opus-5 的出价恰好也是 15，所以界面上看不出来）。按这份文件：
--        claude-opus-5    出 ¥15.00 → ¥39.95（2.66×）
--        claude-fable-5-1 出 ¥30.00 → ¥79.90（2.66×）
--        claude-sonnet-5  出 ¥6.00  → ¥15.95（2.66×）
--      反方向也有：haiku 与 gpt-5.6 一族是**降价**（见下表）。
--      余额是按笔扣的，涨价当天起，老用户的余额会明显烧得更快。
--   b) **缓存写入现在是免费的。** 库里 zt_galaxy_price 一条 llm.cache_write_5m_tokens /
--      llm.cache_write_1h_tokens 都没有，而缺价的单位是**静默按 0 计费**，不报错。
--      Claude Code 的流量里缓存写入占比不低，这是个实打实的窟窿。第 2、3 段把这两桶
--      补齐了；第 4 段顺带补上兜底价（可选）。
--   c) gpt-5.6-terra / gpt-5.6-luna 两家都没挂出来，这里**按 gpt-5.6-sol 同档处理**。
--      不对的话只改第 2 段那两行。
--
-- 为什么是 INSERT ... ON DUPLICATE KEY UPDATE，而不是纯 UPDATE
--
-- **分组本身一行都不动。** zt_galaxy_model_group 里那 10 行（每个模型一个「标准」、
-- 都是默认分组）在这份文件里只被 JOIN，没有任何写入。价格不是分组行上的字段 ——
-- 它在 zt_galaxy_price，按 (kind, 模型, 分组, 计量单位, 生效时刻) 一行一条。
--
-- 这次要铺 10 模型 × 5 单位 × 两层（模型通价 / 分组价）= 100 个格子，库里的现状是：
--     模型通价 · llm.output_tokens     9 格  有行 → UPDATE
--     模型通价 · 其余 4 个单位         41 格  没有行 → 只能 INSERT
--     分组价 · 全部 5 个单位           50 格  没有行 → 只能 INSERT
-- （claude-haiku-4-5-20251001 连 output 的模型通价都没有。）
-- 只写 UPDATE 的话，那 91 格会「执行成功、0 行受影响、价格照旧不全」——
-- 而缺价的单位是静默按 0 计费，不报错。
--
-- ON DUPLICATE KEY UPDATE 命中 uk_gx_price 就更新、没命中才补一条，
-- 正好是「有的更新、缺的补齐」，重复执行也安全。
--
-- 幂等，重复执行安全。
-- =========================================================================

-- effective_from 是 TIMESTAMP 且在唯一键里：字面量按会话时区折成 UTC 存，换个时区
-- 重跑同一串字面量会落在另一个瞬间，于是不走 ON DUPLICATE KEY 而是再插一整套行。钉死它。
SET time_zone = '+08:00';

-- 新价挂在哪个生效时刻上。默认 '2026-01-01 00:00:00' —— **和库里现有行同一个时刻**，
-- 于是 ON DUPLICATE KEY UPDATE 真的是「就地改写」：已经有的那 9 行被更新，不会多出
-- 第二条同单位的价。代价是历史重算（争议追回、对账）会按新价算。
--   · 想**留历史**（老价照旧算到今天为止）：改成 '2026-09-22 00:00:00' 这类新时刻，
--     两条并存，取价按 effective_from 最新的那条（billing.go resolvePrices）。
--   · 想**预约涨价**：填一个将来的时刻，到点自动切换。
SET @effective := '2026-01-01 00:00:00';

-- 结算给共享者的比例。两个价各乘各的：调下游价不该自动改掉所有共享者的收入
-- （billing.go splitCost）。下面所有 provider_price 都由它乘出来，改这一个数就够。
SET @provider_rate := 0.70;


-- -------------------------------------------------------------------------
-- 0) 前置盘点：只读，先单独跑这一段，三条都对得上再往下
-- -------------------------------------------------------------------------

-- 0a) zt_galaxy_price 必须有 group_id，且 uk_gx_price 必须含它。
--     没有的话第 3 段那批分组行会在旧唯一键上互相覆盖成每个模型一行，
--     静默按最后一行的价收钱。缺就先跑 migrations/20260922_galaxy_model_group.sql。
SELECT
  SUM(`column_name` = 'group_id') AS `price_有group_id列`,
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_price'
      AND index_name = 'uk_gx_price' AND column_name = 'group_id') AS `唯一键含group_id`
FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_price';

-- 0b) zt_galaxy_model 必须有 list_cache_price（第 1 段要写它）。
--     缺就先跑 migrations/20260920_galaxy_model_list_cache_price.sql。
--     注意 server/galaxy.sql 里**没有**这一列，新建库只跑建表脚本是补不上的。
SELECT COUNT(*) AS `model_有list_cache_price列`
  FROM information_schema.columns
 WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_model'
   AND column_name = 'list_cache_price';

-- 0c) 这份文件认的 10 个模型、10 个分组，和库里对不对得上。
--     少了谁 = 那个模型这次没定到价（第 5 段的自检会再报一次）。
SELECT m.`model_id`, m.`listed` AS `已上架`, g.`group_id`, g.`name` AS `分组名`, g.`is_default` AS `默认`
  FROM `zt_galaxy_model` m
  LEFT JOIN `zt_galaxy_model_group` g
    ON g.`biz_line` = m.`biz_line` AND g.`model_id` = m.`model_id`
 WHERE m.`biz_line` = 'galaxy'
 ORDER BY m.`sort_order`, m.`model_id`, g.`sort_order`;

-- 0d) 100 个格子里，哪些有行可更新、哪些根本没有行。
--     跑之前：`分组价有行吗` 应当全是 0，`模型通价有行吗` 只有 output 那 9 格是 1。
--     跑之后：两列应当全是 1。
SELECT g.`model_id`, u.`unit`,
       COALESCE(MAX(p.`group_id` = ''), 0)  AS `模型通价有行吗`,
       COALESCE(MAX(p.`group_id` <> ''), 0) AS `分组价有行吗`
  FROM `zt_galaxy_model_group` g
  JOIN `zt_galaxy_model` m
    ON m.`biz_line` = g.`biz_line` AND m.`model_id` = g.`model_id`
 CROSS JOIN (SELECT 'llm.input_tokens' AS unit
      UNION ALL SELECT 'llm.output_tokens'
      UNION ALL SELECT 'llm.cache_read_tokens'
      UNION ALL SELECT 'llm.cache_write_5m_tokens'
      UNION ALL SELECT 'llm.cache_write_1h_tokens') u
  LEFT JOIN `zt_galaxy_price` p
    ON p.`biz_line` = 'galaxy' AND p.`kind` = m.`kind`
   AND p.`model_id` = g.`model_id` AND p.`unit` = u.`unit`
   AND p.`group_id` IN ('', g.`group_id`)
 WHERE g.`biz_line` = 'galaxy'
 GROUP BY g.`model_id`, u.`unit`
 ORDER BY g.`model_id`, u.`unit`;


-- -------------------------------------------------------------------------
-- 1) 官方参考价（划线价）
--
-- 口径：上游官网当期美元价 × 6.6954（两家挂出来的「官方价」用的就是这个折算率，
-- 照抄过来我们和他们的划线价才可比）。汇率变了就改这一个乘数重算。
--   list_cache_price 填的是**缓存读取**的官方价（= 输入价 ÷ 10），
--   缓存写入没有对应的展示列 —— 卡片上只有入 / 出 / 缓存三格。
--
-- 只影响展示。这几个数必须是运营自己核过上游官网的事实：由代码从输入价推一个
-- 「通常是十分之一」写上去，性质上就是价格欺诈。
-- -------------------------------------------------------------------------

UPDATE `zt_galaxy_model` m
  JOIN (
    --                model_id                    | 入(USD)  | 出(USD)   | 官方入      官方出       官方缓存读
    SELECT 'claude-opus-5'             AS model_id,  33477000 AS li, 167385000 AS lo,  3347700 AS lc  -- $5 / $25
    UNION ALL SELECT 'claude-opus-4-8',             33477000,       167385000,        3347700        -- $5 / $25
    UNION ALL SELECT 'claude-sonnet-5',             13390800,        66954000,        1339080        -- $2 / $10
    UNION ALL SELECT 'claude-fable-5-1',            66954000,       334770000,        6695400        -- $10 / $50
    UNION ALL SELECT 'claude-haiku-4-5-20251001',    6695400,        33477000,         669540        -- $1 / $5
    UNION ALL SELECT 'gpt-6-astra',                 66954000,       334770000,        6695400        -- $10 / $50
    UNION ALL SELECT 'gpt-5.6-sol',                 33477000,       200862000,        3347700        -- $5 / $30
    UNION ALL SELECT 'gpt-5.6-terra',               33477000,       200862000,        3347700        -- 按 sol 同档
    UNION ALL SELECT 'gpt-5.6-luna',                33477000,       200862000,        3347700        -- 按 sol 同档
    UNION ALL SELECT 'gpt-5.5',                     33477000,       200862000,        3347700        -- $5 / $30
  ) p ON p.model_id = m.`model_id`
   SET m.`list_input_price`  = p.li,
       m.`list_output_price` = p.lo,
       m.`list_cache_price`  = p.lc,
       m.`updated_time`      = NOW(3)
 WHERE m.`biz_line` = 'galaxy';


-- -------------------------------------------------------------------------
-- 2) 对外单价：一张临时表装全部 10 个模型 × 5 个计价单位
--
-- ⚠️ 临时表只在**同一个连接**里存在。整份脚本要一次跑完，别分几个窗口跑。
--
-- 定价规则：对手价 × 0.94（约低 6%），入价取到分，其余三档按官方倍率从入价推出来 ——
--   出 = 入 × 5（Claude 全族、gpt-6-astra）或 × 6（gpt-5.6 一族、gpt-5.5）
--   缓存读 = 入 × 0.1
--   缓存写 5m = 入 × 1.25    缓存写 1h = 入 × 2（Anthropic 的两档 TTL 差 1.6 倍）
-- OpenAI 一族没有 1h 缓存的概念，整笔落在 5m 桶上（contract.UnitCacheWrite5mTokens），
-- 所以那几个模型的 1h 价写成和 5m 一样：这一桶正常永远是空的，真收到量也不该更贵。
--
-- 只有这五个单位计价。llm.cache_write_tokens（5m+1h 的合计）、llm.reasoning_tokens
-- （output 的子集）、llm.total_tokens（四桶合计）都**只进额度与统计，不进账本**，
-- 由 billing.go 的 derivedUnits 拦着 —— 千万别给它们定价，定了也是白定。
-- -------------------------------------------------------------------------

DROP TEMPORARY TABLE IF EXISTS `tmp_gx_model_price`;
CREATE TEMPORARY TABLE `tmp_gx_model_price` (
  `model_id` varchar(96)  NOT NULL,
  `unit`     varchar(48)  NOT NULL,
  `price`    bigint       NOT NULL,
  PRIMARY KEY (`model_id`, `unit`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `tmp_gx_model_price` (`model_id`, `unit`, `price`) VALUES
  -- ---------- Claude Opus 5：对手 ¥8.50 / ¥42.50 / ¥0.85 / ¥10.625 ----------
  ('claude-opus-5',             'llm.input_tokens',           7990000),   -- ¥7.99    官方 ¥33.4770，省 76.1%
  ('claude-opus-5',             'llm.output_tokens',         39950000),   -- ¥39.95   （原 ¥15.00 → 2.66×）
  ('claude-opus-5',             'llm.cache_read_tokens',       799000),   -- ¥0.799
  ('claude-opus-5',             'llm.cache_write_5m_tokens',  9987500),   -- ¥9.9875  入 ×1.25
  ('claude-opus-5',             'llm.cache_write_1h_tokens', 15980000),   -- ¥15.98   入 ×2
  -- ---------- Claude Opus 4.8：同 Opus 5 ----------
  ('claude-opus-4-8',           'llm.input_tokens',           7990000),
  ('claude-opus-4-8',           'llm.output_tokens',         39950000),
  ('claude-opus-4-8',           'llm.cache_read_tokens',       799000),
  ('claude-opus-4-8',           'llm.cache_write_5m_tokens',  9987500),
  ('claude-opus-4-8',           'llm.cache_write_1h_tokens', 15980000),
  -- ---------- Claude Sonnet 5：对手 ¥3.40 / ¥17.00 / ¥0.34 / ¥4.25 ----------
  ('claude-sonnet-5',           'llm.input_tokens',           3190000),   -- ¥3.19    官方 ¥13.3908，省 76.2%
  ('claude-sonnet-5',           'llm.output_tokens',         15950000),   -- ¥15.95   （原 ¥6.00 → 2.66×）
  ('claude-sonnet-5',           'llm.cache_read_tokens',       319000),   -- ¥0.319
  ('claude-sonnet-5',           'llm.cache_write_5m_tokens',  3987500),   -- ¥3.9875
  ('claude-sonnet-5',           'llm.cache_write_1h_tokens',  6380000),   -- ¥6.38
  -- ---------- Claude Fable 5.1：对手 ¥17.00 / ¥85.00 / ¥1.70 / ¥21.25 ----------
  ('claude-fable-5-1',          'llm.input_tokens',          15980000),   -- ¥15.98   官方 ¥66.9540，省 76.1%
  ('claude-fable-5-1',          'llm.output_tokens',         79900000),   -- ¥79.90   （原 ¥30.00 → 2.66×）
  ('claude-fable-5-1',          'llm.cache_read_tokens',      1598000),   -- ¥1.598
  ('claude-fable-5-1',          'llm.cache_write_5m_tokens', 19975000),   -- ¥19.975
  ('claude-fable-5-1',          'llm.cache_write_1h_tokens', 31960000),   -- ¥31.96
  -- ---------- Claude Haiku 4.5：对手 ¥1.70 / ¥8.50 / ¥0.17 / ¥2.125（这一档是降价） ----------
  ('claude-haiku-4-5-20251001', 'llm.input_tokens',           1590000),   -- ¥1.59    原 ¥3.00 → 降 47%
  ('claude-haiku-4-5-20251001', 'llm.output_tokens',          7950000),   -- ¥7.95    原 ¥15.00 → 降 47%
  ('claude-haiku-4-5-20251001', 'llm.cache_read_tokens',       159000),   -- ¥0.159
  ('claude-haiku-4-5-20251001', 'llm.cache_write_5m_tokens',  1987500),   -- ¥1.9875
  ('claude-haiku-4-5-20251001', 'llm.cache_write_1h_tokens',  3180000),   -- ¥3.18
  -- ---------- GPT-6 Astra：对手 ¥3.90 / ¥19.50 / ¥0.39 / ¥4.875 ----------
  ('gpt-6-astra',               'llm.input_tokens',           3660000),   -- ¥3.66    官方 ¥66.9540，省 94.5%
  ('gpt-6-astra',               'llm.output_tokens',         18300000),   -- ¥18.30   （原 ¥12.75）
  ('gpt-6-astra',               'llm.cache_read_tokens',       366000),   -- ¥0.366
  ('gpt-6-astra',               'llm.cache_write_5m_tokens',  4575000),   -- ¥4.575
  ('gpt-6-astra',               'llm.cache_write_1h_tokens',  4575000),   -- OpenAI 无 1h 档，同 5m
  -- ---------- GPT-5.6 Sol：对手 ¥1.95 / ¥11.70 / ¥0.195 / ¥2.4375（这一档是降价） ----------
  ('gpt-5.6-sol',               'llm.input_tokens',           1830000),   -- ¥1.83    原 ¥3.00 → 降 39%
  ('gpt-5.6-sol',               'llm.output_tokens',         10980000),   -- ¥10.98   原 ¥12.75 → 降 14%
  ('gpt-5.6-sol',               'llm.cache_read_tokens',       183000),   -- ¥0.183
  ('gpt-5.6-sol',               'llm.cache_write_5m_tokens',  2287500),   -- ¥2.2875
  ('gpt-5.6-sol',               'llm.cache_write_1h_tokens',  2287500),
  -- ---------- GPT-5.6 Terra：两家都没挂，按 Sol 同档 ----------
  ('gpt-5.6-terra',             'llm.input_tokens',           1830000),
  ('gpt-5.6-terra',             'llm.output_tokens',         10980000),
  ('gpt-5.6-terra',             'llm.cache_read_tokens',       183000),
  ('gpt-5.6-terra',             'llm.cache_write_5m_tokens',  2287500),
  ('gpt-5.6-terra',             'llm.cache_write_1h_tokens',  2287500),
  -- ---------- GPT-5.6 Luna：两家都没挂，按 Sol 同档 ----------
  ('gpt-5.6-luna',              'llm.input_tokens',           1830000),
  ('gpt-5.6-luna',              'llm.output_tokens',         10980000),
  ('gpt-5.6-luna',              'llm.cache_read_tokens',       183000),
  ('gpt-5.6-luna',              'llm.cache_write_5m_tokens',  2287500),
  ('gpt-5.6-luna',              'llm.cache_write_1h_tokens',  2287500),
  -- ---------- GPT-5.5：对手 ¥1.95 / ¥11.70 / ¥0.195（缓存写他家没挂，按 ×1.25 补） ----------
  ('gpt-5.5',                   'llm.input_tokens',           1830000),
  ('gpt-5.5',                   'llm.output_tokens',         10980000),
  ('gpt-5.5',                   'llm.cache_read_tokens',       183000),
  ('gpt-5.5',                   'llm.cache_write_5m_tokens',  2287500),
  ('gpt-5.5',                   'llm.cache_write_1h_tokens',  2287500);


-- 2b) 模型通价（group_id = ''）。
--     没带分组的老密钥、以及将来新建但还没单独定价的分组，都落在这一层。
--     JOIN zt_galaxy_model：库里没有的模型不会被凭空造出一条价。
INSERT INTO `zt_galaxy_price`
  (`biz_line`, `kind`, `model_id`, `group_id`, `unit`, `effective_from`,
   `price`, `currency`, `provider_price`, `provider_share`)
SELECT 'galaxy', m.`kind`, p.`model_id`, '', p.`unit`, @effective,
       p.`price`, 'CNY', ROUND(p.`price` * @provider_rate), @provider_rate
  FROM `tmp_gx_model_price` p
  JOIN `zt_galaxy_model` m
    ON m.`biz_line` = 'galaxy' AND m.`model_id` = p.`model_id`
ON DUPLICATE KEY UPDATE
  `price`          = VALUES(`price`),
  `currency`       = VALUES(`currency`),
  `provider_price` = VALUES(`provider_price`),
  `provider_share` = VALUES(`provider_share`);


-- -------------------------------------------------------------------------
-- 3) 分组价（group_id = mg_…）——「这个分组自己定过价」，取价时最后落下的那一层
--
-- 不写死 group_id，而是 JOIN 分组表：跑的那一刻这些模型下面**有几个分组就铺几个**。
-- 现在是各一个「标准」（都是默认分组）：
--     claude-opus-5             mg_2C600C50C461CAAB7FAADD9E   ["high"]
--     claude-opus-4-8           mg_C57ACFBF29B80E310F801143   ["high"]
--     claude-sonnet-5           mg_C3E1F938D95D32F424C5A779   ["high"]
--     claude-fable-5-1          mg_9703E51FED66C4F353F4B02A   ["high"]
--     claude-haiku-4-5-2025…    mg_615E0915D6535618A9458B6F   []      允许快速
--     gpt-6-astra               mg_006FC5C24B165798F1AF83E5   ["medium","high"]
--     gpt-5.6-sol               mg_B50E2E34E522091FA7841BA4   ["medium","high"]
--     gpt-5.6-terra             mg_D10F9E0A2E850A8A21BB355F   ["medium","high"]
--     gpt-5.6-luna              mg_475F389DA4B3EF461A1B055F   ["medium","high"]
--     gpt-5.5                   mg_843247295EF455AE88AB5FD6   ["medium","high"]
--
-- 将来要按深浅卖出差价（「轻量」便宜、「极深」贵），就在分组表里建好分组，
-- 把这一段的 p.price 换成「按分组乘一个系数」再重跑 —— 模型通价不用动。
-- -------------------------------------------------------------------------

INSERT INTO `zt_galaxy_price`
  (`biz_line`, `kind`, `model_id`, `group_id`, `unit`, `effective_from`,
   `price`, `currency`, `provider_price`, `provider_share`)
SELECT 'galaxy', m.`kind`, g.`model_id`, g.`group_id`, p.`unit`, @effective,
       p.`price`, 'CNY', ROUND(p.`price` * @provider_rate), @provider_rate
  FROM `zt_galaxy_model_group` g
  JOIN `zt_galaxy_model` m
    ON m.`biz_line` = g.`biz_line` AND m.`model_id` = g.`model_id`
  JOIN `tmp_gx_model_price` p
    ON p.`model_id` = g.`model_id`
 WHERE g.`biz_line` = 'galaxy'
ON DUPLICATE KEY UPDATE
  `price`          = VALUES(`price`),
  `currency`       = VALUES(`currency`),
  `provider_price` = VALUES(`provider_price`),
  `provider_share` = VALUES(`provider_share`);


-- -------------------------------------------------------------------------
-- 4) 兜底价补上缓存写入两桶（可选，但建议跑）
--
-- 不跑的后果：不在模型目录里的模型名，缓存写入继续按 0 收。上面第 2、3 段已经把
-- 这 10 个模型盖住了，所以这一段只是把「兜底」这条路也堵上。
-- 数取的是兜底入价 ¥3.00 的 1.25 倍与 2 倍，和 galaxy_seed.sql 的口径一致。
-- -------------------------------------------------------------------------

INSERT INTO `zt_galaxy_price`
  (`biz_line`, `kind`, `model_id`, `group_id`, `unit`, `effective_from`,
   `price`, `currency`, `provider_price`, `provider_share`)
VALUES
  ('galaxy', 'llm.chat', '', '', 'llm.cache_write_5m_tokens', @effective, 3750000, 'CNY', 2625000, 0.7),
  ('galaxy', 'llm.chat', '', '', 'llm.cache_write_1h_tokens', @effective, 6000000, 'CNY', 4200000, 0.7)
ON DUPLICATE KEY UPDATE
  `price`          = VALUES(`price`),
  `currency`       = VALUES(`currency`),
  `provider_price` = VALUES(`provider_price`),
  `provider_share` = VALUES(`provider_share`);

-- 顺带：delivery.task 的 llm.cache_read_tokens 那一行 provider_price 是 0
-- （回落到 provider_share 的老口径）。补齐，和 llm.chat 一致。
UPDATE `zt_galaxy_price`
   SET `provider_price` = ROUND(`price` * @provider_rate)
 WHERE `biz_line` = 'galaxy' AND `provider_price` = 0 AND `price` > 0;


-- -------------------------------------------------------------------------
-- 5) 自检
-- -------------------------------------------------------------------------

-- 5a) 每个模型 × 每个单位，此刻生效的价落在哪一层。
--     期望：10 个模型 × 5 个单位 = 50 行「分组价」，每行都有对应的「模型通价」。
--     还看到「统一价（兜底）」= 那一格没铺到。
SELECT m.`model_id`, p.`unit`,
       MAX(CASE WHEN p.`group_id` = '' THEN p.`price` END) / 1000000 AS `模型通价`,
       MAX(CASE WHEN p.`group_id` <> '' THEN p.`price` END) / 1000000 AS `分组价`,
       MAX(CASE WHEN p.`group_id` <> '' THEN p.`provider_price` END) / 1000000 AS `结算价`
  FROM `zt_galaxy_model` m
  JOIN `zt_galaxy_price` p
    ON p.`biz_line` = m.`biz_line` AND p.`model_id` = m.`model_id` AND p.`kind` = m.`kind`
 WHERE m.`biz_line` = 'galaxy' AND p.`effective_from` <= NOW()
 GROUP BY m.`model_id`, p.`unit`
 ORDER BY m.`model_id`, p.`unit`;

-- 5b) 哪些 (模型, 单位) 还没定到价 —— 这些格子会**静默按 0 计费**。
--     期望：0 行。
SELECT m.`model_id`, u.`unit`
  FROM `zt_galaxy_model` m
 CROSS JOIN (
    SELECT 'llm.input_tokens' AS unit
    UNION ALL SELECT 'llm.output_tokens'
    UNION ALL SELECT 'llm.cache_read_tokens'
    UNION ALL SELECT 'llm.cache_write_5m_tokens'
    UNION ALL SELECT 'llm.cache_write_1h_tokens') u
 WHERE m.`biz_line` = 'galaxy'
   AND NOT EXISTS (
     SELECT 1 FROM `zt_galaxy_price` p
      WHERE p.`biz_line` = 'galaxy' AND p.`kind` = m.`kind`
        AND p.`model_id` = m.`model_id` AND p.`group_id` = ''
        AND p.`unit` = u.`unit` AND p.`effective_from` <= NOW())
 ORDER BY m.`model_id`, u.`unit`;

-- 5c) 有分组却没分组价的 —— 它们会回落到模型通价（不算错，只是没卖出差价）。
--     期望：0 行。
SELECT g.`model_id`, g.`group_id`, g.`name`
  FROM `zt_galaxy_model_group` g
 WHERE g.`biz_line` = 'galaxy'
   AND NOT EXISTS (
     SELECT 1 FROM `zt_galaxy_price` p
      WHERE p.`biz_line` = 'galaxy' AND p.`model_id` = g.`model_id`
        AND p.`group_id` = g.`group_id` AND p.`effective_from` <= NOW())
 ORDER BY g.`model_id`;

-- 5d) 划线价自检：对外价必须低于官方参考价，且「省 X%」算得出来。
SELECT m.`model_id`,
       m.`list_input_price`  / 1000000 AS `官方入`,
       p_in.`price`          / 1000000 AS `我们入`,
       ROUND(100 - p_in.`price` * 100 / m.`list_input_price`, 1)  AS `入省%`,
       m.`list_output_price` / 1000000 AS `官方出`,
       p_out.`price`         / 1000000 AS `我们出`,
       ROUND(100 - p_out.`price` * 100 / m.`list_output_price`, 1) AS `出省%`
  FROM `zt_galaxy_model` m
  LEFT JOIN `zt_galaxy_price` p_in
    ON p_in.`biz_line` = 'galaxy' AND p_in.`kind` = m.`kind` AND p_in.`model_id` = m.`model_id`
   AND p_in.`group_id` = '' AND p_in.`unit` = 'llm.input_tokens' AND p_in.`effective_from` = @effective
  LEFT JOIN `zt_galaxy_price` p_out
    ON p_out.`biz_line` = 'galaxy' AND p_out.`kind` = m.`kind` AND p_out.`model_id` = m.`model_id`
   AND p_out.`group_id` = '' AND p_out.`unit` = 'llm.output_tokens' AND p_out.`effective_from` = @effective
 WHERE m.`biz_line` = 'galaxy'
 ORDER BY m.`sort_order`, m.`model_id`;

DROP TEMPORARY TABLE IF EXISTS `tmp_gx_model_price`;
