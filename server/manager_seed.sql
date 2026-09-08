-- =========================================================================
-- 管理端初始化数据 · zt_manager_*
--
-- 由 manager-api/cmd/managerseed 生成于 2026-09-08，不要手改 ——
-- 接口资源是从真实路由表导出的，手改会和代码分叉，而分叉的现象是
-- 「登录用户一律 403」，看起来像 bug 其实是配置漏登记。
--
-- 前置：先执行 server/manager.sql 建表。
-- 幂等：反复执行安全。角色、资源、账号都按业务键去重；已存在的记录不会被覆盖，
--       所以**不会**把线上改过的密码或授权重置回来。
--
-- 执行完之后用 admin 登录，首次登录会被强制要求改密码。
-- =========================================================================

-- ---------------------------------------------------------------------
-- 1. 角色
--
-- writable 是角色级的读写总开关，和资源授权叠加：写操作两道门都得过。
-- 只有资源授权配不出「这个角色临时只读」（要逐条撤销写资源）；
-- 只有 writable 配不出「能改用户、不能封节点」。
--
-- super_admin 绕过资源过滤 —— 一次配错授权就能把所有人关在门外，
-- 必须留一条改回来的活路。它不需要任何 role_resource 记录。
-- ---------------------------------------------------------------------

INSERT INTO zt_manager_role (code, name, writable, status, remark, created_time, updated_time)
SELECT 'super_admin', '超级管理员', 1, 'active', '绕过资源过滤，看得到也改得了全部', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_role WHERE code = 'super_admin') AS t);
INSERT INTO zt_manager_role (code, name, writable, status, remark, created_time, updated_time)
SELECT 'operator', '运营', 1, 'active', '日常运营：五个业务页面可读可写，不含系统设置', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_role WHERE code = 'operator') AS t);
INSERT INTO zt_manager_role (code, name, writable, status, remark, created_time, updated_time)
SELECT 'viewer', '只读', 0, 'active', '所有页面只读；任何写操作都会被 writable 挡下', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_role WHERE code = 'viewer') AS t);

-- ---------------------------------------------------------------------
-- 2. 页面与菜单资源
--
-- code 是稳定标识：前端按 t("nav." + code) 取 i18n 文案，改它等于改文案键。
-- 分两步插：先插顶层，再插子页面（parent_id 要引用刚插进去的菜单 id）。
-- ---------------------------------------------------------------------

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'dashboard', '仪表盘', 'page', '', '', '/dashboard', 'DashboardOutlined', 10, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'dashboard') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'users', '用户管理', 'page', '', '', '/users', 'TeamOutlined', 20, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'users') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'businessLines', '业务线管理', 'page', '', '', '/business-lines', 'BranchesOutlined', 30, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'businessLines') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'programs', '项目管理', 'page', '', '', '/programs', 'FolderOutlined', 40, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'programs') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'galaxy', '共享算力池', 'page', '', '', '/galaxy', 'GlobalOutlined', 50, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxy') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'settings', '系统设置', 'menu', '', '', '', 'SettingOutlined', 90, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'settings') AS t);

-- 子页面：parent_id 按 code 反查，不写死自增 id。

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'settings') AS p), 'settingsAccounts', '管理端账号', 'page', '', '', '/settings/accounts', '', 91, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'settingsAccounts') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'settings') AS p), 'settingsRoles', '角色与权限', 'page', '', '', '/settings/roles', '', 92, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'settingsRoles') AS t);

