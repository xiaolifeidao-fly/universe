-- 管理端权限资源：删掉随额度包一起下线的三条接口。
--
-- 首选做法**不是**跑这份 SQL，而是：
--
--     cd server/manager-api && go run ./cmd/managerinit
--
-- 但 managerinit 只会新增与对齐，**不删**旧资源 —— 它没有「这条已经不该存在了」
-- 的概念（见 service/manager/routes.go 的 SyncAPIResources）。所以两条路都要走一遍。
--
-- 哪三条、为什么没了：
--
--   GET  /api/galaxy/admin/packages        额度包目录
--   POST /api/galaxy/admin/packages/save   维护额度包
--   POST /api/galaxy/admin/orders/pay      人工确认到账
--
-- 使用端改成按账户积分余额逐笔扣费之后，额度包这门生意没有了：没有商品可维护，
-- 也就没有订单可确认到账。运营给人额度的唯一入口是「积分充值」。
-- 三条路由已经从 manager-api 删除，留着资源的话，只是让角色页上多出三条
-- 点了必然 404 的授权项。
--
-- 订单**页面**不动：库里还有历史订单，那一页留着只读。
--
-- 幂等：先解绑角色再删资源，都按 code 定位，重复执行不出错。

-- -------------------------------------------------------------------------
-- 1. 解绑角色
-- -------------------------------------------------------------------------

DELETE rr FROM zt_manager_role_resource rr
JOIN zt_manager_resource r ON r.id = rr.resource_id
WHERE r.code IN (
  'api.get.api.galaxy.admin.packages',
  'api.post.api.galaxy.admin.packages.save',
  'api.post.api.galaxy.admin.orders.pay'
);

-- -------------------------------------------------------------------------
-- 2. 删资源
-- -------------------------------------------------------------------------

DELETE FROM zt_manager_resource
WHERE code IN (
  'api.get.api.galaxy.admin.packages',
  'api.post.api.galaxy.admin.packages.save',
  'api.post.api.galaxy.admin.orders.pay'
);
