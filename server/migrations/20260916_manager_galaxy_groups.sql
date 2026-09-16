-- 共享算力池：侧栏加一层分组标题，并补上三个一直没有界面的页面。
--
-- 首选做法**不是**跑这份 SQL，而是：
--
--     cd server/manager-api && go run ./cmd/managerinit
--
-- 它把页面结构、接口资源、初始授权一次做完，内容与这份完全一致。
-- 这份只给「目标环境跑不了 managerinit」兜底。
--
--
-- 为什么改：
--
-- 子菜单铺到十一条的时候，「一块一个页面」这件事本身已经不解决问题了 —— 十一条
-- 平铺在侧栏里没有层级，找一页要从头扫一遍。再套一层要点开的目录也不对：
-- 那等于给每天都要开的页面加一次点击。所以中间加的是**分组标题**
-- （resource_type='group'）：它不是目录，不用点开，只是把一长条切成几段。
--
-- 分组按「运营在想什么」切，不按「数据存在哪张表」切 —— 找提现审批的人，
-- 想的是「供给侧那边的事」，不是「zt_galaxy_payout」。
--
--
-- 三个新页面补的是**后台做不了、只能进库手工改**的那些活：
--
--   提现审批  申请提交那一刻积分就从共享者账户里扣走了（先扣再建单，否则进程挂在
--             两步之间会白送一笔）。此前没有任何审批入口 —— 单子停在 pending，
--             那笔钱既不在用户手上、也没打出去，而手工 UPDATE 状态不会退积分。
--   价目表    zt_galaxy_price 一行都没有时，扣费与分成静默算 0：不报错、不告警，
--             只是账单永远是零。此前唯一的填表方式是初始化命令里写死的默认价。
--   销售线索  /galaxy/admin/portal/leads 这组接口一直都在，只是没有页面 ——
--             陌生人在门户上留的每一条询问都进了库，没有人看得见。
--
-- 资源 id 一律不动：改的是已有行的 parent_id 与 sort_id，新增的是分组与新页面。
-- 绝不删了重建 —— 重建会换掉 id，把 zt_manager_role_resource 里指向它的授权连根拔掉。
--
-- 幂等，反复执行安全。
-- 库：manager-api 的 application.properties 里 sqlconn 指向的那个。


-- -------------------------------------------------------------------------
-- 1. 五个分组标题
--
-- parent_id 按 code 反查 galaxy，不写死自增 id。
-- page_url 留空：分组不是页面，点它不该跳走。
-- created_time / updated_time 没有数据库默认值（GORM 在应用层填），必须显式写。
-- -------------------------------------------------------------------------

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxy') AS p), 'galaxyOverview', '总览', 'group', '', '', '', '', 51, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyOverview') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxy') AS p), 'galaxySupply', '算力供给', 'group', '', '', '', '', 55, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxySupply') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxy') AS p), 'galaxyDemand', '使用与计费', 'group', '', '', '', '', 60, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyDemand') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxy') AS p), 'galaxyCustomer', '客户与工单', 'group', '', '', '', '', 70, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyCustomer') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxy') AS p), 'galaxyPlatform', '门户与发布', 'group', '', '', '', '', 80, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyPlatform') AS t);


-- -------------------------------------------------------------------------
-- 2. 三个新页面
-- -------------------------------------------------------------------------

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxySupply') AS p), 'galaxyPayouts', '提现审批', 'page', '', '', '/galaxy/payouts', '', 57, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyPayouts') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyDemand') AS p), 'galaxyPricing', '价目表', 'page', '', '', '/galaxy/pricing', '', 64, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyPricing') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyCustomer') AS p), 'galaxyLeads', '销售线索', 'page', '', '', '/galaxy/leads', '', 73, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyLeads') AS t);


-- -------------------------------------------------------------------------
-- 3. 原来那十一个页面改挂到分组下
--
-- 只改 parent_id 与 sort_id，id 不动 —— 已有授权仍然指向同一条资源，
-- 谁原来看得见哪一页，改完还是看得见哪一页。
-- 用 JOIN 而不是 IN 子查询：MySQL 不允许 UPDATE 的子查询读同一张表（1093）。
-- -------------------------------------------------------------------------

UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxyOverview'
SET child.parent_id = parent.id,
    child.sort_id = CASE child.code WHEN 'galaxyPool' THEN 52 ELSE 53 END,
    child.updated_time = NOW(3)
WHERE child.code IN ('galaxyPool', 'galaxySettlement');

UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxySupply'
SET child.parent_id = parent.id,
    child.sort_id = CASE child.code WHEN 'galaxyNodes' THEN 56 ELSE 58 END,
    child.updated_time = NOW(3)
WHERE child.code IN ('galaxyNodes', 'galaxyProbes');

UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxyDemand'
SET child.parent_id = parent.id,
    child.sort_id = CASE child.code WHEN 'galaxyKeys' THEN 61 WHEN 'galaxyPoints' THEN 62 ELSE 63 END,
    child.updated_time = NOW(3)
WHERE child.code IN ('galaxyKeys', 'galaxyPoints', 'galaxyPackages');

UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxyCustomer'
SET child.parent_id = parent.id,
    child.sort_id = CASE child.code WHEN 'galaxyAccounts' THEN 71 ELSE 72 END,
    child.updated_time = NOW(3)
WHERE child.code IN ('galaxyAccounts', 'galaxyDisputes');

UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxyPlatform'
SET child.parent_id = parent.id,
    child.sort_id = CASE child.code WHEN 'galaxyModels' THEN 81 ELSE 82 END,
    child.updated_time = NOW(3)
WHERE child.code IN ('galaxyModels', 'galaxyBridgeReleases');


-- -------------------------------------------------------------------------
-- 4. 六条新接口
--
-- code 不是起的，是算的 —— 必须与 manager.APIResourceCode(method, path) 逐字一致
-- （server/service/manager/routes.go:82）：小写方法名 + 路径按 '/' 换成 '.'。
-- 对不上的话，下次谁跑一遍 managerinit 会按算出来的 code 再插一套，
-- 手写这批就变成没人指向的孤儿：后台上看着权限还在，实际全空。
-- -------------------------------------------------------------------------

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.payouts', 'GET /api/galaxy/admin/payouts', 'api', 'GET', '/api/galaxy/admin/payouts', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.payouts') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.payouts.handle', 'POST /api/galaxy/admin/payouts/handle', 'api', 'POST', '/api/galaxy/admin/payouts/handle', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.payouts.handle') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.payouts.account', 'POST /api/galaxy/admin/payouts/account', 'api', 'POST', '/api/galaxy/admin/payouts/account', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.payouts.account') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.prices', 'GET /api/galaxy/admin/prices', 'api', 'GET', '/api/galaxy/admin/prices', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.prices') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.prices.save', 'POST /api/galaxy/admin/prices/save', 'api', 'POST', '/api/galaxy/admin/prices/save', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.prices.save') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.prices.delete', 'POST /api/galaxy/admin/prices/delete', 'api', 'POST', '/api/galaxy/admin/prices/delete', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.prices.delete') AS t);


-- -------------------------------------------------------------------------
-- 5. 授权
--
-- 不写死 operator / viewer —— 后台上新建、改过的角色也要跟着走。
--
-- 5.1 提现审批与价目表：谁看得见「节点与贡献」，谁就看得见它们。
--     拿 galaxyNodes 当尺子而不是 galaxy 自己：galaxy 是菜单，withAncestors
--     会把它带给任何一个有子页面的角色，用它当尺子等于谁都给。
--
-- 分组标题不用授权：CurrentMenus 的 withAncestors 会把授权到的页面的祖先一起带出来。
-- 超级管理员也不用：它绕过资源过滤。
-- -------------------------------------------------------------------------

INSERT IGNORE INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT g.role_id, g.resource_id, NOW(3)
FROM (
  SELECT granted.role_id AS role_id, target.id AS resource_id
  FROM zt_manager_role_resource granted
  JOIN zt_manager_resource ruler ON ruler.id = granted.resource_id AND ruler.code = 'galaxyNodes'
  JOIN zt_manager_resource target ON target.code IN (
    'galaxyPayouts', 'galaxyPricing',
    'api.get.api.galaxy.admin.payouts', 'api.get.api.galaxy.admin.prices'
  )
) AS g;

-- 5.2 写接口只给「已经有别的写接口」的角色。
--     用「能不能裁决争议」当尺子：那同样是一个直接动钱的动作，
--     两者该在同一批人手里。只读角色一条都拿不到。

INSERT IGNORE INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT g.role_id, g.resource_id, NOW(3)
FROM (
  SELECT granted.role_id AS role_id, target.id AS resource_id
  FROM zt_manager_role_resource granted
  JOIN zt_manager_resource ruler ON ruler.id = granted.resource_id
    AND ruler.code = 'api.post.api.galaxy.admin.disputes.resolve'
  JOIN zt_manager_resource target ON target.code IN (
    'api.post.api.galaxy.admin.payouts.handle',
    'api.post.api.galaxy.admin.payouts.account',
    'api.post.api.galaxy.admin.prices.save',
    'api.post.api.galaxy.admin.prices.delete'
  )
) AS g;

-- 5.3 销售线索页面只给**已经拿得到线索接口**的角色。
--
--     里面是陌生人留下的手机与邮箱，那条 GET 接口初始化时就没给只读角色
--     （managerinit 的 viewerWithheld）。页面跟着接口走，两者不一致的结果是
--     菜单里留一个点进去必然报错的入口 —— 「看得见但打不开」比「看不见」更像故障。

INSERT IGNORE INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT g.role_id, g.resource_id, NOW(3)
FROM (
  SELECT granted.role_id AS role_id, target.id AS resource_id
  FROM zt_manager_role_resource granted
  JOIN zt_manager_resource ruler ON ruler.id = granted.resource_id
    AND ruler.code = 'api.get.api.galaxy.admin.portal.leads'
  JOIN zt_manager_resource target ON target.code = 'galaxyLeads'
) AS g;


-- -------------------------------------------------------------------------
-- 6. 跑完还差一步：让 ACL 缓存失效
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
