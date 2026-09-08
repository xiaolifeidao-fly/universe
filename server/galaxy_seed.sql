-- =========================================================================
-- galaxy 内测种子数据：定价 + 额度包。
--
-- 这份文件对应 galaxyinit 里除建表以外的那一半。已经跑过 galaxyinit 的库不用再跑；
-- 只跑了 server/galaxy.sql（建表）的库需要跑它，否则：
--   - 定价表空 → 请求只计量不计费（billing.go 找不到价直接跳过入账）
--   - 商品表空 → 控制台「额度与订单」显示「暂时没有上架的额度包」，买不了东西
--
-- 支付渠道**不在这份文件里，也不在任何表里**：它是 galaxy-api 的配置
-- （galaxy.payment.*），进程启动时读进内存组成 payments.Registry。
-- 见本文件末尾的说明。
--
-- 金额与单价的量纲：整数微元，除以 1_000_000 得到「元」。
--   amount = 9_900_000  → ¥9.90
--   price  = 3_000_000  → ¥3.00 / 每百万单位
-- 计费口径是 cost = amount × price ÷ 1_000_000（billing.go 的 priceScale）。
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
-- provider_share 是提供者分成比例。
-- -------------------------------------------------------------------------

INSERT INTO `zt_galaxy_price`
  (`biz_line`, `kind`, `unit`, `effective_from`, `price`, `currency`, `provider_share`)
VALUES
  -- 中转站：按 token 计价
  ('galaxy', 'llm.chat',          'llm.input_tokens',       '2026-01-01 00:00:00',  3000000, 'CNY', 0.7),
  ('galaxy', 'llm.chat',          'llm.output_tokens',      '2026-01-01 00:00:00', 15000000, 'CNY', 0.7),
  ('galaxy', 'llm.chat',          'llm.cache_read_tokens',  '2026-01-01 00:00:00',   300000, 'CNY', 0.7),

  -- 任务宇宙：一个回合背后就是若干次 LLM 调用，换个计价单位只会让同一件事
  -- 在两张账单上对不上，所以和 llm.chat 同价。
  ('galaxy', 'delivery.task',     'llm.input_tokens',       '2026-01-01 00:00:00',  3000000, 'CNY', 0.7),
  ('galaxy', 'delivery.task',     'llm.output_tokens',      '2026-01-01 00:00:00', 15000000, 'CNY', 0.7),
  ('galaxy', 'delivery.task',     'llm.cache_read_tokens',  '2026-01-01 00:00:00',   300000, 'CNY', 0.7),

  -- 视频渲染：按输出时长与算力秒计价（O-01 口径）
  ('galaxy', 'video.edit.render', 'video.output_seconds',   '2026-01-01 00:00:00', 20000000, 'CNY', 0.7),
  ('galaxy', 'video.edit.render', 'cpu.seconds',            '2026-01-01 00:00:00',  2000000, 'CNY', 0.7)
ON DUPLICATE KEY UPDATE
  `price`          = VALUES(`price`),
  `currency`       = VALUES(`currency`),
  `provider_share` = VALUES(`provider_share`);


-- -------------------------------------------------------------------------
-- 2. 额度包
--
-- 商品是运营配置，不是代码常量 —— 调价与上下架不该走发版。下面几行是内测口径，
-- 价格与额度都按运营的意思再改；改完不用重启，控制台下次刷新就是新的。
--
-- units_json  这份商品给的额度：单位 → 数量。下单那一刻会快照进订单，
--             之后改商品不影响已经下过的单。
-- ttl_days    这份商品签发出的密钥有效期。
-- allowed_kinds_json / model_tier_json  留空字符串 = 不限制。
--             要限制就写 JSON 数组，例如 '["llm.chat"]'。
-- listed      下架只把它置 0，不要 DELETE：删了的话，已经引用这个 package_code
--             的历史订单就查不到自己买的是什么了。
-- sort_order  控制台里的排列顺序，小的在前。
-- -------------------------------------------------------------------------

