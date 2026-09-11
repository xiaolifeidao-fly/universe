-- =========================================================================
-- 管理端权限资源：共享算力池运营接口（20 条）
--
-- 首选做法**不是**跑这份 SQL，而是：
--
--     cd server/manager-api && go run ./cmd/managerinit
--
-- 接口资源本来就是从真实路由表生成的（manager.SyncAPIResources），手写一份迟早
-- 和路由分叉。这份 SQL 只给「目标环境跑不了 managerinit」的情况兜底，
-- 内容与 managerinit 生成的完全一致。
--
-- 页面资源不用动：galaxy（/galaxy，GlobalOutlined，sort=50）已经在 managerinit
-- 的 pages 清单里，菜单能显示出来就是证据。这次新增的全是接口。
--
-- 后 10 条是 Galaxy 账号体系独立出来时加的（2026-09-11）：Galaxy 账号的列表 / 停用 /
-- 重置密码，以及原来挂在 galaxy-api、认任务宇宙管理员的那几条运营接口
-- （发内测密钥、人工确认到账、门户模型目录、门户线索）。galaxy-api 上已经没有运营接口了。
--
-- 全部幂等，反复执行不出错、不改已有行。
-- 库：manager-api 的 application.properties 里 sqlconn 指向的那个
-- =========================================================================


-- -------------------------------------------------------------------------
-- 1. 接口资源
--
-- code 不是起的，是算的 —— 必须与 manager.APIResourceCode(method, path) 逐字一致
-- （server/service/manager/routes.go:82）。下面这批是用那个函数真跑出来的，
-- 不是手敲的。对不上的话，下次谁跑一遍 managerinit 会按算出来的 code 再插一套，
-- 手写这批就变成没人指向的孤儿：后台上看着权限还在，实际全空。
--
-- 路径里的 /api 前缀也进 code，所以是 api.get.api.galaxy... 这种看着重复的形状，
-- 这是对的，别「修」。
--
-- 同路径不同方法各占一条：(method, resource_url) 才是接口资源的身份。
-- 只按 URL 分的话 GET 和 POST 分不开，而那正是只读角色最该分开的地方。
--
-- parent_id 固定 0：本仓库的接口资源是平铺的，没有 api_group 那一层。
-- created_time / updated_time 没有数据库默认值（GORM 在应用层填），必须显式写 NOW(3)。
-- -------------------------------------------------------------------------

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.pool', 'GET /api/galaxy/admin/pool', 'api', 'GET', '/api/galaxy/admin/pool', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.pool');

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.nodes', 'GET /api/galaxy/admin/nodes', 'api', 'GET', '/api/galaxy/admin/nodes', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.nodes');

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.probes', 'GET /api/galaxy/admin/probes', 'api', 'GET', '/api/galaxy/admin/probes', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.probes');

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.usage', 'GET /api/galaxy/admin/usage', 'api', 'GET', '/api/galaxy/admin/usage', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.usage');

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.disputes', 'GET /api/galaxy/admin/disputes', 'api', 'GET', '/api/galaxy/admin/disputes', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.disputes');

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.packages', 'GET /api/galaxy/admin/packages', 'api', 'GET', '/api/galaxy/admin/packages', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.packages');

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.node.ban', 'POST /api/galaxy/admin/node/ban', 'api', 'POST', '/api/galaxy/admin/node/ban', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.node.ban');

-- 把账号设成工作室 / 改回散户：决定信誉跟着账号还是设备走。
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.provider.type', 'POST /api/galaxy/admin/provider/type', 'api', 'POST', '/api/galaxy/admin/provider/type', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.provider.type');

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.disputes.resolve', 'POST /api/galaxy/admin/disputes/resolve', 'api', 'POST', '/api/galaxy/admin/disputes/resolve', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.disputes.resolve');

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.packages.save', 'POST /api/galaxy/admin/packages/save', 'api', 'POST', '/api/galaxy/admin/packages/save', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.packages.save');

-- Galaxy 账号列表：共享端、使用端两批人，按端翻。
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.users', 'GET /api/galaxy/admin/users', 'api', 'GET', '/api/galaxy/admin/users', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.users');

-- 停用 / 启用。停用当场让这个账号的令牌作废。
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.users.status', 'POST /api/galaxy/admin/users/status', 'api', 'POST', '/api/galaxy/admin/users/status', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.users.status');

-- 重置密码。本人下次登录必须先改掉。
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.users.password', 'POST /api/galaxy/admin/users/password', 'api', 'POST', '/api/galaxy/admin/users/password', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.users.password');

-- 给使用端账号发内测密钥。响应里有 sk- 明文。
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.keys.issue', 'POST /api/galaxy/admin/keys/issue', 'api', 'POST', '/api/galaxy/admin/keys/issue', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.keys.issue');

-- 人工确认到账。等于发额度，只给运营。
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.orders.pay', 'POST /api/galaxy/admin/orders/pay', 'api', 'POST', '/api/galaxy/admin/orders/pay', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.orders.pay');

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.portal.models', 'GET /api/galaxy/admin/portal/models', 'api', 'GET', '/api/galaxy/admin/portal/models', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.portal.models');

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.portal.models.save', 'POST /api/galaxy/admin/portal/models/save', 'api', 'POST', '/api/galaxy/admin/portal/models/save', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.portal.models.save');

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.portal.models.delete', 'POST /api/galaxy/admin/portal/models/delete', 'api', 'POST', '/api/galaxy/admin/portal/models/delete', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.portal.models.delete');

