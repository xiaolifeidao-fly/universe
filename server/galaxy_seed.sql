-- =========================================================================
-- galaxy 内测种子数据：定价 + 门户模型目录。
--
-- 这份文件对应 galaxyinit 里除建表以外的那一半。已经跑过 galaxyinit 的库不用再跑；
-- 只跑了 server/galaxy.sql（建表）的库需要跑它，否则定价表是空的
-- → 请求只计量不计费（billing.go 找不到价直接跳过入账），也就是谁调都不扣钱。
--
-- 没有额度包，也没有支付渠道：使用端不卖任何东西。额度就是账户里的积分余额，
-- 由运营在管理端充进来（zt_galaxy_points_account / _ledger），调模型时按单价逐笔扣。
--
-- 金额与单价的量纲：整数微元，除以 1_000_000 得到「元」。
--   amount = 9_900_000  → ¥9.90
--   price  = 3_000_000  → ¥3.00 / 每百万单位
-- 计费口径是 cost = amount × price ÷ 1_000_000（billing.go 的 priceScale），
-- 算出来的这笔钱直接从使用者的积分余额里扣（1 积分 = ¥1，同一量纲）。
--
-- 全部写成 upsert，重复执行安全。
-- 库：galaxy-api 的 application.properties 里 sqlconn 指向的那个
-- =========================================================================


-- -------------------------------------------------------------------------
-- 1. 定价（决策 D-02 / D-03）
--
-- input 与 output 分开定价，缓存读取按 input 打折。calls 与 time.seconds
-- 刻意不定价：它们只作供给侧的额度维度与统计口径，计了费就等于对同一件事收两遍。
--
-- effective_from 必须是过去的时刻：取价是 `effective_from <= now` 里最新的那条。
-- 调价不要 UPDATE 这几行，而是插一条 effective_from 更晚的新行 —— 历史账单
-- 要能按当时的价重算，改掉旧行就重算不出来了。
--
-- 一行两个价：price 向使用者收，provider_price 结给共享者，差额是平台毛利。
-- **两个数各填各的**，provider_price 不是 price 的一个百分比 —— 下面的默认值
-- 恰好取了七成，但调其中一个不会自动改另一个。provider_share 是老口径，
-- 只在 provider_price = 0 时兜底，新装的库一开始就不该走到它。
--
-- 缓存写入要给**两个 TTL 桶**定价，不是给合计定价：llm.cache_write_tokens 是
-- 5m 与 1h 的合计，billing 的 derivedUnits 把它挡在账本外，给合计填价一分钱
-- 都收不到（而界面上看着像已经定过了）。真正进账本的是下面那两个分项，
-- 倍率按上游通行的：5 分钟 = 输入价 × 1.25，1 小时 = 输入价 × 2。
--
-- delivery.task 只计量 input / output（回合在节点本机跑，Hub 解析不了缓存桶），
-- 所以缓存那几档在那个 kind 下不铺 —— 填了也永远没有量。
-- -------------------------------------------------------------------------

-- model_id 一律留空 = 该 kind 的**兜底价**。默认值不替运营决定「哪个模型贵」，
-- 但每个单位都得有一行兜得住：查不到价是静默算 0，不是报错。
-- 要给某个模型单独定价，在管理端价目表上加一行、把模型选上即可。
INSERT INTO `zt_galaxy_price`
  (`biz_line`, `kind`, `model_id`, `unit`, `effective_from`, `price`, `currency`, `provider_price`, `provider_share`)
VALUES
  -- 中转站：按 token 计价
  ('galaxy', 'llm.chat',          '', 'llm.input_tokens',       '2026-01-01 00:00:00',  3000000, 'CNY',  2100000, 0.7),
  ('galaxy', 'llm.chat',          '', 'llm.output_tokens',      '2026-01-01 00:00:00', 15000000, 'CNY', 10500000, 0.7),
  ('galaxy', 'llm.chat',          '', 'llm.cache_read_tokens',  '2026-01-01 00:00:00',   300000, 'CNY',   210000, 0.7),
  ('galaxy', 'llm.chat',          '', 'llm.cache_write_5m_tokens', '2026-01-01 00:00:00',  3750000, 'CNY',  2625000, 0.7),
  ('galaxy', 'llm.chat',          '', 'llm.cache_write_1h_tokens', '2026-01-01 00:00:00',  6000000, 'CNY',  4200000, 0.7),

  -- 任务宇宙：一个回合背后就是若干次 LLM 调用，换个计价单位只会让同一件事
  -- 在两张账单上对不上，所以和 llm.chat 同价。
  ('galaxy', 'delivery.task',     '', 'llm.input_tokens',       '2026-01-01 00:00:00',  3000000, 'CNY',  2100000, 0.7),
  ('galaxy', 'delivery.task',     '', 'llm.output_tokens',      '2026-01-01 00:00:00', 15000000, 'CNY', 10500000, 0.7),

  -- 视频渲染：按输出时长与算力秒计价（O-01 口径）
  ('galaxy', 'video.edit.render', '', 'video.output_seconds',   '2026-01-01 00:00:00', 20000000, 'CNY', 14000000, 0.7),
  ('galaxy', 'video.edit.render', '', 'cpu.seconds',            '2026-01-01 00:00:00',  2000000, 'CNY',  1400000, 0.7)
