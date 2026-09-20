-- 管理端权限资源：仪表盘那条接口。
--
-- 首选做法**不是**跑这份 SQL，而是：
--
--     cd server/manager-api && go run ./cmd/managerinit
--
-- 接口资源本来就是从真实路由表生成的（manager.SyncAPIResources），手写一份迟早
-- 和路由分叉。这份 SQL 只给「目标环境跑不了 managerinit」的情况兜底，
-- 内容与它生成的逐字一致。
--
-- 页面资源不用动：dashboard（/dashboard，DashboardOutlined，sort=10）本来就在
-- managerinit 的 pages 清单里，也在 operatorPages 里 —— 那一页一直都在，
-- 只是此前是个空壳。这次它开始读数据了，所以多出**一条接口资源**要授权：
-- 少了它，页面点得进去、数字一片 403。
--
-- 幂等，反复执行不出错、不改已有行。
-- 库：manager-api 的 application.properties 里 sqlconn 指向的那个


-- -------------------------------------------------------------------------
-- 1. 接口资源
--
-- code 不是起的，是算的 —— 必须与 manager.APIResourceCode(method, path) 逐字一致
-- （server/service/manager/routes.go）。路径里的 /api 前缀也进 code，
-- 所以是 api.get.api.galaxy... 这种看着重复的形状，这是对的，别「修」。
-- -------------------------------------------------------------------------

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.dashboard', 'GET /api/galaxy/admin/dashboard', 'api', 'GET', '/api/galaxy/admin/dashboard', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.dashboard');


-- -------------------------------------------------------------------------
-- 2. 角色绑定
--
-- 超级管理员（默认 id=1）不用绑：它在权限判定的第一条规则里直接放行，
-- 根本不查资源表。绑了无害，但也不解决任何 403 —— 真正需要授权的是下面两个。
-- -------------------------------------------------------------------------

-- 2.1 operator（运营）：日常看这一页的就是他们。
INSERT INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT (SELECT id FROM zt_manager_role WHERE code = 'operator' AND status = 'active'), r.id, NOW(3)
FROM zt_manager_resource r
WHERE r.status = 'active'
  AND EXISTS (SELECT 1 FROM zt_manager_role WHERE code = 'operator' AND status = 'active')
  AND r.code = 'api.get.api.galaxy.admin.dashboard'
  AND NOT EXISTS (
    SELECT 1 FROM zt_manager_role_resource rr
    WHERE rr.role_id = (SELECT id FROM zt_manager_role WHERE code = 'operator' AND status = 'active')
      AND rr.resource_id = r.id
  );

-- 2.2 viewer（只读）：这是一条 GET，而且整页只读，照 managerinit 的口径给。
INSERT INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT (SELECT id FROM zt_manager_role WHERE code = 'viewer' AND status = 'active'), r.id, NOW(3)
FROM zt_manager_resource r
WHERE r.status = 'active'
  AND EXISTS (SELECT 1 FROM zt_manager_role WHERE code = 'viewer' AND status = 'active')
  AND r.code = 'api.get.api.galaxy.admin.dashboard'
  AND NOT EXISTS (
    SELECT 1 FROM zt_manager_role_resource rr
    WHERE rr.role_id = (SELECT id FROM zt_manager_role WHERE code = 'viewer' AND status = 'active')
      AND rr.resource_id = r.id
  );


-- -------------------------------------------------------------------------
-- 3. 跑完还差一步：让 ACL 缓存失效
--
-- 权限判定走**进程内缓存**，一致性靠 Redis 里的版本号。直接改库不碰这个版本号，
-- manager-api 会拿着旧缓存继续跑，新资源与新授权**不生效** —— 现象是 SQL 跑成功了
-- 但页面照样 403，很容易误判成 SQL 没写对。
--
--     redis-cli INCR manager:acl:version
--
-- 键名是 {manager.redis_namespace}:acl:version。当前 manager-api 的
-- application.properties 没配这个 key，走默认 namespace「manager」，所以就是
-- manager:acl:version。改过配置的环境按实际值来。或者干脆重启 manager-api。
--
-- 核对用：
--     SELECT id, code, name, writable, status FROM zt_manager_role ORDER BY id;
--     SELECT r.code, rr.role_id FROM zt_manager_resource r
--       LEFT JOIN zt_manager_role_resource rr ON rr.resource_id = r.id
--      WHERE r.code = 'api.get.api.galaxy.admin.dashboard';
-- -------------------------------------------------------------------------
