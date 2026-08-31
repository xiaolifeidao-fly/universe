-- 记录当前这一轮远端会话被要求产出什么：空或 statement 是普通访谈追问，
-- document 是业务方点了「确认文档」。这一轮由后续的轮询请求收尾，那时已经
-- 没有别的地方能读到当初的动作，所以必须落库。

ALTER TABLE `zt_business_requirement`
  ADD COLUMN `remote_mode` varchar(16) NOT NULL DEFAULT '' AFTER `remote_error`;