-- ---------------------------------------------------------------------
-- 3. 接口资源（36 条，从 gin 路由表导出）
--
-- resource_url 存的是**路由模板**（/api/users/:id），不是具体请求路径 ——
-- 中间件拿 c.FullPath() 来比对，否则每个 id 都要在表里占一行。
--
-- method 参与身份认定：同一路径的 GET 和 POST 是两条独立资源，
-- 这样才配得出「能看用户列表、不能改用户」。
--
-- 公开路由（POST /api/auth/login）也在表里，但中间件在白名单阶段就放行了，
-- 不会走到资源判断 —— 留着它是为了后台能看到这条路由存在。
-- ---------------------------------------------------------------------

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.auth.login', 'POST /api/auth/login', 'api', 'POST', '/api/auth/login', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.auth.login') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.auth.logout', 'POST /api/auth/logout', 'api', 'POST', '/api/auth/logout', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.auth.logout') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.auth.me', 'GET /api/auth/me', 'api', 'GET', '/api/auth/me', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.auth.me') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.auth.password', 'POST /api/auth/password', 'api', 'POST', '/api/auth/password', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.auth.password') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.bizlines', 'GET /api/bizlines', 'api', 'GET', '/api/bizlines', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.bizlines') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.bizlines', 'POST /api/bizlines', 'api', 'POST', '/api/bizlines', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.bizlines') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.bizlines.delete', 'POST /api/bizlines/delete', 'api', 'POST', '/api/bizlines/delete', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.bizlines.delete') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.bizlines.member.permission', 'POST /api/bizlines/member/permission', 'api', 'POST', '/api/bizlines/member/permission', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.bizlines.member.permission') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.bizlines.member.remove', 'POST /api/bizlines/member/remove', 'api', 'POST', '/api/bizlines/member/remove', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.bizlines.member.remove') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.bizlines.members', 'GET /api/bizlines/members', 'api', 'GET', '/api/bizlines/members', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.bizlines.members') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.current-user-menus', 'GET /api/current-user-menus', 'api', 'GET', '/api/current-user-menus', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.current-user-menus') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.manager.accounts', 'GET /api/manager/accounts', 'api', 'GET', '/api/manager/accounts', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.manager.accounts') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.manager.accounts', 'POST /api/manager/accounts', 'api', 'POST', '/api/manager/accounts', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.manager.accounts') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.manager.accounts.userId', 'GET /api/manager/accounts/:userId', 'api', 'GET', '/api/manager/accounts/:userId', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.manager.accounts.userId') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.manager.accounts.userId.delete', 'POST /api/manager/accounts/:userId/delete', 'api', 'POST', '/api/manager/accounts/:userId/delete', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.manager.accounts.userId.delete') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.manager.accounts.userId.logins', 'GET /api/manager/accounts/:userId/logins', 'api', 'GET', '/api/manager/accounts/:userId/logins', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.manager.accounts.userId.logins') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.manager.accounts.userId.password', 'POST /api/manager/accounts/:userId/password', 'api', 'POST', '/api/manager/accounts/:userId/password', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.manager.accounts.userId.password') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.manager.accounts.userId.status', 'POST /api/manager/accounts/:userId/status', 'api', 'POST', '/api/manager/accounts/:userId/status', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.manager.accounts.userId.status') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.manager.resources', 'GET /api/manager/resources', 'api', 'GET', '/api/manager/resources', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.manager.resources') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.manager.resources', 'POST /api/manager/resources', 'api', 'POST', '/api/manager/resources', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.manager.resources') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.manager.resources.id.delete', 'POST /api/manager/resources/:id/delete', 'api', 'POST', '/api/manager/resources/:id/delete', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.manager.resources.id.delete') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.manager.roles', 'GET /api/manager/roles', 'api', 'GET', '/api/manager/roles', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.manager.roles') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.manager.roles', 'POST /api/manager/roles', 'api', 'POST', '/api/manager/roles', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.manager.roles') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.manager.roles.id.delete', 'POST /api/manager/roles/:id/delete', 'api', 'POST', '/api/manager/roles/:id/delete', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.manager.roles.id.delete') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.manager.roles.id.resources', 'GET /api/manager/roles/:id/resources', 'api', 'GET', '/api/manager/roles/:id/resources', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.manager.roles.id.resources') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.manager.roles.id.resources', 'POST /api/manager/roles/:id/resources', 'api', 'POST', '/api/manager/roles/:id/resources', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.manager.roles.id.resources') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.programs', 'GET /api/programs', 'api', 'GET', '/api/programs', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.programs') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.programs', 'POST /api/programs', 'api', 'POST', '/api/programs', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.programs') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.programs.id', 'GET /api/programs/:id', 'api', 'GET', '/api/programs/:id', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.programs.id') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.programs.id', 'POST /api/programs/:id', 'api', 'POST', '/api/programs/:id', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.programs.id') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.users', 'GET /api/users', 'api', 'GET', '/api/users', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.users') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.users', 'POST /api/users', 'api', 'POST', '/api/users', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.users') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.users.id', 'GET /api/users/:id', 'api', 'GET', '/api/users/:id', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.users.id') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.users.id', 'POST /api/users/:id', 'api', 'POST', '/api/users/:id', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.users.id') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.users.id.delete', 'POST /api/users/:id/delete', 'api', 'POST', '/api/users/:id/delete', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.users.id.delete') AS t);
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.users.id.password', 'POST /api/users/:id/password', 'api', 'POST', '/api/users/:id/password', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.users.id.password') AS t);

