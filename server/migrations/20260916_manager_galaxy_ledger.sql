-- 共享算力池：补上「账本流水」页面。
--
-- 首选做法**不是**跑这份 SQL，而是：
--
--     cd server/manager-api && go run ./cmd/managerinit
--
-- 这份只给「目标环境跑不了 managerinit」兜底。
-- 前置：groups → orders_bans → ops → growth_risk → 这份，按顺序跑。
--
--
-- 结算汇总回答「这个月一共多少」，账本流水回答「那一笔是怎么记的」——
-- 对账、申诉，以及「平台这个月到底赚了多少」都要从这里查。
--
-- 三本账里**平台侧那本此前完全没有读的路**：抽成（fee）与坏账（baddebt）一直在写，
-- 而管理端任何一页都看不到它。毛利这个数，在库里有，在界面上不存在。
--
-- 另外三张表的 amount 是三个不同的量纲 —— 消费侧是计量数、供给侧是微积分、
-- 平台侧是微分 —— 页面按侧分开渲染，接口把量纲一路带到界面上。
--
-- 幂等，反复执行安全。
-- 库：manager-api 的 application.properties 里 sqlconn 指向的那个。


-- -------------------------------------------------------------------------
-- 1. 新页面，排在结算汇总后面
--
-- 后面两组整体往后挪一位给它让出 56。只改 sort_id，id 不动。
-- -------------------------------------------------------------------------

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyOverview') AS p), 'galaxyLedger', '账本流水', 'page', '', '', '/galaxy/ledger', '', 56, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyLedger') AS t);

UPDATE zt_manager_resource SET sort_id = 57, updated_time = NOW(3) WHERE code = 'galaxySupply';
UPDATE zt_manager_resource SET sort_id = 58, updated_time = NOW(3) WHERE code = 'galaxyNodes';
UPDATE zt_manager_resource SET sort_id = 59, updated_time = NOW(3) WHERE code = 'galaxyPayouts';
UPDATE zt_manager_resource SET sort_id = 60, updated_time = NOW(3) WHERE code = 'galaxyRisk';
UPDATE zt_manager_resource SET sort_id = 61, updated_time = NOW(3) WHERE code = 'galaxyProbes';
UPDATE zt_manager_resource SET sort_id = 62, updated_time = NOW(3) WHERE code = 'galaxyMismatches';
UPDATE zt_manager_resource SET sort_id = 63, updated_time = NOW(3) WHERE code = 'galaxyReputation';
UPDATE zt_manager_resource SET sort_id = 64, updated_time = NOW(3) WHERE code = 'galaxyBans';


-- -------------------------------------------------------------------------
-- 2. 一条新接口
-- -------------------------------------------------------------------------

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.ledger', 'GET /api/galaxy/admin/ledger', 'api', 'GET', '/api/galaxy/admin/ledger', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.ledger') AS t);


-- -------------------------------------------------------------------------
-- 3. 授权：跟着「结算汇总」走 —— 两页回答的是同一个问题的两个粒度。
-- -------------------------------------------------------------------------

INSERT IGNORE INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT g.role_id, g.resource_id, NOW(3)
FROM (
  SELECT granted.role_id AS role_id, target.id AS resource_id
  FROM zt_manager_role_resource granted
  JOIN zt_manager_resource ruler ON ruler.id = granted.resource_id AND ruler.code = 'galaxySettlement'
  JOIN zt_manager_resource target ON target.code IN ('galaxyLedger', 'api.get.api.galaxy.admin.ledger')
) AS g;


-- -------------------------------------------------------------------------
-- 4. 跑完还差一步：让 ACL 缓存失效
--
--     redis-cli INCR manager:acl:version
--
-- 或者直接重启 manager-api。
-- -------------------------------------------------------------------------
