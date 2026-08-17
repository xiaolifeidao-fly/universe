-- 需求级 HTML 原型：多个模块 HTML 保存到项目工作区 doc/requirements/<需求键>/prototype/ 下，
-- 数据库只保存相对位置和生成时间，供面板关联与本地桥接安全预览。
-- MySQL 不支持 ADD COLUMN IF NOT EXISTS，使用 information_schema 包装成可重复执行的迁移。

DELIMITER $$

DROP PROCEDURE IF EXISTS `migrate_delivery_requirement_html_prototype`$$
CREATE PROCEDURE `migrate_delivery_requirement_html_prototype`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'zt_delivery_requirement'
      AND column_name = 'prototype_html_path'
  ) THEN
    ALTER TABLE `zt_delivery_requirement`
      ADD COLUMN `prototype_html_path` varchar(512) NOT NULL DEFAULT '' AFTER `generate_prototype`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'zt_delivery_requirement'
      AND column_name = 'prototype_generated_at'
  ) THEN
    ALTER TABLE `zt_delivery_requirement`
      ADD COLUMN `prototype_generated_at` timestamp NULL AFTER `prototype_html_path`;
  END IF;
END$$

CALL `migrate_delivery_requirement_html_prototype`()$$
DROP PROCEDURE `migrate_delivery_requirement_html_prototype`$$

DELIMITER ;