-- ---------------------------------------------------------------------
-- 4. 超级管理员
--
-- password_hash 是 bcrypt（cost 10）。must_change_password=1：这个账号除了改密码
-- 什么接口都调不动（中间件把这个判断放在资源检查之前），前端会强制弹出改密弹窗
-- 且不给关闭。
--
-- user_id 用 UUID 代替代码里的 ULID —— 形状不同不影响任何逻辑，它只是个不透明的
-- 业务键；这样这份 SQL 里就不用硬编码一个固定 id。
-- ---------------------------------------------------------------------

INSERT INTO zt_manager_user
  (user_id, username, display_name, password_hash, status, must_change_password, remark, created_time, updated_time)
SELECT CONCAT('mu_', REPLACE(UUID(), '-', '')), 'admin', 'Administrator', '$2a$10$Tbjs3s2AE.cr1F2XJ7LRSOp5Z.FaEh6rff/v2K7s5.8PLAQ0T9t1G', 'active', 1, '初始超级管理员', NOW(3), NOW(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_user WHERE username = 'admin') AS t);

-- 绑上 super_admin。两个 id 都按业务键反查，不写死自增值。
INSERT INTO zt_manager_user_role (user_id, role_id, created_time)
SELECT u.id, r.id, NOW(3)
FROM zt_manager_user u
JOIN zt_manager_role r ON r.code = 'super_admin'
WHERE u.username = 'admin'
  AND NOT EXISTS (
    SELECT 1 FROM zt_manager_user_role rr WHERE rr.user_id = u.id AND rr.role_id = r.id
  );

-- ---------------------------------------------------------------------
-- 5. 授权
--
-- super_admin 不在这里 —— 它绕过资源过滤，给它记授权是多余的。
--
-- operator：五个业务页面 + 全部接口。它是「日常运营」，改得动数据，
--           但看不到系统设置那两个页面（能改角色授权的角色，和超管没区别了）。
-- viewer：  五个业务页面 + 只读接口。写接口不给它 —— 给了再靠 writable 拦
--           虽然拦得住，但后台上看到的授权范围会和实际能力不一致，容易误判。
-- ---------------------------------------------------------------------

-- operator ← 5 条页面资源
INSERT INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT rl.id, r.id, NOW(3)
FROM zt_manager_resource r
JOIN (SELECT id FROM (SELECT id FROM zt_manager_role WHERE code = 'operator') AS x) AS rl
WHERE r.status = 'active'
  AND r.code IN (
  'dashboard', 'users', 'businessLines', 'programs',
  'galaxy'
  )
  AND NOT EXISTS (
    SELECT 1 FROM zt_manager_role_resource rr WHERE rr.role_id = rl.id AND rr.resource_id = r.id
  );

