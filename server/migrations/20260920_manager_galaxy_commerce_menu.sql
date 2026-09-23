-- 管理端菜单：模型目录 / 价目表 / 额度包 三条合成一条「商品与定价」。
--
-- 首选做法**不是**跑这份 SQL，而是：
--
--     cd server/manager-api && go run ./cmd/managerinit
--
-- 但 managerinit 只会新增与对齐，**不删**旧资源 —— 它没有「这条已经不该存在了」
-- 的概念。所以老的三条要靠这份 SQL 删，两条路都要走一遍。
--
-- 为什么合：模型目录、价目表、额度包讲的是同一件事的三段（卖什么、按什么价收、
-- 怎么打包卖），而运营调一次价要在三个页面之间跳；模型目录当时还挂在「算力平台」
-- 那一栏，和运行参数、ai-bridge 版本摆在一起 —— 那一栏其余几项都是运维。
--
-- 页面路由也跟着没了：/galaxy/models、/galaxy/pricing、/galaxy/packages 三个目录
-- 已从前端删除，合并后的页面是 /galaxy/commerce?tab=models|pricing|packages。
-- 留着旧资源的话，菜单上点进去是 404。
--
-- 接口资源一条都不用动：三个页签调的还是原来那几个接口。
--
-- 幂等：先按 code 插新的，再对齐一次父子与字段（老库里可能有一条挂错地方或停用了的
-- 同 code 记录，只 INSERT 修不好它），最后按 code 删旧的三条与它们的角色绑定。

-- -------------------------------------------------------------------------
-- 1. 新增「商品与定价」，挂在「使用与计费」下、积分充值后面
-- -------------------------------------------------------------------------

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyDemand') AS p), 'galaxyCommerce', '商品与定价', 'page', '', '', '/galaxy/commerce', '', 68, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyCommerce') AS t);

UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxyDemand'
SET child.parent_id = parent.id, child.name = '商品与定价', child.resource_type = 'page',
    child.page_url = '/galaxy/commerce', child.icon = '', child.sort_id = 68,
    child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxyCommerce';

-- -------------------------------------------------------------------------
-- 2. 谁本来看得到那三条，就让谁看得到新的这条
--
-- 不写死 operator / viewer：这三页可能被授权给过别的角色，照搬角色名会把那些人
-- 挡在外面，而他们昨天还能改价。以「并过原来三条的授权」为准。
-- -------------------------------------------------------------------------

INSERT INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT DISTINCT old_rr.role_id, new_r.id, NOW(3)
FROM zt_manager_role_resource old_rr
JOIN zt_manager_resource old_r ON old_r.id = old_rr.resource_id
JOIN zt_manager_resource new_r ON new_r.code = 'galaxyCommerce'
WHERE old_r.code IN ('galaxyModels', 'galaxyPricing', 'galaxyPackages')
  AND NOT EXISTS (
    SELECT 1 FROM (
      SELECT rr.role_id, rr.resource_id FROM zt_manager_role_resource rr
    ) AS existing
    WHERE existing.role_id = old_rr.role_id AND existing.resource_id = new_r.id
  );

-- -------------------------------------------------------------------------
-- 3. 删掉旧的三条：先解绑角色，再删资源
--
-- 顺序不能反 —— 先删资源的话，zt_manager_role_resource 里会留下一批指向不存在
-- 资源的行。它们不会报错，只会在权限表里一直躺着，下次有人排查授权时多一堆噪声。
-- -------------------------------------------------------------------------

DELETE rr FROM zt_manager_role_resource rr
JOIN zt_manager_resource r ON r.id = rr.resource_id
WHERE r.code IN ('galaxyModels', 'galaxyPricing', 'galaxyPackages');

DELETE FROM zt_manager_resource
WHERE code IN ('galaxyModels', 'galaxyPricing', 'galaxyPackages');

-- 跑完还差一步：权限判定走进程内缓存，直接改库不碰版本号，菜单与授权不生效。
--
--     redis-cli INCR manager:acl:version
--
-- 键名是 {manager.redis_namespace}:acl:version，默认 namespace 是 manager。
-- 或者干脆重启 manager-api。
