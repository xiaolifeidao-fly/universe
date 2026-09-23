-- =========================================================================
-- 管理端权限资源：共享算力池运营接口（31 条）
--
-- 首选做法**不是**跑这份 SQL，而是：
--
--     cd server/manager-api && go run ./cmd/managerinit
--
-- 接口资源本来就是从真实路由表生成的（manager.SyncAPIResources），手写一份迟早
-- 和路由分叉。这份 SQL 只给「目标环境跑不了 managerinit」的情况兜底，
-- 内容与 managerinit 生成的完全一致。
--
-- 页面资源不用动：galaxy（/galaxy，GlobalOutlined，sort=50）已经在 managerinit
-- 的 pages 清单里，菜单能显示出来就是证据。这次新增的全是接口。
--
-- 中间 10 条是 Galaxy 账号体系独立出来时加的（2026-09-11）：Galaxy 账号的列表 / 停用 /
-- 重置密码，以及原来挂在 galaxy-api、认任务宇宙管理员的那几条运营接口
-- （代签密钥、门户模型目录、门户线索）。galaxy-api 上已经没有运营接口了。
--
-- 最后 4 条是桌面客户端热更新上线时加的（2026-09-18）：Nova / Orbit 安装包的发版。
-- 那一页还要一条页面资源（galaxyDesktopReleases），在
-- migrations/20260918_manager_desktop_release_menu.sql 里。
--
-- 全部幂等，反复执行不出错、不改已有行。
-- 库：manager-api 的 application.properties 里 sqlconn 指向的那个
-- =========================================================================


-- -------------------------------------------------------------------------
-- 1. 接口资源
--
-- code 不是起的，是算的 —— 必须与 manager.APIResourceCode(method, path) 逐字一致
-- （server/service/manager/routes.go:82）。下面这批是用那个函数真跑出来的，
-- 不是手敲的。对不上的话，下次谁跑一遍 managerinit 会按算出来的 code 再插一套，
-- 手写这批就变成没人指向的孤儿：后台上看着权限还在，实际全空。
--
-- 路径里的 /api 前缀也进 code，所以是 api.get.api.galaxy... 这种看着重复的形状，
-- 这是对的，别「修」。
--
-- 同路径不同方法各占一条：(method, resource_url) 才是接口资源的身份。
-- 只按 URL 分的话 GET 和 POST 分不开，而那正是只读角色最该分开的地方。
--
-- parent_id 固定 0：本仓库的接口资源是平铺的，没有 api_group 那一层。
-- created_time / updated_time 没有数据库默认值（GORM 在应用层填），必须显式写 NOW(3)。
-- -------------------------------------------------------------------------

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.pool', 'GET /api/galaxy/admin/pool', 'api', 'GET', '/api/galaxy/admin/pool', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.pool');

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.nodes', 'GET /api/galaxy/admin/nodes', 'api', 'GET', '/api/galaxy/admin/nodes', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.nodes');

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.probes', 'GET /api/galaxy/admin/probes', 'api', 'GET', '/api/galaxy/admin/probes', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.probes');

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.usage', 'GET /api/galaxy/admin/usage', 'api', 'GET', '/api/galaxy/admin/usage', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.usage');

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.disputes', 'GET /api/galaxy/admin/disputes', 'api', 'GET', '/api/galaxy/admin/disputes', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.disputes');

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.node.ban', 'POST /api/galaxy/admin/node/ban', 'api', 'POST', '/api/galaxy/admin/node/ban', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.node.ban');

-- 把账号设成工作室 / 改回散户：决定信誉跟着账号还是设备走。
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.provider.type', 'POST /api/galaxy/admin/provider/type', 'api', 'POST', '/api/galaxy/admin/provider/type', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.provider.type');

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.disputes.resolve', 'POST /api/galaxy/admin/disputes/resolve', 'api', 'POST', '/api/galaxy/admin/disputes/resolve', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.disputes.resolve');

-- Galaxy 账号列表：共享端、使用端两批人，按端翻。
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.users', 'GET /api/galaxy/admin/users', 'api', 'GET', '/api/galaxy/admin/users', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.users');

-- 停用 / 启用。停用当场让这个账号的令牌作废。
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.users.status', 'POST /api/galaxy/admin/users/status', 'api', 'POST', '/api/galaxy/admin/users/status', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.users.status');

-- 重置密码。本人下次登录必须先改掉。
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.users.password', 'POST /api/galaxy/admin/users/password', 'api', 'POST', '/api/galaxy/admin/users/password', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.users.password');

