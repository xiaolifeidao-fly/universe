-- 为已有的交付任务表增加详情文档字段。
-- 新环境直接执行 server/delivery.sql；已存在 zt_delivery_item 的环境执行本文件一次。
ALTER TABLE `zt_delivery_item`
  ADD COLUMN `requirement_document` mediumtext NOT NULL AFTER `description`,
  ADD COLUMN `execution_output` mediumtext NOT NULL AFTER `requirement_document`;
