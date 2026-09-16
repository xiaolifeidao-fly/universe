-- 共享算力池：管理端菜单与资源点，一份到位。
--
-- 这份是把 20260916 那六份（groups / orders_bans / ops / growth_risk / ledger /
-- settings）合成的**最终态**，不用按顺序跑六次，跑这一份就够。
--
-- 等价做法（更推荐，两者结果一致）：
--
--     cd server/manager-api && go run ./cmd/managerinit
--
-- 资源结构本来就是 managerinit 里手写的那份 UI 结构，这份 SQL 是从同一份源数据
-- 生成出来的。跑不了 Go 的环境才用它。
--
--
-- 做三件事：
--
--   1. 六个分组 + 十二个新页面建出来；原有十一个页面挪进分组、重排顺序
--   2. 十九条新接口登记成资源
--   3. 按「谁已经有 X 就一并给 Y」把授权补上
--
-- **原有页面一个都不删、id 一个都不换** —— 只改 parent_id / sort_id。
-- 删了重建会换掉自增 id，把 zt_manager_role_resource 里指向它的授权连根拔掉。
--
-- 没有 DELIMITER、没有存储过程：每一条都是独立的、以分号结尾的语句，
-- 图形客户端（DataGrip / Navicat / DBeaver）直接整份执行就行。
--
-- 幂等，反复执行安全：新增走 INSERT ... WHERE NOT EXISTS，已有的走 UPDATE 覆盖。
--
-- 库：manager-api 的 application.properties 里 sqlconn 指向的那个。


-- -------------------------------------------------------------------------
-- 1. 菜单：分组与页面
--
-- 先 INSERT（没有才建）再 UPDATE（一律覆盖）：新库上是建，老库上是把原有那十一
-- 条挪进分组。两步合起来等价于按 code 的 upsert，而 id 自始至终没动过。
--
-- 顺序不能乱：子节点要按 code 反查父节点的 id，父节点得先在。
-- created_time / updated_time 没有数据库默认值（GORM 在应用层填），必须显式写。
-- -------------------------------------------------------------------------

--  50  共享算力池
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'galaxy', '共享算力池', 'menu', '', '', '', 'GlobalOutlined', 50, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxy') AS t);
UPDATE zt_manager_resource
SET parent_id = 0, name = '共享算力池', resource_type = 'menu', page_url = '',
    icon = 'GlobalOutlined', sort_id = 50, status = 'active', updated_time = NOW(3)
WHERE code = 'galaxy';

--  51  总览
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxy') AS p), 'galaxyOverview', '总览', 'group', '', '', '', '', 51, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyOverview') AS t);
UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxy'
SET child.parent_id = parent.id, child.name = '总览', child.resource_type = 'group',
    child.page_url = '', child.sort_id = 51, child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxyOverview';

--  52  运营总览
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyOverview') AS p), 'galaxyHome', '运营总览', 'page', '', '', '/galaxy/overview', '', 52, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyHome') AS t);
UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxyOverview'
SET child.parent_id = parent.id, child.name = '运营总览', child.resource_type = 'page',
    child.page_url = '/galaxy/overview', child.sort_id = 52, child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxyHome';

--  53  池水位
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyOverview') AS p), 'galaxyPool', '池水位', 'page', '', '', '/galaxy/pool', '', 53, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyPool') AS t);
UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxyOverview'
SET child.parent_id = parent.id, child.name = '池水位', child.resource_type = 'page',
    child.page_url = '/galaxy/pool', child.sort_id = 53, child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxyPool';

--  54  运行工单
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyOverview') AS p), 'galaxyUnits', '运行工单', 'page', '', '', '/galaxy/units', '', 54, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyUnits') AS t);
UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxyOverview'
SET child.parent_id = parent.id, child.name = '运行工单', child.resource_type = 'page',
    child.page_url = '/galaxy/units', child.sort_id = 54, child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxyUnits';

