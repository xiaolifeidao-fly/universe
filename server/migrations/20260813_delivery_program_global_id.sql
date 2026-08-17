-- 已废弃：本文件曾把字符串 program_id 当作全局业务键。
--
-- 交付项目现统一使用 zt_delivery_program.id 的 BIGINT 主键，业务编码字段为
-- program_code。不要执行任何旧版 program_id varchar 唯一索引迁移；存量库请改用
-- 20260814_delivery_program_primary_key.sql，新环境执行 server/delivery.sql。
SELECT 'deprecated: use 20260814_delivery_program_primary_key.sql or server/delivery.sql' AS `message`;
