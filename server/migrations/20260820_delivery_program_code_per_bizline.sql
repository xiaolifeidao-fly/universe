-- 项目编码由全局唯一改为按空间唯一。
--
-- 空间归各自的用户所有之后，全局唯一意味着甲空间用过 test，
-- 乙空间就再也建不了同名项目。所有关联走的都是数值主键 id，
-- 编码只承担展示与导入幂等，收窄这个键不影响任何引用。
--
-- 旧索引本身保证了全局唯一，所以收窄成 (biz_line, program_code) 不可能撞上存量重复。

ALTER TABLE `zt_delivery_program`
  DROP INDEX `uk_dlv_program_code`,
  ADD UNIQUE KEY `uk_dlv_program_code` (`biz_line`, `program_code`);
