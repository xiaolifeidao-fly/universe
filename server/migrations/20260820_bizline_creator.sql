-- 空间创建者。创建者不能被任何管理员移出空间，所以要显式记住是谁建的。
-- 存量空间没有这个字段：回填成该空间加入时间最早的那位管理员 —— 建空间时
-- 创建人就是第一条管理员授权行，这是唯一能还原创建者的线索。

ALTER TABLE `zt_bizline_def`
  ADD COLUMN `created_by` bigint NOT NULL DEFAULT 0 AFTER `visible`;

UPDATE `zt_bizline_def` AS d
SET `created_by` = COALESCE((
  SELECT m.`user_id`
  FROM `zt_identity_user_biz_line` AS m
  WHERE m.`biz_line` = d.`code` AND m.`is_manager` = 1
  ORDER BY m.`created_time` ASC, m.`id` ASC
  LIMIT 1
), 0);
