-- 贡献表加两列：节点报的「本机能不能干」。
--
-- 这是提供者控制面换权威的配套改动。改之前：节点的本地配置文件说了算，
-- hello 全量替换，「共享哪几种」在那台机器上勾。改之后：
--
--   节点报  →  本机有什么能力、能不能用（available / unavailable_reason）
--   Hub 存  →  共享不共享（status）、共享多少（quota_grant）、座位、模型、时段
--
-- 所以 available 和 status 必须是两列，不能合成一个：
-- Claude 登录态过期时能力不可用，但主人的勾选不该被清掉 —— 登录回来下一次心跳
-- 就该自动恢复，而不是让他重新配一遍。
--
-- unavailable_reason 是**人话**，会原样显示给主人（「请运行 claude auth login」），
-- 不是错误码。
--
-- 已有的行默认 available=1：它们是老语义下 hello 申报上来的，当时能报上来就说明可用。
-- 幂等：跑之前先判断列在不在，重复执行不会报 1060。
SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_contribution'
     AND column_name = 'available'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE `zt_galaxy_contribution`
     ADD COLUMN `available` tinyint(1) NOT NULL DEFAULT 1 COMMENT ''节点最近一次上报说这个能力本机可不可用'',
     ADD COLUMN `unavailable_reason` varchar(256) NULL DEFAULT NULL COMMENT ''不可用的原因，人话，直接展示给主人''',
  'SELECT ''zt_galaxy_contribution.available 已存在，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 老数据的收尾：换权威之前，hello 会把这个节点这次没报的贡献置成 disabled。
-- 那批行现在的含义变成了「主人关掉的」，但实际上主人从没点过 —— 它们是插件
-- 上一次没报上来而已。这里不动它们：宁可让主人在控制台重新开一次，
-- 也不要替他把一条贡献打开。
