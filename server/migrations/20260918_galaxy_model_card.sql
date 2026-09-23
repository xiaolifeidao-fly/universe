-- 模型目录加四列：官方参考价（输入 / 输出）和卡片角标（文案 / 配色）。
--
-- 为什么要「官方参考价」这一档：模型广场改成了比价卡片 —— 自家单价旁边划一道
-- 官方价、右边标「省 X%」。这两个数必须是运营自己填的事实，不能由代码推：
-- 上游改价我们不会立刻知道，猜一个折扣写上去，性质上就是价格欺诈。
-- 留 0 表示没填，卡片上划线价和「省 X%」一起不出现 —— 比标一个「省 0%」诚实。
--
-- 口径与 input_price / output_price 完全一致：每百万 token 的微分，同一币种。
-- 折扣必须在同一币种内算，混着美元存的话汇率一动折扣就跟着飘。
--
-- badge_text 是卡片右上角那个角标（「首发」「性价比旗舰」「均衡」）。
-- 它不能从 featured 推：featured 只有真假两种，而这类词随时间换，是运营的文案。
-- 空串就不显示角标。badge_tone 只认 hot / new / value / neutral 四种，
-- 前端映射到既有的四种胶囊配色 —— 让运营直接填颜色的话，迟早出现一张
-- 六种颜色的卡片墙。
--
-- 幂等：跑之前先判断列在不在，重复执行不会报 1060。

SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_model'
     AND column_name = 'list_input_price'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE `zt_galaxy_model`
     ADD COLUMN `list_input_price` bigint NOT NULL DEFAULT 0
     COMMENT ''官方参考价：每百万 input token 微分，0=不显示划线价'' AFTER `cache_write_price`',
  'SELECT ''zt_galaxy_model.list_input_price 已存在，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_model'
     AND column_name = 'list_output_price'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE `zt_galaxy_model`
     ADD COLUMN `list_output_price` bigint NOT NULL DEFAULT 0
     COMMENT ''官方参考价：每百万 output token 微分，0=不显示划线价'' AFTER `list_input_price`',
  'SELECT ''zt_galaxy_model.list_output_price 已存在，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_model'
     AND column_name = 'badge_text'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE `zt_galaxy_model`
     ADD COLUMN `badge_text` varchar(16) NOT NULL DEFAULT ''''
     COMMENT ''卡片右上角角标文案，空=不显示'' AFTER `summary`',
  'SELECT ''zt_galaxy_model.badge_text 已存在，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_model'
     AND column_name = 'badge_tone'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE `zt_galaxy_model`
     ADD COLUMN `badge_tone` varchar(16) NOT NULL DEFAULT ''neutral''
     COMMENT ''角标配色：hot/new/value/neutral'' AFTER `badge_text`',
  'SELECT ''zt_galaxy_model.badge_tone 已存在，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