-- operator ← 36 条接口资源
INSERT INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT rl.id, r.id, NOW(3)
FROM zt_manager_resource r
JOIN (SELECT id FROM (SELECT id FROM zt_manager_role WHERE code = 'operator') AS x) AS rl
WHERE r.status = 'active'
  AND r.code IN (
  'api.post.api.auth.login', 'api.post.api.auth.logout', 'api.get.api.auth.me', 'api.post.api.auth.password',
  'api.get.api.bizlines', 'api.post.api.bizlines', 'api.post.api.bizlines.delete', 'api.post.api.bizlines.member.permission',
  'api.post.api.bizlines.member.remove', 'api.get.api.bizlines.members', 'api.get.api.current-user-menus', 'api.get.api.manager.accounts',
  'api.post.api.manager.accounts', 'api.get.api.manager.accounts.userId', 'api.post.api.manager.accounts.userId.delete', 'api.get.api.manager.accounts.userId.logins',
  'api.post.api.manager.accounts.userId.password', 'api.post.api.manager.accounts.userId.status', 'api.get.api.manager.resources', 'api.post.api.manager.resources',
  'api.post.api.manager.resources.id.delete', 'api.get.api.manager.roles', 'api.post.api.manager.roles', 'api.post.api.manager.roles.id.delete',
  'api.get.api.manager.roles.id.resources', 'api.post.api.manager.roles.id.resources', 'api.get.api.programs', 'api.post.api.programs',
  'api.get.api.programs.id', 'api.post.api.programs.id', 'api.get.api.users', 'api.post.api.users',
  'api.get.api.users.id', 'api.post.api.users.id', 'api.post.api.users.id.delete', 'api.post.api.users.id.password'
  )
  AND NOT EXISTS (
    SELECT 1 FROM zt_manager_role_resource rr WHERE rr.role_id = rl.id AND rr.resource_id = r.id
  );

-- viewer ← 5 条页面资源
INSERT INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT rl.id, r.id, NOW(3)
FROM zt_manager_resource r
JOIN (SELECT id FROM (SELECT id FROM zt_manager_role WHERE code = 'viewer') AS x) AS rl
WHERE r.status = 'active'
  AND r.code IN (
  'dashboard', 'users', 'businessLines', 'programs',
  'galaxy'
  )
  AND NOT EXISTS (
    SELECT 1 FROM zt_manager_role_resource rr WHERE rr.role_id = rl.id AND rr.resource_id = r.id
  );

-- viewer ← 14 条接口资源
INSERT INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT rl.id, r.id, NOW(3)
FROM zt_manager_resource r
JOIN (SELECT id FROM (SELECT id FROM zt_manager_role WHERE code = 'viewer') AS x) AS rl
WHERE r.status = 'active'
  AND r.code IN (
  'api.get.api.auth.me', 'api.get.api.bizlines', 'api.get.api.bizlines.members', 'api.get.api.current-user-menus',
  'api.get.api.manager.accounts', 'api.get.api.manager.accounts.userId', 'api.get.api.manager.accounts.userId.logins', 'api.get.api.manager.resources',
  'api.get.api.manager.roles', 'api.get.api.manager.roles.id.resources', 'api.get.api.programs', 'api.get.api.programs.id',
  'api.get.api.users', 'api.get.api.users.id'
  )
  AND NOT EXISTS (
    SELECT 1 FROM zt_manager_role_resource rr WHERE rr.role_id = rl.id AND rr.resource_id = r.id
  );

-- ---------------------------------------------------------------------
-- 6. 跑完 SQL 还差一步：让 ACL 缓存失效
--
-- 权限判定走进程内缓存，一致性靠 Redis 里的版本号。直接改库不会碰这个版本号，
-- 已经跑着的 manager-api 会拿着旧缓存继续跑，上面这些资源与授权**不生效**。
--
--     redis-cli INCR manager:acl:version
--
-- 键名是 {manager.redis_namespace}:acl:version，namespace 缺省 manager，
-- 实际值见 server/manager-api/configs/application.properties。
-- 或者直接重启 manager-api。
-- ---------------------------------------------------------------------