-- 给使用端账号发内测密钥。响应里有 sk- 明文。
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.keys.issue', 'POST /api/galaxy/admin/keys/issue', 'api', 'POST', '/api/galaxy/admin/keys/issue', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.keys.issue');

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.portal.models', 'GET /api/galaxy/admin/portal/models', 'api', 'GET', '/api/galaxy/admin/portal/models', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.portal.models');

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.portal.models.save', 'POST /api/galaxy/admin/portal/models/save', 'api', 'POST', '/api/galaxy/admin/portal/models/save', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.portal.models.save');

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.portal.models.delete', 'POST /api/galaxy/admin/portal/models/delete', 'api', 'POST', '/api/galaxy/admin/portal/models/delete', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.portal.models.delete');

-- 门户线索：陌生人留下的联系方式。只读角色不给，见 2.3。
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.portal.leads', 'GET /api/galaxy/admin/portal/leads', 'api', 'GET', '/api/galaxy/admin/portal/leads', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.portal.leads');

INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.portal.leads.handle', 'POST /api/galaxy/admin/portal/leads/handle', 'api', 'POST', '/api/galaxy/admin/portal/leads/handle', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.portal.leads.handle');

-- 下面 7 条是使用者积分与分享返现上线时加的（2026-09-12）：全站密钥与明文、积分充值与流水、默认返现比例。

-- 全站算力密钥列表（不含明文）。
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.keys', 'GET /api/galaxy/admin/keys', 'api', 'GET', '/api/galaxy/admin/keys', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.keys');

-- 取回密钥明文，运营转交给使用者。POST：只读角色天然拿不到。
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.keys.secret', 'POST /api/galaxy/admin/keys/secret', 'api', 'POST', '/api/galaxy/admin/keys/secret', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.keys.secret');

-- 使用者积分流水，充值明细就是 type=recharge 的那些。
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.points.ledger', 'GET /api/galaxy/admin/points/ledger', 'api', 'GET', '/api/galaxy/admin/points/ledger', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.points.ledger');

-- 某个使用者的积分余额与合计，充值框里显示。
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.points.summary', 'GET /api/galaxy/admin/points/summary', 'api', 'GET', '/api/galaxy/admin/points/summary', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.points.summary');

-- 给使用者充积分（线下收款之后）。
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.points.recharge', 'POST /api/galaxy/admin/points/recharge', 'api', 'POST', '/api/galaxy/admin/points/recharge', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.points.recharge');

-- 分享返现的默认比例。
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.referral.settings', 'GET /api/galaxy/admin/referral/settings', 'api', 'GET', '/api/galaxy/admin/referral/settings', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.referral.settings');

-- 保存分享返现的默认比例；各模型的比例随模型目录保存。
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.referral.settings.save', 'POST /api/galaxy/admin/referral/settings/save', 'api', 'POST', '/api/galaxy/admin/referral/settings/save', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.referral.settings.save');

-- 下面 3 条是 ai-bridge 版本分发上线时加的（2026-09-12）：安装包的列表、上传与上下架。

-- 安装包列表（含已下架的）。
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.bridge.releases', 'GET /api/galaxy/admin/bridge/releases', 'api', 'GET', '/api/galaxy/admin/bridge/releases', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.bridge.releases');

-- 上传安装包。传上去就是发布：机器的一键升级会挑它作目标。
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.bridge.releases.upload', 'POST /api/galaxy/admin/bridge/releases/upload', 'api', 'POST', '/api/galaxy/admin/bridge/releases/upload', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.bridge.releases.upload');

-- 下架 / 重新上架某一个包。发现问题版本时先下架，它立刻不再是任何机器的升级目标。
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.bridge.releases.status', 'POST /api/galaxy/admin/bridge/releases/status', 'api', 'POST', '/api/galaxy/admin/bridge/releases/status', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.bridge.releases.status');

-- 下面 4 条是桌面客户端（Nova / Orbit）热更新上线时加的（2026-09-18）。
--
-- 发版分两步是因为包一百多兆、字节不经服务端：prepare 收下 electron-builder 出的清单、
-- 回几个直传地址，浏览器把包 PUT 上 OSS，publish 再确认包到了没有、把清单写出去。
-- 客户端读的是 OSS 上那份清单，不打这里的任何接口。

-- 发版记录列表（含还没传完的和已下架的）。
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.get.api.galaxy.admin.desktop.releases', 'GET /api/galaxy/admin/desktop/releases', 'api', 'GET', '/api/galaxy/admin/desktop/releases', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.get.api.galaxy.admin.desktop.releases');

-- 第一步：交清单、登记这一版、换回直传地址。这一步还没有任何用户看得到。
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.desktop.releases.prepare', 'POST /api/galaxy/admin/desktop/releases/prepare', 'api', 'POST', '/api/galaxy/admin/desktop/releases/prepare', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.desktop.releases.prepare');

