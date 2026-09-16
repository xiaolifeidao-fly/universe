-- 共享算力池：补上「运营总览」「运行工单」「用量偏差」三个页面。
--
-- 首选做法**不是**跑这份 SQL，而是：
--
--     cd server/manager-api && go run ./cmd/managerinit
--
-- 这份只给「目标环境跑不了 managerinit」兜底。
-- 前置：先跑过 20260916_manager_galaxy_groups.sql 与 20260916_manager_galaxy_orders_bans.sql。
--
--
--   运营总览  共享池的运营散在十几个页面上。没有这一页，判断「有没有事要处理」
--             只能一页页翻 —— 而那些事里有几件是有人在等：提现停在待处理，
--             就是有人的钱既不在手上也没打出去。/galaxy 的重定向也改到它。
--   运行工单  按人查的那条一直在（消费者控制台），运营没有跨租户的。
--             「现在池子里在跑什么」「刚才那批为什么全失败了」此前只能进库 SELECT。
--   用量偏差  zt_galaxy_usage_mismatch 此前**只写不读**：超过阈值就落一行，
--             然后没有任何地方看得见它。虚报在库里有据可查，在管理端查不出来。
--
-- 幂等，反复执行安全。
-- 库：manager-api 的 application.properties 里 sqlconn 指向的那个。


-- -------------------------------------------------------------------------
-- 1. 三个新页面
--
-- 总览组里排在最前：它是 /galaxy 的落点，也是每天第一眼该看的那一页。
-- 原来排 52/53 的两页各往后挪，算力供给与使用与计费两组整体后移，给新页面让位。
-- 只改 sort_id，id 不动 —— 已有授权仍然指向同一条资源。
-- -------------------------------------------------------------------------

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyOverview') AS p), 'galaxyHome', '运营总览', 'page', '', '', '/galaxy/overview', '', 52, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyHome') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyOverview') AS p), 'galaxyUnits', '运行工单', 'page', '', '', '/galaxy/units', '', 54, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyUnits') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxySupply') AS p), 'galaxyMismatches', '用量偏差', 'page', '', '', '/galaxy/mismatches', '', 60, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyMismatches') AS t);

UPDATE zt_manager_resource SET sort_id = 53, updated_time = NOW(3) WHERE code = 'galaxyPool';
UPDATE zt_manager_resource SET sort_id = 55, updated_time = NOW(3) WHERE code = 'galaxySettlement';
UPDATE zt_manager_resource SET sort_id = 56, updated_time = NOW(3) WHERE code = 'galaxySupply';
UPDATE zt_manager_resource SET sort_id = 57, updated_time = NOW(3) WHERE code = 'galaxyNodes';
UPDATE zt_manager_resource SET sort_id = 58, updated_time = NOW(3) WHERE code = 'galaxyPayouts';
UPDATE zt_manager_resource SET sort_id = 59, updated_time = NOW(3) WHERE code = 'galaxyProbes';
UPDATE zt_manager_resource SET sort_id = 61, updated_time = NOW(3) WHERE code = 'galaxyBans';
UPDATE zt_manager_resource SET sort_id = 65, updated_time = NOW(3) WHERE code = 'galaxyDemand';
UPDATE zt_manager_resource SET sort_id = 66, updated_time = NOW(3) WHERE code = 'galaxyKeys';
UPDATE zt_manager_resource SET sort_id = 67, updated_time = NOW(3) WHERE code = 'galaxyOrders';
UPDATE zt_manager_resource SET sort_id = 68, updated_time = NOW(3) WHERE code = 'galaxyPoints';
UPDATE zt_manager_resource SET sort_id = 69, updated_time = NOW(3) WHERE code = 'galaxyPackages';
UPDATE zt_manager_resource SET sort_id = 70, updated_time = NOW(3) WHERE code = 'galaxyPricing';


-- -------------------------------------------------------------------------
-- 2. 四条新接口
--
-- code 必须与 manager.APIResourceCode(method, path) 逐字一致
-- （server/service/manager/routes.go:82）：小写方法名 + 路径按 '/' 换成 '.'。
-- -------------------------------------------------------------------------

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.overview', 'GET /api/galaxy/admin/overview', 'api', 'GET', '/api/galaxy/admin/overview', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.overview') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.mismatches', 'GET /api/galaxy/admin/mismatches', 'api', 'GET', '/api/galaxy/admin/mismatches', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.mismatches') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.units', 'GET /api/galaxy/admin/units', 'api', 'GET', '/api/galaxy/admin/units', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.units') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.units.cancel', 'POST /api/galaxy/admin/units/cancel', 'api', 'POST', '/api/galaxy/admin/units/cancel', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.units.cancel') AS t);


-- -------------------------------------------------------------------------
-- 3. 授权
--
-- 不写死 operator / viewer —— 后台上新建、改过的角色也要跟着走。
-- 3.1 读：谁看得见「池水位」，谁就看得见这三页。它们回答的是同一类问题。
-- -------------------------------------------------------------------------

INSERT IGNORE INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT g.role_id, g.resource_id, NOW(3)
FROM (
  SELECT granted.role_id AS role_id, target.id AS resource_id
  FROM zt_manager_role_resource granted
  JOIN zt_manager_resource ruler ON ruler.id = granted.resource_id AND ruler.code = 'galaxyPool'
  JOIN zt_manager_resource target ON target.code IN (
    'galaxyHome', 'galaxyUnits', 'galaxyMismatches',
    'api.get.api.galaxy.admin.overview',
    'api.get.api.galaxy.admin.mismatches',
    'api.get.api.galaxy.admin.units'
  )
) AS g;

-- 3.2 写：强制取消会打断一条正在跑的请求，跟着「能不能封禁机器」走。

INSERT IGNORE INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT g.role_id, g.resource_id, NOW(3)
FROM (
  SELECT granted.role_id AS role_id, target.id AS resource_id
  FROM zt_manager_role_resource granted
  JOIN zt_manager_resource ruler ON ruler.id = granted.resource_id
    AND ruler.code = 'api.post.api.galaxy.admin.node.ban'
  JOIN zt_manager_resource target ON target.code = 'api.post.api.galaxy.admin.units.cancel'
) AS g;


-- -------------------------------------------------------------------------
-- 4. 跑完还差一步：让 ACL 缓存失效
--
--     redis-cli INCR manager:acl:version
--
-- 键名是 {manager.redis_namespace}:acl:version，namespace 缺省 manager。
-- 或者直接重启 manager-api。
-- -------------------------------------------------------------------------
