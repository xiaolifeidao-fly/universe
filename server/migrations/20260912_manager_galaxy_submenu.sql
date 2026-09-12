-- 共享算力池：页签条改成侧栏子菜单。
--
-- 原来十一块内容（池水位、节点、账号、抽检、争议、额度包、模型、积分、密钥、
-- 结算、ai-bridge 版本）全挤在 /galaxy 一个页面的 Tabs 里。排到第十一个，页签条
-- 已经不是导航了 —— 找一块要先扫一遍横条，而横条上没有层级也记不住位置。
-- 现在一块一个页面，挂在「共享算力池」这个**菜单**底下。
--
-- 所以 galaxy 这一行从 page 变成 menu：菜单自己不是页面，page_url 清空。
-- 前端 buildMenuItems 按 resource_type 分叉 —— 还是 page 的话，它仍然渲染成
-- 一个叶子节点，十一个子页面一个都出不来。
--
-- 资源 id 一律不动：改的是这一行的字段，新增的是十一行子页面。绝不删了重建 ——
-- 重建会换掉 id，把 zt_manager_role_resource 里指向它的授权连根拔掉。
--
-- 幂等，反复执行安全。
-- 库：manager-api 的 application.properties 里 sqlconn 指向的那个。
--
-- 等价做法（更推荐，两者结果一致）：
--
--     cd server/manager-api && go run ./cmd/managerinit


-- -------------------------------------------------------------------------
-- 1. 共享算力池：page → menu
--
-- 先补一行再改，这份 SQL 才能在没跑过 manager_seed.sql 的库上单独执行。
-- -------------------------------------------------------------------------

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'galaxy', '共享算力池', 'menu', '', '', '', 'GlobalOutlined', 50, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxy') AS t);

UPDATE zt_manager_resource
SET resource_type = 'menu', page_url = '', updated_time = NOW(3)
WHERE code = 'galaxy';


-- -------------------------------------------------------------------------
-- 2. 十一个子页面
--
-- code 是稳定标识，前端按 t("nav." + code) 取文案 —— 改它等于改文案键，
-- 对应 client/manager/src/i18n/LocaleProvider.tsx 里的 nav.galaxyXxx。
-- name 只在文案键查不到时兜底（后台改得动的是它）。
--
-- sort_id 接着 galaxy 的 50 往下排，顺序就是原来页签条从左到右的顺序 ——
-- 运营的点击习惯不被打乱。
-- parent_id 按 code 反查，不写死自增 id。
-- created_time / updated_time 没有数据库默认值（GORM 在应用层填），必须显式写。
-- -------------------------------------------------------------------------

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxy') AS p), 'galaxyPool', '池水位', 'page', '', '', '/galaxy/pool', '', 51, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyPool') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxy') AS p), 'galaxyNodes', '节点与贡献', 'page', '', '', '/galaxy/nodes', '', 52, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyNodes') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxy') AS p), 'galaxyAccounts', '账号', 'page', '', '', '/galaxy/accounts', '', 53, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyAccounts') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxy') AS p), 'galaxyProbes', '抽检', 'page', '', '', '/galaxy/probes', '', 54, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyProbes') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxy') AS p), 'galaxyDisputes', '争议工单', 'page', '', '', '/galaxy/disputes', '', 55, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyDisputes') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxy') AS p), 'galaxyPackages', '额度包', 'page', '', '', '/galaxy/packages', '', 56, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyPackages') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxy') AS p), 'galaxyModels', '模型目录', 'page', '', '', '/galaxy/models', '', 57, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyModels') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxy') AS p), 'galaxyPoints', '积分充值', 'page', '', '', '/galaxy/points', '', 58, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyPoints') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxy') AS p), 'galaxyKeys', '算力密钥', 'page', '', '', '/galaxy/keys', '', 59, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyKeys') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxy') AS p), 'galaxySettlement', '结算汇总', 'page', '', '', '/galaxy/settlement', '', 60, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxySettlement') AS t);

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxy') AS p), 'galaxyBridgeReleases', 'ai-bridge 版本', 'page', '', '', '/galaxy/bridge-releases', '', 61, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyBridgeReleases') AS t);


-- -------------------------------------------------------------------------
-- 3. 授权：谁原来看得见共享算力池，谁就看得见这十一个子页面
--
-- 不写死 operator / viewer —— 后台上新建、改过的角色也要跟着走。原来授权到
-- galaxy 的每一个角色，这里照着补一份到它的全部子页面。
--
-- 少了这一步，运营看到的是一个点开空无一物的目录：CurrentMenus 按角色过滤，
-- 授权不到的子页面一条都不返回，而没有有效子节点的菜单前端直接剪掉 ——
-- 现象是「共享算力池整个从侧栏消失了」。
--
-- galaxy 自己那条授权留着不动：它现在是菜单，withAncestors 本来也会把它带出来，
-- 多一条不碍事，撤掉反而会误伤手工配过授权的角色。
--
-- 最外层套一层派生表：MySQL 不允许 INSERT ... SELECT 直接读目标表，会报 1093。
-- INSERT IGNORE 吃掉唯一键冲突，这就是重复执行时的幂等。
-- 超级管理员不在其中 —— 它绕过资源过滤，给它记授权是多余的。
-- -------------------------------------------------------------------------

INSERT IGNORE INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT g.role_id, g.resource_id, NOW(3)
FROM (
  SELECT granted.role_id AS role_id, child.id AS resource_id
  FROM zt_manager_role_resource granted
  JOIN zt_manager_resource parent ON parent.id = granted.resource_id AND parent.code = 'galaxy'
  JOIN zt_manager_resource child ON child.parent_id = parent.id AND child.status = 'active'
) AS g;


-- -------------------------------------------------------------------------
-- 4. 跑完还差一步：让 ACL 缓存失效
--
-- 权限判定走进程内缓存，一致性靠 Redis 里的版本号。直接改库不会碰这个版本号，
-- 已经跑着的 manager-api 会拿着旧缓存继续跑，上面这些资源与授权**不生效** ——
-- 现象是侧栏还是老样子，点进子页面 403。
--
--     redis-cli INCR manager:acl:version
--
-- 键名是 {manager.redis_namespace}:acl:version，namespace 缺省 manager，
-- 实际值见 server/manager-api/configs/application.properties。
-- 或者直接重启 manager-api。
-- -------------------------------------------------------------------------