-- 第二步：确认包真的在对象存储上，把清单发出去 —— **全网的客户端从这一刻起开始提示更新**。
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.desktop.releases.publish', 'POST /api/galaxy/admin/desktop/releases/publish', 'api', 'POST', '/api/galaxy/admin/desktop/releases/publish', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.desktop.releases.publish');

-- 下架 / 重新上架。下架把清单换回上一版，问题版本立刻不再被推给任何人。
INSERT INTO zt_manager_resource
  (parent_id, code, name, resource_type, method, resource_url, page_url, icon, sort_id, status, created_time, updated_time)
SELECT 0, 'api.post.api.galaxy.admin.desktop.releases.status', 'POST /api/galaxy/admin/desktop/releases/status', 'api', 'POST', '/api/galaxy/admin/desktop/releases/status', '', '', 0, 'active', NOW(3), NOW(3)
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM zt_manager_resource WHERE code = 'api.post.api.galaxy.admin.desktop.releases.status');


-- -------------------------------------------------------------------------
-- 2. 角色授权
--
-- 注意：**role_id = 1 是超级管理员，绑了也是白绑**。checkRoute 的第一条规则就是
-- 超管直接放行，根本不查资源表（permission.go:116）。所以下面这段幂等无害，
-- 但它不解决任何一个 403 —— 真正要授权的是 operator / viewer。
--
-- 绝不 DELETE 再 INSERT：资源按 code 冲突更新、不重建。重建会换掉资源 id，
-- 把 zt_manager_role_resource 里指向它的授权全部作废 —— 一次例行的重新初始化
-- 就能把所有人的权限清空。
-- -------------------------------------------------------------------------

-- 2.1 role_id = 1（超管，实际不生效，按默认值给出）
INSERT INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT 1, r.id, NOW(3)
FROM zt_manager_resource r
WHERE r.status = 'active'
  AND r.code IN (
    'api.get.api.galaxy.admin.pool',
    'api.get.api.galaxy.admin.nodes',
    'api.get.api.galaxy.admin.probes',
    'api.get.api.galaxy.admin.usage',
    'api.get.api.galaxy.admin.disputes',
    'api.post.api.galaxy.admin.node.ban',
    'api.post.api.galaxy.admin.provider.type',
    'api.post.api.galaxy.admin.disputes.resolve',
    'api.get.api.galaxy.admin.users',
    'api.post.api.galaxy.admin.users.status',
    'api.post.api.galaxy.admin.users.password',
    'api.post.api.galaxy.admin.keys.issue',
    'api.get.api.galaxy.admin.portal.models',
    'api.post.api.galaxy.admin.portal.models.save',
    'api.post.api.galaxy.admin.portal.models.delete',
    'api.get.api.galaxy.admin.portal.leads',
    'api.post.api.galaxy.admin.portal.leads.handle',
    'api.get.api.galaxy.admin.keys',
    'api.post.api.galaxy.admin.keys.secret',
    'api.get.api.galaxy.admin.points.ledger',
    'api.get.api.galaxy.admin.points.summary',
    'api.post.api.galaxy.admin.points.recharge',
    'api.get.api.galaxy.admin.referral.settings',
    'api.post.api.galaxy.admin.referral.settings.save',
    'api.get.api.galaxy.admin.bridge.releases',
    'api.post.api.galaxy.admin.bridge.releases.upload',
    'api.post.api.galaxy.admin.bridge.releases.status',
    'api.get.api.galaxy.admin.desktop.releases',
    'api.post.api.galaxy.admin.desktop.releases.prepare',
    'api.post.api.galaxy.admin.desktop.releases.publish',
    'api.post.api.galaxy.admin.desktop.releases.status'
  )
  AND NOT EXISTS (
    SELECT 1 FROM zt_manager_role_resource rr
    WHERE rr.role_id = 1 AND rr.resource_id = r.id
  );