--  55  结算汇总
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyOverview') AS p), 'galaxySettlement', '结算汇总', 'page', '', '', '/galaxy/settlement', '', 55, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxySettlement') AS t);
UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxyOverview'
SET child.parent_id = parent.id, child.name = '结算汇总', child.resource_type = 'page',
    child.page_url = '/galaxy/settlement', child.sort_id = 55, child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxySettlement';

--  56  账本流水
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyOverview') AS p), 'galaxyLedger', '账本流水', 'page', '', '', '/galaxy/ledger', '', 56, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyLedger') AS t);
UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxyOverview'
SET child.parent_id = parent.id, child.name = '账本流水', child.resource_type = 'page',
    child.page_url = '/galaxy/ledger', child.sort_id = 56, child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxyLedger';

--  57  算力供给
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxy') AS p), 'galaxySupply', '算力供给', 'group', '', '', '', '', 57, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxySupply') AS t);
UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxy'
SET child.parent_id = parent.id, child.name = '算力供给', child.resource_type = 'group',
    child.page_url = '', child.sort_id = 57, child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxySupply';

--  58  节点与贡献
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxySupply') AS p), 'galaxyNodes', '节点与贡献', 'page', '', '', '/galaxy/nodes', '', 58, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyNodes') AS t);
UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxySupply'
SET child.parent_id = parent.id, child.name = '节点与贡献', child.resource_type = 'page',
    child.page_url = '/galaxy/nodes', child.sort_id = 58, child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxyNodes';

--  59  提现审批
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxySupply') AS p), 'galaxyPayouts', '提现审批', 'page', '', '', '/galaxy/payouts', '', 59, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyPayouts') AS t);
UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxySupply'
SET child.parent_id = parent.id, child.name = '提现审批', child.resource_type = 'page',
    child.page_url = '/galaxy/payouts', child.sort_id = 59, child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxyPayouts';

--  60  风控与审计
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxy') AS p), 'galaxyRisk', '风控与审计', 'group', '', '', '', '', 60, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyRisk') AS t);
UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxy'
SET child.parent_id = parent.id, child.name = '风控与审计', child.resource_type = 'group',
    child.page_url = '', child.sort_id = 60, child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxyRisk';

--  61  抽检
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyRisk') AS p), 'galaxyProbes', '抽检', 'page', '', '', '/galaxy/probes', '', 61, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyProbes') AS t);
UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxyRisk'
SET child.parent_id = parent.id, child.name = '抽检', child.resource_type = 'page',
    child.page_url = '/galaxy/probes', child.sort_id = 61, child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxyProbes';

--  62  用量偏差
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyRisk') AS p), 'galaxyMismatches', '用量偏差', 'page', '', '', '/galaxy/mismatches', '', 62, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyMismatches') AS t);
UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxyRisk'
SET child.parent_id = parent.id, child.name = '用量偏差', child.resource_type = 'page',
    child.page_url = '/galaxy/mismatches', child.sort_id = 62, child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxyMismatches';

--  63  信誉
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyRisk') AS p), 'galaxyReputation', '信誉', 'page', '', '', '/galaxy/reputation', '', 63, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyReputation') AS t);
UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxyRisk'
SET child.parent_id = parent.id, child.name = '信誉', child.resource_type = 'page',
    child.page_url = '/galaxy/reputation', child.sort_id = 63, child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxyReputation';

--  64  封禁名单
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyRisk') AS p), 'galaxyBans', '封禁名单', 'page', '', '', '/galaxy/bans', '', 64, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyBans') AS t);
UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxyRisk'
SET child.parent_id = parent.id, child.name = '封禁名单', child.resource_type = 'page',
    child.page_url = '/galaxy/bans', child.sort_id = 64, child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxyBans';

