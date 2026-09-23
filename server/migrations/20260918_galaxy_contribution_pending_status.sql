-- 贡献表加一列：主人点了关闭、但还有请求在跑时，记下他想落到的状态。
--
-- 改之前，关闭的门槛是「有没有消费者绑在座位上」。座位是会话亲和，空闲 30 分钟才释放，
-- 所以主人关完最后一次调用，还要对着「不能下线」的红条点半小时 —— 而那半小时里
-- 这台机器一条请求都没在跑。门槛因此换成 inflight（真正在跑的请求）。
--
-- 换了门槛还剩一个问题：请求正在跑的那几秒到几分钟里，主人只能反复点。所以这一列
-- 记的是**意图**：点一次就够了，停止接新单，等在途归零自动落到目标状态。
--
-- 为什么不复用 status 里的 draining：
--   draining 是额度触顶时心跳自己写的，每个心跳都会按额度把它在 active/draining
--   之间来回改。主人的意图塞进同一列，会在下一个心跳被冲掉 —— 表现是关了又自己开回来。
--   意图和额度是两个独立的事实，必须两列。
--
-- 值域和 status 一样（paused / disabled），空串或 NULL 表示「主人没在等关闭」。
-- 幂等：跑之前先判断列在不在，重复执行不会报 1060。
SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_contribution'
     AND column_name = 'pending_status'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE `zt_galaxy_contribution`
     ADD COLUMN `pending_status` varchar(16) NULL DEFAULT NULL COMMENT ''主人点了关闭、等在途请求跑完之后要落到的状态''',
  'SELECT ''zt_galaxy_contribution.pending_status 已存在，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