INSERT INTO `zt_galaxy_package`
  (`biz_line`, `package_code`, `title`, `units_json`, `amount`, `currency`, `ttl_days`,
   `allowed_kinds_json`, `model_tier_json`, `concurrency`, `rpm`, `listed`, `sort_order`,
   `created_time`, `updated_time`)
VALUES
  ('galaxy', 'starter', '入门包',
   '{"llm.input_tokens":5000000,"llm.output_tokens":1000000}',
   9900000, 'CNY', 30, '', '', 4, 120, 1, 10, NOW(3), NOW(3)),

  ('galaxy', 'standard', '标准包',
   '{"llm.input_tokens":30000000,"llm.output_tokens":6000000,"llm.cache_read_tokens":30000000}',
   99000000, 'CNY', 90, '', '', 8, 300, 1, 20, NOW(3), NOW(3)),

  ('galaxy', 'team', '团队包',
   '{"llm.input_tokens":200000000,"llm.output_tokens":40000000,"llm.cache_read_tokens":200000000}',
   499000000, 'CNY', 180, '', '', 16, 600, 1, 30, NOW(3), NOW(3)),

  -- 视频渲染单独一份：它和 token 不是一个计价维度，混在一个包里没法算价。
  ('galaxy', 'video_starter', '视频渲染入门包',
   '{"video.output_seconds":3600,"cpu.seconds":36000}',
   19900000, 'CNY', 90, '["video.edit.render"]', '', 2, 60, 1, 40, NOW(3), NOW(3))
ON DUPLICATE KEY UPDATE
  `title`              = VALUES(`title`),
  `units_json`         = VALUES(`units_json`),
  `amount`             = VALUES(`amount`),
  `currency`           = VALUES(`currency`),
  `ttl_days`           = VALUES(`ttl_days`),
  `allowed_kinds_json` = VALUES(`allowed_kinds_json`),
  `model_tier_json`    = VALUES(`model_tier_json`),
  `concurrency`        = VALUES(`concurrency`),
  `rpm`                = VALUES(`rpm`),
  `listed`             = VALUES(`listed`),
  `sort_order`         = VALUES(`sort_order`),
  `updated_time`       = NOW(3);


-- -------------------------------------------------------------------------
-- 3. 支付渠道：没有表，不用 SQL
--
-- 渠道由 galaxy-api/configs/application.properties 定义，进程启动时读进内存
-- （routers.loadPaymentVerifier → payments.NewRegistry）。刻意不落库：
--
--   - 渠道背后是**验签密钥**。放进表里等于多一个泄露面 —— 一次 SQL 注入、
--     一份误导出的数据、一个有读权限的运维，都能把它带走，而拿到密钥的人
--     可以伪造「已支付」的回调，凭空把额度提走。
--   - 「有哪些渠道可用」必须在**路由注册之前**就定下来：一个已验签渠道都没有时
--     那条未鉴权的回调路由整个不注册。启动后才查库就晚了。
--
-- 内测（本人点击即到账，不经收银台）：
--
--   galaxy.payment.sandbox_channels = wechat_sandbox,alipay_sandbox,card_sandbox
--   galaxy.payment.wechat_sandbox.title = 微信支付（沙箱）
--   galaxy.payment.alipay_sandbox.title = 支付宝（沙箱）
--   galaxy.payment.card_sandbox.title   = 银行卡（沙箱）
--
-- 接真渠道（回调验签，走 POST /galaxy/payments/{code}/callback）：
--
--   galaxy.payment.channels = wechat,alipay
--   galaxy.payment.wechat.title       = 微信支付
--   galaxy.payment.wechat.hmac_secret = <与渠道共享的密钥>
--   galaxy.payment.alipay.title       = 支付宝
--   galaxy.payment.alipay.hmac_secret = <与渠道共享的密钥>
--
-- 对外开放之前必须把 sandbox_channels 清空：留着它，任何能登录控制台的人
-- 都能给自己发额度。改完配置重启 galaxy-api 生效。
-- -------------------------------------------------------------------------