--  65  使用与计费
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxy') AS p), 'galaxyDemand', '使用与计费', 'group', '', '', '', '', 65, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyDemand') AS t);
UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxy'
SET child.parent_id = parent.id, child.name = '使用与计费', child.resource_type = 'group',
    child.page_url = '', child.sort_id = 65, child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxyDemand';

--  66  算力密钥
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyDemand') AS p), 'galaxyKeys', '算力密钥', 'page', '', '', '/galaxy/keys', '', 66, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyKeys') AS t);
UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxyDemand'
SET child.parent_id = parent.id, child.name = '算力密钥', child.resource_type = 'page',
    child.page_url = '/galaxy/keys', child.sort_id = 66, child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxyKeys';

--  67  订单
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyDemand') AS p), 'galaxyOrders', '订单', 'page', '', '', '/galaxy/orders', '', 67, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyOrders') AS t);
UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxyDemand'
SET child.parent_id = parent.id, child.name = '订单', child.resource_type = 'page',
    child.page_url = '/galaxy/orders', child.sort_id = 67, child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxyOrders';

--  68  积分充值
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyDemand') AS p), 'galaxyPoints', '积分充值', 'page', '', '', '/galaxy/points', '', 68, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyPoints') AS t);
UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxyDemand'
SET child.parent_id = parent.id, child.name = '积分充值', child.resource_type = 'page',
    child.page_url = '/galaxy/points', child.sort_id = 68, child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxyPoints';

--  69  额度包
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyDemand') AS p), 'galaxyPackages', '额度包', 'page', '', '', '/galaxy/packages', '', 69, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyPackages') AS t);
UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxyDemand'
SET child.parent_id = parent.id, child.name = '额度包', child.resource_type = 'page',
    child.page_url = '/galaxy/packages', child.sort_id = 69, child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxyPackages';

--  70  价目表
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyDemand') AS p), 'galaxyPricing', '价目表', 'page', '', '', '/galaxy/pricing', '', 70, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyPricing') AS t);
UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxyDemand'
SET child.parent_id = parent.id, child.name = '价目表', child.resource_type = 'page',
    child.page_url = '/galaxy/pricing', child.sort_id = 70, child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxyPricing';

--  71  客户与增长
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxy') AS p), 'galaxyCustomer', '客户与增长', 'group', '', '', '', '', 71, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyCustomer') AS t);
UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxy'
SET child.parent_id = parent.id, child.name = '客户与增长', child.resource_type = 'group',
    child.page_url = '', child.sort_id = 71, child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxyCustomer';

--  72  账号
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyCustomer') AS p), 'galaxyAccounts', '账号', 'page', '', '', '/galaxy/accounts', '', 72, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyAccounts') AS t);
UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxyCustomer'
SET child.parent_id = parent.id, child.name = '账号', child.resource_type = 'page',
    child.page_url = '/galaxy/accounts', child.sort_id = 72, child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxyAccounts';

--  73  争议工单
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyCustomer') AS p), 'galaxyDisputes', '争议工单', 'page', '', '', '/galaxy/disputes', '', 73, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyDisputes') AS t);
UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxyCustomer'
SET child.parent_id = parent.id, child.name = '争议工单', child.resource_type = 'page',
    child.page_url = '/galaxy/disputes', child.sort_id = 73, child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxyDisputes';

--  74  销售线索
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyCustomer') AS p), 'galaxyLeads', '销售线索', 'page', '', '', '/galaxy/leads', '', 74, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyLeads') AS t);
UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxyCustomer'
SET child.parent_id = parent.id, child.name = '销售线索', child.resource_type = 'page',
    child.page_url = '/galaxy/leads', child.sort_id = 74, child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxyLeads';

--  75  邀请返现
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyCustomer') AS p), 'galaxyReferrals', '邀请返现', 'page', '', '', '/galaxy/referrals', '', 75, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyReferrals') AS t);
UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxyCustomer'
SET child.parent_id = parent.id, child.name = '邀请返现', child.resource_type = 'page',
    child.page_url = '/galaxy/referrals', child.sort_id = 75, child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxyReferrals';

