-- 执行批次心跳：本地桥接每隔几十秒续一次，服务端据此判断执行侧是否还活着。
-- 没有心跳的话，断网或桥接进程被杀之后批次会永远停在 running，
-- 里面的任务再也启动不了（报「任务正在其他执行批次中」）。

ALTER TABLE `zt_delivery_execution_batch`
  ADD COLUMN `heartbeat_at` timestamp NULL AFTER `notification_read_at`;

-- 存量运行中的批次没有心跳字段，先按启动时间当作最后一次心跳，
-- 让它们在心跳过期后被正常判死，而不是一直挡着任务。
UPDATE `zt_delivery_execution_batch` SET `heartbeat_at` = `started_at` WHERE `status` = 'running';
