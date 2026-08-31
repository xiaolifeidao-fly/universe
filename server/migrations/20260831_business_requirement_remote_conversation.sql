-- 业务诉求远端 Kodes 会话游标。浏览器通过本系统轮询会话，进程重启后仍能续查。
-- 不使用 procedure；已有业务诉求默认处于空闲状态。

ALTER TABLE `zt_business_requirement`
  ADD COLUMN `remote_thread_id` varchar(128) NOT NULL DEFAULT '' AFTER `status`,
  ADD COLUMN `remote_turn_id` varchar(128) NOT NULL DEFAULT '' AFTER `remote_thread_id`,
  ADD COLUMN `remote_status` varchar(16) NOT NULL DEFAULT 'idle' AFTER `remote_turn_id`,
  ADD COLUMN `remote_error` varchar(512) NOT NULL DEFAULT '' AFTER `remote_status`,
  ADD COLUMN `remote_workspace` varchar(512) NOT NULL DEFAULT '' AFTER `remote_error`;