--  80  平台设置
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxy') AS p), 'galaxyPlatform', '平台设置', 'group', '', '', '', '', 80, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyPlatform') AS t);
UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxy'
SET child.parent_id = parent.id, child.name = '平台设置', child.resource_type = 'group',
    child.page_url = '', child.sort_id = 80, child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxyPlatform';

--  81  运行参数
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyPlatform') AS p), 'galaxySettings', '运行参数', 'page', '', '', '/galaxy/settings', '', 81, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxySettings') AS t);
UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxyPlatform'
SET child.parent_id = parent.id, child.name = '运行参数', child.resource_type = 'page',
    child.page_url = '/galaxy/settings', child.sort_id = 81, child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxySettings';

--  82  模型目录
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyPlatform') AS p), 'galaxyModels', '模型目录', 'page', '', '', '/galaxy/models', '', 82, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyModels') AS t);
UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxyPlatform'
SET child.parent_id = parent.id, child.name = '模型目录', child.resource_type = 'page',
    child.page_url = '/galaxy/models', child.sort_id = 82, child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxyModels';

--  83  ai-bridge 版本
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyPlatform') AS p), 'galaxyBridgeReleases', 'ai-bridge 版本', 'page', '', '', '/galaxy/bridge-releases', '', 83, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyBridgeReleases') AS t);
UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxyPlatform'
SET child.parent_id = parent.id, child.name = 'ai-bridge 版本', child.resource_type = 'page',
    child.page_url = '/galaxy/bridge-releases', child.sort_id = 83, child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxyBridgeReleases';

-- -------------------------------------------------------------------------
-- 2. 十九条新接口
--
-- code 不是起的，是算的 —— 必须与 manager.APIResourceCode(method, path) 逐字一致
-- （server/service/manager/routes.go:82）：小写方法名 + 路径按 '/' 换成 '.'。
-- 下面这批是用那个函数真跑出来的。对不上的话，下次谁跑一遍 managerinit 会按算出来
-- 的 code 再插一套，手写这批就变成没人指向的孤儿：后台上看着权限还在，实际全空。
-- -------------------------------------------------------------------------

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.overview', 'GET /api/galaxy/admin/overview', 'api', 'GET', '/api/galaxy/admin/overview', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.overview') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.units', 'GET /api/galaxy/admin/units', 'api', 'GET', '/api/galaxy/admin/units', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.units') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.units.cancel', 'POST /api/galaxy/admin/units/cancel', 'api', 'POST', '/api/galaxy/admin/units/cancel', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.units.cancel') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.ledger', 'GET /api/galaxy/admin/ledger', 'api', 'GET', '/api/galaxy/admin/ledger', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.ledger') AS t);

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
SELECT 0, 'api.get.api.galaxy.admin.mismatches', 'GET /api/galaxy/admin/mismatches', 'api', 'GET', '/api/galaxy/admin/mismatches', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.mismatches') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.reputations', 'GET /api/galaxy/admin/reputations', 'api', 'GET', '/api/galaxy/admin/reputations', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.reputations') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.reputations.set', 'POST /api/galaxy/admin/reputations/set', 'api', 'POST', '/api/galaxy/admin/reputations/set', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.reputations.set') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.bans', 'GET /api/galaxy/admin/bans', 'api', 'GET', '/api/galaxy/admin/bans', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.bans') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.bans.set', 'POST /api/galaxy/admin/bans/set', 'api', 'POST', '/api/galaxy/admin/bans/set', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.bans.set') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.orders', 'GET /api/galaxy/admin/orders', 'api', 'GET', '/api/galaxy/admin/orders', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.orders') AS t);

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

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.referrals', 'GET /api/galaxy/admin/referrals', 'api', 'GET', '/api/galaxy/admin/referrals', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.referrals') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.settings', 'GET /api/galaxy/admin/settings', 'api', 'GET', '/api/galaxy/admin/settings', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.settings') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.settings.save', 'POST /api/galaxy/admin/settings/save', 'api', 'POST', '/api/galaxy/admin/settings/save', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.settings.save') AS t);

