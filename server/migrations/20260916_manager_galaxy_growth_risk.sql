-- 共享算力池：补上「邀请返现」「信誉」两个页面，并把风控四页单独分成一组。
--
-- 首选做法**不是**跑这份 SQL，而是：
--
--     cd server/manager-api && go run ./cmd/managerinit
--
-- 这份只给「目标环境跑不了 managerinit」兜底。
-- 前置：groups → orders_bans → ops → 这份，按顺序跑。
--
--
--   邀请返现  此前管理端只有一个「默认比例」开关，**返出去的钱一分都看不见**：
--             谁在真的带量、平台为这个活动付了多少，都答不上来。一个开着的活动，
--             钱在流出而没人看得见流向。两端各一套码，页面上先选端。
--   信誉      此前只在节点列表旁边露一个派生分数。两个问题：被扣分的主体不一定还在
--             那张列表上（机器撤销、重装之后 device: 那份就没入口了，和封禁名单同一个
--             毛病）；而且没有任何地方能把分数改回去 —— 一次抽检误判够那台机器少接好几天单。
--
-- 分组调整：抽检、用量偏差、信誉、封禁名单挪进新的「风控与审计」。
-- 前两个是「发现」，后两个是「处置」，办的是同一件事；混在算力供给里会被当成
-- 日常运维顺手翻的东西。「客户与工单」同时改名「客户与增长」，邀请返现挂进去。
--
-- 资源 id 一律不动：改的是 parent_id / name / sort_id。
-- 幂等，反复执行安全。
-- 库：manager-api 的 application.properties 里 sqlconn 指向的那个。


-- -------------------------------------------------------------------------
-- 1. 新分组与两个新页面
-- -------------------------------------------------------------------------

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxy') AS p), 'galaxyRisk', '风控与审计', 'group', '', '', '', '', 59, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyRisk') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyRisk') AS p), 'galaxyReputation', '信誉', 'page', '', '', '/galaxy/reputation', '', 62, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyReputation') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyCustomer') AS p), 'galaxyReferrals', '邀请返现', 'page', '', '', '/galaxy/referrals', '', 75, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyReferrals') AS t);


-- -------------------------------------------------------------------------
-- 2. 三页挪进风控组
--
-- 用 JOIN 而不是 IN 子查询：MySQL 不允许 UPDATE 的子查询读同一张表（1093）。
-- -------------------------------------------------------------------------

UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxyRisk'
SET child.parent_id = parent.id,
    child.sort_id = CASE child.code WHEN 'galaxyProbes' THEN 60 WHEN 'galaxyMismatches' THEN 61 ELSE 63 END,
    child.updated_time = NOW(3)
WHERE child.code IN ('galaxyProbes', 'galaxyMismatches', 'galaxyBans');

-- 客户与工单 → 客户与增长，整组往后挪一位给风控组让出 59。
UPDATE zt_manager_resource SET name = '客户与增长', sort_id = 71, updated_time = NOW(3) WHERE code = 'galaxyCustomer';
UPDATE zt_manager_resource SET sort_id = 72, updated_time = NOW(3) WHERE code = 'galaxyAccounts';
UPDATE zt_manager_resource SET sort_id = 73, updated_time = NOW(3) WHERE code = 'galaxyDisputes';
UPDATE zt_manager_resource SET sort_id = 74, updated_time = NOW(3) WHERE code = 'galaxyLeads';


-- -------------------------------------------------------------------------
-- 3. 三条新接口
--
-- code 必须与 manager.APIResourceCode(method, path) 逐字一致
-- （server/service/manager/routes.go:82）。
-- -------------------------------------------------------------------------

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.referrals', 'GET /api/galaxy/admin/referrals', 'api', 'GET', '/api/galaxy/admin/referrals', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.referrals') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.reputations', 'GET /api/galaxy/admin/reputations', 'api', 'GET', '/api/galaxy/admin/reputations', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.reputations') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.reputations.set', 'POST /api/galaxy/admin/reputations/set', 'api', 'POST', '/api/galaxy/admin/reputations/set', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.reputations.set') AS t);


-- -------------------------------------------------------------------------
-- 4. 授权
--
-- 4.1 读：跟着「节点与贡献」走。风控组本身不用授权 —— withAncestors 会带出来。
-- -------------------------------------------------------------------------

INSERT IGNORE INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT g.role_id, g.resource_id, NOW(3)
FROM (
  SELECT granted.role_id AS role_id, target.id AS resource_id
  FROM zt_manager_role_resource granted
  JOIN zt_manager_resource ruler ON ruler.id = granted.resource_id AND ruler.code = 'galaxyNodes'
  JOIN zt_manager_resource target ON target.code IN (
    'galaxyReputation', 'galaxyReferrals',
    'api.get.api.galaxy.admin.reputations', 'api.get.api.galaxy.admin.referrals'
  )
) AS g;

-- 4.2 写：改信誉直接决定一台机器还能不能接到单，跟着「能不能封禁机器」走。

INSERT IGNORE INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT g.role_id, g.resource_id, NOW(3)
FROM (
  SELECT granted.role_id AS role_id, target.id AS resource_id
  FROM zt_manager_role_resource granted
  JOIN zt_manager_resource ruler ON ruler.id = granted.resource_id
    AND ruler.code = 'api.post.api.galaxy.admin.node.ban'
  JOIN zt_manager_resource target ON target.code = 'api.post.api.galaxy.admin.reputations.set'
) AS g;


-- -------------------------------------------------------------------------
-- 5. 跑完还差一步：让 ACL 缓存失效
--
--     redis-cli INCR manager:acl:version
--
-- 键名是 {manager.redis_namespace}:acl:version，namespace 缺省 manager。
-- 或者直接重启 manager-api。
-- -------------------------------------------------------------------------