-- 门户线索：陌生人留下的联系方式。只读角色不给，见 2.3。
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.portal.leads', 'GET /api/galaxy/admin/portal/leads', 'api', 'GET', '/api/galaxy/admin/portal/leads', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.portal.leads');

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.portal.leads.handle', 'POST /api/galaxy/admin/portal/leads/handle', 'api', 'POST', '/api/galaxy/admin/portal/leads/handle', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.portal.leads.handle');


-- -------------------------------------------------------------------------
-- 2. 角色授权
--
-- 注意：**role_id = 1 是超级管理员，绑了也是白绑**。checkRoute 的第一条规则就是
-- 超管直接放行，根本不查资源表（permission.go:116）。所以下面这段幂等无害，
-- 但它不解决任何一个 403 —— 真正要授权的是 operator / viewer。
--
-- 绝不 DELETE 再 INSERT：资源按 code 冲突更新、不重建。重建会换掉资源 id，
-- 把 zt_manager_role_resource 里指向它的授权全部作废 —— 一次例行的重新初始化
-- 就能把所有人的权限清空。
-- -------------------------------------------------------------------------

-- 2.1 role_id = 1（超管，实际不生效，按默认值给出）
INSERT INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT 1, r.id, NOW(3)
FROM zt_manager_resource r
WHERE r.status = 'active'
  AND r.code IN (
    'api.get.api.galaxy.admin.pool',
    'api.get.api.galaxy.admin.nodes',
    'api.get.api.galaxy.admin.probes',
    'api.get.api.galaxy.admin.usage',
    'api.get.api.galaxy.admin.disputes',
    'api.get.api.galaxy.admin.packages',
    'api.post.api.galaxy.admin.node.ban',
    'api.post.api.galaxy.admin.provider.type',
    'api.post.api.galaxy.admin.disputes.resolve',
    'api.post.api.galaxy.admin.packages.save',
    'api.get.api.galaxy.admin.users',
    'api.post.api.galaxy.admin.users.status',
    'api.post.api.galaxy.admin.users.password',
    'api.post.api.galaxy.admin.keys.issue',
    'api.post.api.galaxy.admin.orders.pay',
    'api.get.api.galaxy.admin.portal.models',
    'api.post.api.galaxy.admin.portal.models.save',
    'api.post.api.galaxy.admin.portal.models.delete',
    'api.get.api.galaxy.admin.portal.leads',
    'api.post.api.galaxy.admin.portal.leads.handle'
  )
  AND NOT EXISTS (
    SELECT 1 FROM zt_manager_role_resource rr
    WHERE rr.role_id = 1 AND rr.resource_id = r.id
  );

-- 2.2 operator（运营）：读写全给。
-- 按角色 code 取 id，不硬编码数字 —— 默认建库顺序下 operator 是 2，但那只是默认。
INSERT INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT (SELECT id FROM zt_manager_role WHERE code = 'operator' AND status = 'active'), r.id, NOW(3)
FROM zt_manager_resource r
WHERE r.status = 'active'
  AND EXISTS (SELECT 1 FROM zt_manager_role WHERE code = 'operator' AND status = 'active')
  AND r.code IN (
    'api.get.api.galaxy.admin.pool',
    'api.get.api.galaxy.admin.nodes',
    'api.get.api.galaxy.admin.probes',
    'api.get.api.galaxy.admin.usage',
    'api.get.api.galaxy.admin.disputes',
    'api.get.api.galaxy.admin.packages',
    'api.post.api.galaxy.admin.node.ban',
    'api.post.api.galaxy.admin.provider.type',
    'api.post.api.galaxy.admin.disputes.resolve',
    'api.post.api.galaxy.admin.packages.save',
    'api.get.api.galaxy.admin.users',
    'api.post.api.galaxy.admin.users.status',
    'api.post.api.galaxy.admin.users.password',
    'api.post.api.galaxy.admin.keys.issue',
    'api.post.api.galaxy.admin.orders.pay',
    'api.get.api.galaxy.admin.portal.models',
    'api.post.api.galaxy.admin.portal.models.save',
    'api.post.api.galaxy.admin.portal.models.delete',
    'api.get.api.galaxy.admin.portal.leads',
    'api.post.api.galaxy.admin.portal.leads.handle'
  )
  AND NOT EXISTS (
    SELECT 1 FROM zt_manager_role_resource rr
    WHERE rr.role_id = (SELECT id FROM zt_manager_role WHERE code = 'operator' AND status = 'active')
      AND rr.resource_id = r.id
  );

-- 2.3 viewer（只读）：**只给 GET**，门户线索（portal/leads）除外。
-- 写接口有角色的 writable 开关兜底拦得住，但后台上看到的授权范围会和实际能力
-- 不一致，配起来容易误判 —— 这也是 managerinit 的口径。
-- 线索里是陌生人留下的手机、邮箱，只读角色没有理由拉这份名单（managerinit 的 viewerWithheld）。
INSERT INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT (SELECT id FROM zt_manager_role WHERE code = 'viewer' AND status = 'active'), r.id, NOW(3)
FROM zt_manager_resource r
WHERE r.status = 'active'
  AND EXISTS (SELECT 1 FROM zt_manager_role WHERE code = 'viewer' AND status = 'active')
  AND r.code IN (
    'api.get.api.galaxy.admin.pool',
    'api.get.api.galaxy.admin.nodes',
    'api.get.api.galaxy.admin.probes',
    'api.get.api.galaxy.admin.usage',
    'api.get.api.galaxy.admin.disputes',
    'api.get.api.galaxy.admin.packages',
    'api.get.api.galaxy.admin.users',
    'api.get.api.galaxy.admin.portal.models'
  )
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
--     SELECT code, method, resource_url FROM zt_manager_resource
--      WHERE code LIKE 'api.%.api.galaxy.admin.%' ORDER BY code;
-- -------------------------------------------------------------------------