ON DUPLICATE KEY UPDATE
  `price`          = VALUES(`price`),
  `currency`       = VALUES(`currency`),
  `provider_price` = VALUES(`provider_price`),
  `provider_share` = VALUES(`provider_share`);


-- -------------------------------------------------------------------------
-- 门户模型目录（zt_galaxy_model）
--
-- 这张表只管**门户上怎么把这个模型讲清楚**，不参与计价也不参与派单：
--   · 客户端能填哪些模型名 → galaxy.models（relay 的 /v1/models 读它）
--   · 一次请求扣多少钱     → zt_galaxy_price，按「能力 × 模型 × 计量单位」
--
-- 单价**不在这张表里**。它曾经有过四列展示价，于是同一个模型的价在库里有两份、
-- 谁也不校验谁：门户照这份标、账上照计价表扣，对不上时两边都不报错，
-- 而访问者看到的是一个他付不到的价。按模型计价落地之后那四列就删了
-- （migrations/20260920_galaxy_model_drop_display_price.sql），
-- 门户上标的数直接来自计价表。
--
-- 留下的 list_input_price / list_output_price 是**官方参考价**（别人家的价，
-- 用来划线和算「省 X%」），和我们自己的单价是两回事，所以还在。
--
-- context_tokens 是**默认值，上线前请按上游实际能力核对**：Claude 一族按公开
-- 的 200K 上下文填；其余留 0（未声明），门户上那一行就不显示。
-- -------------------------------------------------------------------------

INSERT INTO `zt_galaxy_model`
  (`biz_line`, `model_id`, `display_name`, `vendor`, `family`, `kind`,
   `context_tokens`, `max_output_tokens`,
   `currency`, `tags_json`, `summary`, `listed`, `featured`, `sort_order`,
   `created_time`, `updated_time`)
VALUES
  ('galaxy', 'claude-opus-5', 'Claude Opus 5', 'anthropic', 'claude', 'llm.chat',
   200000, 0, 'CNY', '["复杂推理","长代码库","Agent"]',
   'Anthropic 目前最强的一档，交给它的是那种想清楚比写得快更重要的活。',
   1, 1, 10, NOW(3), NOW(3)),

  ('galaxy', 'claude-sonnet-5', 'Claude Sonnet 5', 'anthropic', 'claude', 'llm.chat',
   200000, 0, 'CNY', '["日常编码","速度均衡","Claude Code"]',
   '日常写代码的默认选择，快、稳、便宜，Claude Code 里跑得最多的就是它。',
   1, 1, 20, NOW(3), NOW(3)),

  ('galaxy', 'claude-fable-5-1', 'Claude Fable 5.1', 'anthropic', 'claude', 'llm.chat',
   200000, 0, 'CNY', '["长文本","写作"]',
   '偏长文本与写作的一档。',
   1, 0, 30, NOW(3), NOW(3)),

  ('galaxy', 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 'anthropic', 'claude', 'llm.chat',
   200000, 0, 'CNY', '["低延迟","批量","便宜"]',
   '最轻的一档，适合分类、抽取、批量跑这类量大而单次简单的活。',
   1, 0, 40, NOW(3), NOW(3)),

  ('galaxy', 'gpt-5.6-terra', 'GPT-5.6 Terra', 'openai', 'gpt', 'llm.chat',
   0, 0, 'CNY', '["OpenAI 兼容","Codex"]',
   'OpenAI 一族，Codex CLI 与 OpenAI SDK 直接指过来就能用。',
   1, 1, 50, NOW(3), NOW(3))
ON DUPLICATE KEY UPDATE
  `display_name`   = VALUES(`display_name`),
  `vendor`         = VALUES(`vendor`),
  `family`         = VALUES(`family`),
  `kind`           = VALUES(`kind`),
  `context_tokens` = VALUES(`context_tokens`),
  `tags_json`      = VALUES(`tags_json`),
  `summary`        = VALUES(`summary`),
  `listed`         = VALUES(`listed`),
  `featured`       = VALUES(`featured`),
  `sort_order`     = VALUES(`sort_order`),
  `updated_time`   = NOW(3);