-- -------------------------------------------------------------------------
-- 3. 授权
--
-- 不写死 operator / viewer —— 后台上新建、改过的角色也要跟着走。
-- 规则一律是「谁已经有那把尺子，就一并给这些」。
--
-- 分组本身不用授权：CurrentMenus 的 withAncestors 会把授权到的页面的祖先一起带出来。
-- 超级管理员也不用：它绕过资源过滤。
--
-- 最外层套一层派生表：MySQL 不允许 INSERT ... SELECT 直接读目标表，会报 1093。
-- INSERT IGNORE 吃掉唯一键冲突，这就是重复执行时的幂等。
-- -------------------------------------------------------------------------

-- 尺子：galaxyPool
-- 运营总览、运行工单、用量偏差 —— 和池水位回答的是同一类问题
INSERT IGNORE INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT g.role_id, g.resource_id, NOW(3)
FROM (
  SELECT granted.role_id AS role_id, target.id AS resource_id
  FROM zt_manager_role_resource granted
  JOIN zt_manager_resource ruler ON ruler.id = granted.resource_id AND ruler.code = 'galaxyPool'
  JOIN zt_manager_resource target ON target.code IN (
    'galaxyHome',
    'galaxyUnits',
    'galaxyMismatches',
    'api.get.api.galaxy.admin.overview',
    'api.get.api.galaxy.admin.units',
    'api.get.api.galaxy.admin.mismatches'
  )
) AS g;

-- 尺子：galaxySettlement
-- 账本流水是结算汇总的逐笔粒度
INSERT IGNORE INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT g.role_id, g.resource_id, NOW(3)
FROM (
  SELECT granted.role_id AS role_id, target.id AS resource_id
  FROM zt_manager_role_resource granted
  JOIN zt_manager_resource ruler ON ruler.id = granted.resource_id AND ruler.code = 'galaxySettlement'
  JOIN zt_manager_resource target ON target.code IN (
    'galaxyLedger',
    'api.get.api.galaxy.admin.ledger'
  )
) AS g;

-- 尺子：galaxyNodes
-- 拿 galaxyNodes 当尺子而不是 galaxy 本身：galaxy 是菜单，withAncestors 会把它带给任何一个有子页面的角色，用它当尺子等于谁都给
INSERT IGNORE INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT g.role_id, g.resource_id, NOW(3)
FROM (
  SELECT granted.role_id AS role_id, target.id AS resource_id
  FROM zt_manager_role_resource granted
  JOIN zt_manager_resource ruler ON ruler.id = granted.resource_id AND ruler.code = 'galaxyNodes'
  JOIN zt_manager_resource target ON target.code IN (
    'galaxyPayouts',
    'galaxyPricing',
    'galaxyBans',
    'galaxyOrders',
    'galaxyReputation',
    'galaxyReferrals',
    'api.get.api.galaxy.admin.payouts',
    'api.get.api.galaxy.admin.prices',
    'api.get.api.galaxy.admin.bans',
    'api.get.api.galaxy.admin.orders',
    'api.get.api.galaxy.admin.reputations',
    'api.get.api.galaxy.admin.referrals'
  )
) AS g;

-- 尺子：galaxyModels
-- 运行参数和模型目录同属平台级配置
INSERT IGNORE INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT g.role_id, g.resource_id, NOW(3)
FROM (
  SELECT granted.role_id AS role_id, target.id AS resource_id
  FROM zt_manager_role_resource granted
  JOIN zt_manager_resource ruler ON ruler.id = granted.resource_id AND ruler.code = 'galaxyModels'
  JOIN zt_manager_resource target ON target.code IN (
    'galaxySettings',
    'api.get.api.galaxy.admin.settings'
  )
) AS g;

