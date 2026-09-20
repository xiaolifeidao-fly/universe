-- 管理端菜单：算力平台 → 桌面客户端版本。
--
-- 首选做法**不是**跑这份 SQL，而是：
--
--     cd server/manager-api && go run ./cmd/managerinit
--
-- 页面资源在它的 pages / pageParents 清单里（20260918 那一条），跑一遍就有了。
-- 这份 SQL 只给「目标环境跑不了 managerinit」的情况兜底，内容与它生成的一致。
--
-- 接口资源（4 条）在 server/manager_galaxy_resources.sql 里，那份要单独跑。
--
-- 幂等：先按 code 插，再把父子关系与字段对齐一次 —— 老库里可能已经有一条挂错地方
-- 或者停用了的同 code 记录，只 INSERT 是修不好它的（code 上有全表唯一索引，
-- 插不进去也不会报错，然后菜单里就是没有这一项）。

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT (SELECT id FROM (SELECT id FROM zt_manager_resource WHERE code = 'galaxyPlatform') AS p), 'galaxyDesktopReleases', '桌面客户端版本', 'page', '', '', '/galaxy/desktop-releases', '', 79, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM zt_manager_resource WHERE code = 'galaxyDesktopReleases') AS t);

UPDATE zt_manager_resource child
JOIN zt_manager_resource parent ON parent.code = 'galaxyPlatform'
SET child.parent_id = parent.id, child.name = '桌面客户端版本', child.resource_type = 'page',
    child.page_url = '/galaxy/desktop-releases', child.icon = '', child.sort_id = 79,
    child.status = 'active', child.updated_time = NOW(3)
WHERE child.code = 'galaxyDesktopReleases';

-- 运营与只读角色要看得到这一页。超管不用管（checkRoute 第一条规则直接放行）。
INSERT INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT role.id, r.id, NOW(3)
FROM zt_manager_resource r
JOIN zt_manager_role role ON role.code IN ('operator', 'viewer') AND role.status = 'active'
WHERE r.status = 'active' AND r.code = 'galaxyDesktopReleases'
  AND NOT EXISTS (
    SELECT 1 FROM zt_manager_role_resource rr
    WHERE rr.role_id = role.id AND rr.resource_id = r.id
  );

-- 跑完还差一步：权限判定走进程内缓存，直接改库不碰版本号，新页面与新授权不生效。
--
--     redis-cli INCR manager:acl:version
--
-- 键名是 {manager.redis_namespace}:acl:version，默认 namespace 是 manager。
-- 或者干脆重启 manager-api。
