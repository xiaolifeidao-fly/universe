-- 共享算力池：补上「订单」与「封禁名单」两个页面。
--
-- 首选做法**不是**跑这份 SQL，而是：
--
--     cd server/manager-api && go run ./cmd/managerinit
--
-- 这份只给「目标环境跑不了 managerinit」兜底。
-- 前置：先跑过 20260916_manager_galaxy_groups.sql（分组标题在那份里建）。
--
--
-- 补的还是同一类洞：**接口早就在，只是管理端没有入口**。
--
--   订单      /galaxy/admin/orders/pay（人工确认到账）一直都在，用来补线下转账和
--             丢掉的渠道回调。但没有任何地方列得出订单 —— 运营手上是一个渠道流水号，
--             而那条接口要的是单号，中间没有桥。新的 GET /orders 按单号、下单人
--             **和流水号**都能找。
--   封禁名单  封禁记在设备指纹上（zt_galaxy_machine_ban），而唯一的解封入口
--             /node/ban 是按 node_id 找机器的。机器一旦从 zt_galaxy_node 里消失 ——
--             撤销、重装、换了 node_id —— 那个指纹再也没有入口碰得到：封禁成了
--             永久的，而且在管理端任何一页上都看不见。新的 /bans 直接认指纹。
--
-- 幂等，反复执行安全。
-- 库：manager-api 的 application.properties 里 sqlconn 指向的那个。


-- -------------------------------------------------------------------------
-- 1. 两个新页面
--
-- parent_id 按 code 反查分组，不写死自增 id。
-- created_time / updated_time 没有数据库默认值（GORM 在应用层填），必须显式写。
-- -------------------------------------------------------------------------

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxySupply') AS p), 'galaxyBans', '封禁名单', 'page', '', '', '/galaxy/bans', '', 59, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyBans') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyDemand') AS p), 'galaxyOrders', '订单', 'page', '', '', '/galaxy/orders', '', 62, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyOrders') AS t);

-- 订单插在算力密钥后面，原来排 62/63/64 的三页各往后挪一位。
-- 只改 sort_id，id 不动 —— 已有授权仍然指向同一条资源。
UPDATE zt_manager_resource SET sort_id = 63, updated_time = NOW(3) WHERE code = 'galaxyPoints';
UPDATE zt_manager_resource SET sort_id = 64, updated_time = NOW(3) WHERE code = 'galaxyPackages';
UPDATE zt_manager_resource SET sort_id = 65, updated_time = NOW(3) WHERE code = 'galaxyPricing';


-- -------------------------------------------------------------------------
-- 2. 三条新接口
--
-- code 不是起的，是算的 —— 必须与 manager.APIResourceCode(method, path) 逐字一致
-- （server/service/manager/routes.go:82）：小写方法名 + 路径按 '/' 换成 '.'。
-- -------------------------------------------------------------------------

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.orders', 'GET /api/galaxy/admin/orders', 'api', 'GET', '/api/galaxy/admin/orders', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.orders') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.bans', 'GET /api/galaxy/admin/bans', 'api', 'GET', '/api/galaxy/admin/bans', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.bans') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.bans.set', 'POST /api/galaxy/admin/bans/set', 'api', 'POST', '/api/galaxy/admin/bans/set', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.bans.set') AS t);


-- -------------------------------------------------------------------------
-- 3. 授权
--
-- 不写死 operator / viewer —— 后台上新建、改过的角色也要跟着走。
--
-- 3.1 读：谁看得见「节点与贡献」，谁就看得见这两页。
--     拿 galaxyNodes 当尺子而不是 galaxy 自己：galaxy 是菜单，withAncestors
--     会把它带给任何一个有子页面的角色，用它当尺子等于谁都给。
-- -------------------------------------------------------------------------

INSERT IGNORE INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT g.role_id, g.resource_id, NOW(3)
FROM (
  SELECT granted.role_id AS role_id, target.id AS resource_id
  FROM zt_manager_role_resource granted
  JOIN zt_manager_resource ruler ON ruler.id = granted.resource_id AND ruler.code = 'galaxyNodes'
  JOIN zt_manager_resource target ON target.code IN (
    'galaxyBans', 'galaxyOrders',
    'api.get.api.galaxy.admin.bans', 'api.get.api.galaxy.admin.orders'
  )
) AS g;

-- 3.2 写：用「能不能封禁机器」当尺子 —— 解封和封禁本来就该在同一批人手里。
--     只读角色一条都拿不到。

INSERT IGNORE INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT g.role_id, g.resource_id, NOW(3)
FROM (
  SELECT granted.role_id AS role_id, target.id AS resource_id
  FROM zt_manager_role_resource granted
  JOIN zt_manager_resource ruler ON ruler.id = granted.resource_id
    AND ruler.code = 'api.post.api.galaxy.admin.node.ban'
  JOIN zt_manager_resource target ON target.code = 'api.post.api.galaxy.admin.bans.set'
) AS g;


-- -------------------------------------------------------------------------
-- 4. 跑完还差一步：让 ACL 缓存失效
--
-- 权限判定走进程内缓存，一致性靠 Redis 里的版本号。直接改库不会碰这个版本号，
-- 已经跑着的 manager-api 会拿着旧缓存继续跑，上面这些资源与授权**不生效** ——
-- 现象是侧栏还是老样子，点进新页面 403。
--
--     redis-cli INCR manager:acl:version
--
-- 键名是 {manager.redis_namespace}:acl:version，namespace 缺省 manager，
-- 实际值见 server/manager-api/configs/application.properties。
-- 或者直接重启 manager-api。
-- -------------------------------------------------------------------------