-- 尺子：api.get.api.galaxy.admin.portal.leads
-- 页面跟着接口走：线索里是陌生人的手机邮箱，那条 GET 初始化时就没给只读角色。只挡接口不挡页面，菜单里会留一个点进去必然 403 的入口
INSERT IGNORE INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT g.role_id, g.resource_id, NOW(3)
FROM (
  SELECT granted.role_id AS role_id, target.id AS resource_id
  FROM zt_manager_role_resource granted
  JOIN zt_manager_resource ruler ON ruler.id = granted.resource_id AND ruler.code = 'api.get.api.galaxy.admin.portal.leads'
  JOIN zt_manager_resource target ON target.code = 'galaxyLeads'
) AS g;

-- 尺子：api.post.api.galaxy.admin.disputes.resolve
-- 裁决争议同样是直接动钱的动作，这几件该在同一批人手里
INSERT IGNORE INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT g.role_id, g.resource_id, NOW(3)
FROM (
  SELECT granted.role_id AS role_id, target.id AS resource_id
  FROM zt_manager_role_resource granted
  JOIN zt_manager_resource ruler ON ruler.id = granted.resource_id AND ruler.code = 'api.post.api.galaxy.admin.disputes.resolve'
  JOIN zt_manager_resource target ON target.code IN (
    'api.post.api.galaxy.admin.payouts.handle',
    'api.post.api.galaxy.admin.payouts.account',
    'api.post.api.galaxy.admin.prices.save',
    'api.post.api.galaxy.admin.prices.delete'
  )
) AS g;

-- 尺子：api.post.api.galaxy.admin.node.ban
-- 解封、强制取消、改信誉都决定一台机器还能不能干活
INSERT IGNORE INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT g.role_id, g.resource_id, NOW(3)
FROM (
  SELECT granted.role_id AS role_id, target.id AS resource_id
  FROM zt_manager_role_resource granted
  JOIN zt_manager_resource ruler ON ruler.id = granted.resource_id AND ruler.code = 'api.post.api.galaxy.admin.node.ban'
  JOIN zt_manager_resource target ON target.code IN (
    'api.post.api.galaxy.admin.bans.set',
    'api.post.api.galaxy.admin.units.cancel',
    'api.post.api.galaxy.admin.reputations.set'
  )
) AS g;

-- 尺子：api.post.api.galaxy.admin.referral.settings.save
-- 同样是改完立刻影响所有人的开关
INSERT IGNORE INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT g.role_id, g.resource_id, NOW(3)
FROM (
  SELECT granted.role_id AS role_id, target.id AS resource_id
  FROM zt_manager_role_resource granted
  JOIN zt_manager_resource ruler ON ruler.id = granted.resource_id AND ruler.code = 'api.post.api.galaxy.admin.referral.settings.save'
  JOIN zt_manager_resource target ON target.code = 'api.post.api.galaxy.admin.settings.save'
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
-- 实际值见 server/manager-api/configs/application.properties。或者直接重启 manager-api。
-- -------------------------------------------------------------------------
-- 5. 自检
--
--   菜单应当是 30 行（1 菜单 + 6 分组 + 23 页面）：
--     SELECT p.code AS grp, r.code, r.name, r.resource_type, r.page_url, r.sort_id
--     FROM zt_manager_resource r
--     LEFT JOIN zt_manager_resource p ON p.id = r.parent_id
--     WHERE r.code LIKE 'galaxy%' AND r.resource_type <> 'api'
--     ORDER BY r.sort_id;
--
--   接口应当是 46 条（原有 27 + 新增 19）：
--     SELECT COUNT(*) FROM zt_manager_resource
--     WHERE code LIKE 'api.%.api.galaxy.admin.%' AND status = 'active';
-- -------------------------------------------------------------------------