-- 2.2 operator（运营）：读写全给。
-- 按角色 code 取 id，不硬编码数字 —— 默认建库顺序下 operator 是 2，但那只是默认。
INSERT INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT (SELECT id FROM zt_manager_role WHERE code = 'operator' AND status = 'active'), r.id, NOW(3)
FROM zt_manager_resource r
WHERE r.status = 'active'
  AND EXISTS (SELECT 1 FROM zt_manager_role WHERE code = 'operator' AND status = 'active')
  AND r.code IN (
    'api.get.api.galaxy.admin.pool',
    'api.get.api.galaxy.admin.nodes',
    'api.get.api.galaxy.admin.probes',
    'api.get.api.galaxy.admin.usage',
    'api.get.api.galaxy.admin.disputes',
    'api.post.api.galaxy.admin.node.ban',
    'api.post.api.galaxy.admin.provider.type',
    'api.post.api.galaxy.admin.disputes.resolve',
    'api.get.api.galaxy.admin.users',
    'api.post.api.galaxy.admin.users.status',
    'api.post.api.galaxy.admin.users.password',
    'api.post.api.galaxy.admin.keys.issue',
    'api.get.api.galaxy.admin.portal.models',
    'api.post.api.galaxy.admin.portal.models.save',
    'api.post.api.galaxy.admin.portal.models.delete',
    'api.get.api.galaxy.admin.portal.leads',
    'api.post.api.galaxy.admin.portal.leads.handle',
    'api.get.api.galaxy.admin.keys',
    'api.post.api.galaxy.admin.keys.secret',
    'api.get.api.galaxy.admin.points.ledger',
    'api.get.api.galaxy.admin.points.summary',
    'api.post.api.galaxy.admin.points.recharge',
    'api.get.api.galaxy.admin.referral.settings',
    'api.post.api.galaxy.admin.referral.settings.save',
    'api.get.api.galaxy.admin.bridge.releases',
    'api.post.api.galaxy.admin.bridge.releases.upload',
    'api.post.api.galaxy.admin.bridge.releases.status',
    'api.get.api.galaxy.admin.desktop.releases',
    'api.post.api.galaxy.admin.desktop.releases.prepare',
    'api.post.api.galaxy.admin.desktop.releases.publish',
    'api.post.api.galaxy.admin.desktop.releases.status'
  )
  AND NOT EXISTS (
    SELECT 1 FROM zt_manager_role_resource rr
    WHERE rr.role_id = (SELECT id FROM zt_manager_role WHERE code = 'operator' AND status = 'active')
      AND rr.resource_id = r.id
  );

-- 2.3 viewer（只读）：**只给 GET**，门户线索（portal/leads）除外。
-- 写接口有角色的 writable 开关兜底拦得住，但后台上看到的授权范围会和实际能力
-- 不一致，配起来容易误判 —— 这也是 managerinit 的口径。
-- 线索里是陌生人留下的手机、邮箱，只读角色没有理由拉这份名单（managerinit 的 viewerWithheld）。
INSERT INTO zt_manager_role_resource (role_id, resource_id, created_time)
SELECT (SELECT id FROM zt_manager_role WHERE code = 'viewer' AND status = 'active'), r.id, NOW(3)
FROM zt_manager_resource r
WHERE r.status = 'active'
  AND EXISTS (SELECT 1 FROM zt_manager_role WHERE code = 'viewer' AND status = 'active')
  AND r.code IN (
    'api.get.api.galaxy.admin.pool',
    'api.get.api.galaxy.admin.nodes',
    'api.get.api.galaxy.admin.probes',
    'api.get.api.galaxy.admin.usage',
    'api.get.api.galaxy.admin.disputes',
    'api.get.api.galaxy.admin.users',
    'api.get.api.galaxy.admin.portal.models',
    'api.get.api.galaxy.admin.keys',
    'api.get.api.galaxy.admin.points.ledger',
    'api.get.api.galaxy.admin.points.summary',
    'api.get.api.galaxy.admin.referral.settings',
    'api.get.api.galaxy.admin.bridge.releases',
    'api.get.api.galaxy.admin.desktop.releases'
  )
  AND NOT EXISTS (
    SELECT 1 FROM zt_manager_role_resource rr
    WHERE rr.role_id = (SELECT id FROM zt_manager_role WHERE code = 'viewer' AND status = 'active')
      AND rr.resource_id = r.id
  );


-- -------------------------------------------------------------------------
-- 3. 跑完还差一步：让 ACL 缓存失效
--
-- 权限判定走**进程内缓存**，一致性靠 Redis 里的版本号。直接改库不碰这个版本号，
-- manager-api 会拿着旧缓存继续跑，新资源与新授权**不生效** —— 现象是 SQL 跑成功了
-- 但页面照样 403，很容易误判成 SQL 没写对。
--
--     redis-cli INCR manager:acl:version
--
-- 键名是 {manager.redis_namespace}:acl:version。当前 manager-api 的
-- application.properties 没配这个 key，走默认 namespace「manager」，所以就是
-- manager:acl:version。改过配置的环境按实际值来。或者干脆重启 manager-api。
--
-- 核对用：
--     SELECT id, code, name, writable, status FROM zt_manager_role ORDER BY id;
--     SELECT code, method, resource_url FROM zt_manager_resource
--      WHERE code LIKE 'api.%.api.galaxy.admin.%' ORDER BY code;
-- -------------------------------------------------------------------------
