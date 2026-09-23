-- =========================================================================
-- 管理端身份与权限建表语句 · zt_manager_*
--
-- 与 service/manager/internal/repository/model.go 一一对应。这份文件不是手写的，
-- 是让 GORM 自己走一遍建表流程抄下来的（见 ddldump_test.go），所以先跑这份 SQL
-- 再跑 `go run ./cmd/managerinit` 不会被 ALTER —— 两条路建出来的结构一模一样。
--
-- 因此这里刻意不写 COLUMN COMMENT、不加多余的 DEFAULT、不写 NOT NULL：
-- AutoMigrate 会把「库里有、模型里没有」判定为差异并改回去。字段说明放在行注释里。
--
-- 这是一套**独立于 zt_identity_user** 的账号：web 控制台和 App 的业务账号登不进
-- 管理端。管理端的处置动作会动真钱（封禁节点、裁决争议、发算力密钥），
-- 它的账号不该和业务用户共用一个 role=admin 布尔。
--
-- 只跑这份 SQL 的话表是空的：没有角色、没有资源、没有管理员，谁也登不进去。
-- 必须再跑一次 `go run ./cmd/managerinit` —— 它登记资源（接口资源按真实路由表
-- 生成）、写入三个默认角色、创建默认管理员。
--
-- 库：manager-api 的 application.properties 里 sqlconn 指向的那个
-- 依赖：MySQL 5.7+
-- =========================================================================

-- 授权模型：user -->< user_role >-- role -->< role_resource >-- resource(树)
--
-- 资源是一棵树，菜单 / 页面 / 接口同处其中。接口资源的身份是 (method, 路由模板)
-- 二元组 —— 只按 URL 分的话，同一路径的 GET 和 POST 分不开，而那正是只读角色
-- 最该分开的地方。
--
-- 角色另有一个 writable 开关，是粗粒度保险：把一个角色整体设成只读一句话配完，
-- 不必逐条撤销它的写资源。两道门叠加，写操作两道都得过。


CREATE TABLE IF NOT EXISTS `zt_manager_user` (
  `id`                   bigint AUTO_INCREMENT,
  `user_id`              varchar(40),           -- mu_ + ULID
  `username`             varchar(64),
  `display_name`         varchar(128),
  `password_hash`        varchar(128),          -- bcrypt，明文不落库
  `status`               varchar(16),           -- active/disabled
  `must_change_password` boolean DEFAULT false,
  `last_login_at`        timestamp null,
  `remark`               varchar(256),
  `created_time`         datetime(3) NULL,
  `updated_time`         datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_mgr_user_id` (`user_id`),
  UNIQUE INDEX `uk_mgr_user_name` (`username`),
  INDEX `idx_mgr_user_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_manager_role` (
  `id`           bigint AUTO_INCREMENT,
  `code`         varchar(64),
  `name`         varchar(64),
  `writable`     boolean DEFAULT false,     -- 角色是否允许写操作，默认只读
  `status`       varchar(16),               -- active/disabled
  `remark`       varchar(256),
  `created_time` datetime(3) NULL,
  `updated_time` datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_mgr_role_code` (`code`),
  INDEX `idx_mgr_role_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_manager_resource` (
  `id`            bigint AUTO_INCREMENT,
  `parent_id`     bigint DEFAULT 0,
  `code`          varchar(96),                     -- 稳定标识，前端按它取 i18n 文案
  `name`          varchar(64),
  `resource_type` varchar(16),                     -- menu/page/api
  `method`        varchar(8),                      -- 接口资源的 HTTP 方法；菜单与页面为空
  `resource_url`  varchar(200),                    -- gin 路由模板，如 /api/users/:id
  `page_url`      varchar(200),                    -- 前端路由，菜单项的 key 就是它
  `icon`          varchar(64),                     -- antd 图标名，前端按白名单查组件
  `sort_id`       bigint DEFAULT 0,
  `status`        varchar(16),                     -- active/disabled
  `created_time`  datetime(3) NULL,
  `updated_time`  datetime(3) NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_mgr_resource_parent` (`parent_id`),
  UNIQUE INDEX `uk_mgr_resource_code` (`code`),
  INDEX `idx_mgr_resource_type` (`resource_type`),
  INDEX `idx_mgr_resource_url` (`resource_url`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_manager_user_role` (
  `id`           bigint AUTO_INCREMENT,
  `user_id`      bigint,
  `role_id`      bigint,
  `created_time` datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_mgr_user_role` (`user_id`,`role_id`),
  INDEX `idx_mgr_user_role_role` (`role_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_manager_role_resource` (
  `id`           bigint AUTO_INCREMENT,
  `role_id`      bigint,
  `resource_id`  bigint,
  `created_time` datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_mgr_role_resource` (`role_id`,`resource_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `zt_manager_login_record` (
  `id`           bigint AUTO_INCREMENT,
  `user_id`      varchar(40),
  `username`     varchar(64),
  `ip`           varchar(64),
  `user_agent`   varchar(256),
  `success`      boolean DEFAULT false,
  `reason`       varchar(128),
  `created_time` datetime(3) NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_mgr_login_user` (`user_id`,`created_time` desc)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
