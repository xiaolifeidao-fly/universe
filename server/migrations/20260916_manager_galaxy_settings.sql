-- 共享算力池：补上「运行参数」页面。
--
-- 首选做法**不是**跑这份 SQL，而是：
--
--     cd server/manager-api && go run ./cmd/managerinit
--
-- 这份只给「目标环境跑不了 managerinit」兜底。
-- 前置：groups → orders_bans → ops → growth_risk → ledger → 这份，按顺序跑。
--
--
-- 把原本只在 application.properties 里的那批可调值搬进后台。改一个起提金额
-- 原来要登服务器、改文件、重启进程，而重启期间在跑的请求全断。
--
-- 生效方式是**进程内快照 + 定期回查**（service/galaxy/settings.go），不是重启：
-- galaxy-api、hub、consumer-api、manager-api 各自每十几秒回查一次
-- zt_galaxy_setting，读路径本身不碰数据库。所以改完最多十几秒全部生效，
-- 界面上把这个秒数原样显示给运营看。
--
-- **不搬的那些**，理由各不相同：
--   galaxy.instance / consumer_base_url / provider_hub_url / bridge_download_base_url
--   / referral_register_url  部署地址，改了本来就要重新部署
--   galaxy.key_cipher_secret / bridge_release.public_keys  密钥材料
--   galaxy.contract_version  编译期契约，节点按它握手
--   galaxy.heartbeat_timeout_ms  判「在线 / 离线」的那条线
--   galaxy.payout_rate  不是策略，是量纲定义（多少微积分等于一块钱）
--
-- 这份 SQL **不写任何参数值**：一行都不插，各环境就继续用自己配置文件里的值。
-- 预先塞一套「默认值」进去，等于把所有环境的参数按一套数字对齐，
-- 而那套数字未必适合谁。
--
-- 幂等，反复执行安全。
-- 库：manager-api 的 application.properties 里 sqlconn 指向的那个。


-- -------------------------------------------------------------------------
-- 1. 新页面，放在「平台设置」组（原「门户与发布」）的第一位
-- -------------------------------------------------------------------------

UPDATE zt_manager_resource SET name = '平台设置', updated_time = NOW(3) WHERE code = 'galaxyPlatform';

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyPlatform') AS p), 'galaxySettings', '运行参数', 'page', '', '', '/galaxy/settings', '', 81, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxySettings') AS t);

UPDATE zt_manager_resource SET sort_id = 82, updated_time = NOW(3) WHERE code = 'galaxyModels';
UPDATE zt_manager_resource SET sort_id = 83, updated_time = NOW(3) WHERE code = 'galaxyBridgeReleases';


-- -------------------------------------------------------------------------
-- 2. 两条新接口
-- -------------------------------------------------------------------------

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
-- 3.1 读：跟着「模型目录」走 —— 同一组里的平台级配置。
-- -------------------------------------------------------------------------

INSERT IGNORE INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT g.role_id, g.resource_id, NOW(3)
FROM (
  SELECT granted.role_id AS role_id, target.id AS resource_id
  FROM zt_manager_role_resource granted
  JOIN zt_manager_resource ruler ON ruler.id = granted.resource_id AND ruler.code = 'galaxyModels'
  JOIN zt_manager_resource target ON target.code IN ('galaxySettings', 'api.get.api.galaxy.admin.settings')
) AS g;

-- 3.2 写：这批值直接决定池子怎么跑 —— 一个填错的等待上限能让全站请求在排到之前
--     就超时。跟着「能不能改返现比例」走：那同样是一个改完立刻影响所有人的开关。

INSERT IGNORE INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT g.role_id, g.resource_id, NOW(3)
FROM (
  SELECT granted.role_id AS role_id, target.id AS resource_id
  FROM zt_manager_role_resource granted
  JOIN zt_manager_resource ruler ON ruler.id = granted.resource_id
    AND ruler.code = 'api.post.api.galaxy.admin.referral.settings.save'
  JOIN zt_manager_resource target ON target.code = 'api.post.api.galaxy.admin.settings.save'
) AS g;


-- -------------------------------------------------------------------------
-- 4. 跑完还差一步：让 ACL 缓存失效
--
--     redis-cli INCR manager:acl:version
--
-- 或者直接重启 manager-api。
--
-- 注意：运行参数本身**不需要**这一步，它有自己的回查节奏（十几秒）。
-- 这里要失效的是管理端的菜单与接口授权缓存。
-- -------------------------------------------------------------------------
