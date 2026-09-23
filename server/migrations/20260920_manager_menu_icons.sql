-- 管理端菜单：给二级菜单补图标。
--
-- 首选做法**不是**跑这份 SQL，而是：
--
--     cd server/manager-api && go run ./cmd/managerinit
--
-- managerinit 按 code 冲突更新，会把下面这些 icon 一起对齐。这份 SQL 给
-- 「目标环境跑不了 managerinit」的情况兜底，内容与它的 pages 清单一致。
--
-- 为什么补：一级菜单本来就各有图标，二级一个都没有 —— 六个算力菜单展开之后
-- 是二十多行纯文字，找一页只能逐行读。图标是那种「看一眼就知道是哪一行」的锚点，
-- 侧栏收起来的时候更是只剩它。
--
-- 图标名必须在前端 ManagerShellStub 的 MENU_ICONS 白名单里 —— 前端是按名字查
-- 组件的，查不到不报错，只是那一行没图标。加新菜单时两边一起改。
--
-- 幂等：只 UPDATE 已有行，不插不删。没有这些 code 的库（比如还没跑过
-- 20260917_manager_galaxy_two_level_menu.sql 的）什么都不会发生，也不报错。

UPDATE zt_manager_resource
SET icon = CASE code
    -- 算力总览
    WHEN 'galaxyHome'            THEN 'FundOutlined'
    WHEN 'galaxyPool'            THEN 'DatabaseOutlined'
    WHEN 'galaxyUnits'           THEN 'ProfileOutlined'
    WHEN 'galaxySettlement'      THEN 'AccountBookOutlined'
    WHEN 'galaxyLedger'          THEN 'TransactionOutlined'
    -- 算力供给
    WHEN 'galaxyNodes'           THEN 'DeploymentUnitOutlined'
    WHEN 'galaxyPayouts'         THEN 'MoneyCollectOutlined'
    -- 风控与审计
    WHEN 'galaxyProbes'          THEN 'ExperimentOutlined'
    WHEN 'galaxyMismatches'      THEN 'AlertOutlined'
    WHEN 'galaxyReputation'      THEN 'StarOutlined'
    WHEN 'galaxyBans'            THEN 'StopOutlined'
    -- 使用与计费
    WHEN 'galaxyKeys'            THEN 'KeyOutlined'
    WHEN 'galaxyOrders'          THEN 'ShoppingOutlined'
    WHEN 'galaxyPoints'          THEN 'CreditCardOutlined'
    WHEN 'galaxyCommerce'        THEN 'TagsOutlined'
    -- 客户与增长
    WHEN 'galaxyAccounts'        THEN 'UserOutlined'
    WHEN 'galaxyDisputes'        THEN 'SolutionOutlined'
    WHEN 'galaxyLeads'           THEN 'ContactsOutlined'
    WHEN 'galaxyReferrals'       THEN 'ShareAltOutlined'
    -- 算力平台
    WHEN 'galaxySettings'        THEN 'SlidersOutlined'
    WHEN 'galaxyBridgeReleases'  THEN 'ApiOutlined'
    WHEN 'galaxyDesktopReleases' THEN 'DesktopOutlined'
    -- 系统设置
    WHEN 'settingsAccounts'      THEN 'UserSwitchOutlined'
    WHEN 'settingsRoles'         THEN 'SafetyOutlined'
  END,
  updated_time = NOW(3)
WHERE code IN (
  'galaxyHome', 'galaxyPool', 'galaxyUnits', 'galaxySettlement', 'galaxyLedger',
  'galaxyNodes', 'galaxyPayouts',
  'galaxyProbes', 'galaxyMismatches', 'galaxyReputation', 'galaxyBans',
  'galaxyKeys', 'galaxyOrders', 'galaxyPoints', 'galaxyCommerce',
  'galaxyAccounts', 'galaxyDisputes', 'galaxyLeads', 'galaxyReferrals',
  'galaxySettings', 'galaxyBridgeReleases', 'galaxyDesktopReleases',
  'settingsAccounts', 'settingsRoles'
);

-- 跑完还差一步：菜单走进程内缓存，直接改库不碰版本号，侧栏上看不到变化。
--
--     redis-cli INCR manager:acl:version
--
-- 键名是 {manager.redis_namespace}:acl:version，默认 namespace 是 manager。
-- 或者干脆重启 manager-api。
