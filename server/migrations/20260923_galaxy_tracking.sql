-- 官网打开与 Orbit 模型广场点击的日汇总埋点。
--
-- 新环境优先运行：
--   cd server/galaxy-api && go run ./cmd/galaxyinit
-- 这份 SQL 给已有环境做增量升级，重复执行安全。
--
-- 不存逐条访问记录：当前看板只需要按日趋势。模型点击以 model_id 作为 target_key，
-- 方便以后做模型排行；官网打开的 target_key 固定为空串。

CREATE TABLE IF NOT EXISTS `zt_galaxy_tracking_daily` (
  `id`           bigint AUTO_INCREMENT,
  `biz_line`     varchar(32),
  `event_date`   date,                                                -- 服务端本地时区统计日期
  `event_key`    varchar(48),                                         -- portal.open / model_square.model_click
  `target_key`   varchar(96),                                         -- 模型 ID；官网打开为空串
  `count`        bigint,                                              -- 触发次数
  `created_time` datetime(3) NULL,
  `updated_time` datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_tracking_daily` (`biz_line`,`event_date`,`event_key`,`target_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
