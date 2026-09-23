-- 贡献表加一列：节点上报的「上游现在有哪些模型」。
--
-- 为什么要存：控制台的「只放这些模型 / 不放这些模型」以前只能手敲，主人得自己
-- 记住上游有什么型号。现在节点探测后随 hello 报上来，控制台拿它当候选项。
--
-- 和 models_allow_json / models_deny_json 是两回事，别合并：
--   models_available_json  节点报的**事实** —— 上游有什么
--   models_allow/deny_json 主人定的**规则** —— 放行什么，而且是通配模式
--                          （claude-sonnet-* 前缀匹配、* 全放），不是精确名
-- 所以控制台那两个框必须保留自由输入，候选项只是提示。
--
-- 为什么不让浏览器直接问本机 bridge：贡献授权页管的是主人名下**所有**机器，
-- 而浏览器只够得到自己坐着这台。用台式机配笔记本上那条贡献时没有 bridge 可调。
-- 走 hello 和 available / unavailable_reason 是同一条路径。
--
-- 4096 而不是 1024：一个上游可能返回上百个模型名。节点侧也会截断，
-- 截断比让整台机器的 hello 失败强 —— 少几个候选项而已。
--
-- 已有的行留空：下一次 hello 会把它填上（upsert 的 DoUpdates 里带了这一列）。
-- 幂等：跑之前先判断列在不在，重复执行不会报 1060。
SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_contribution'
     AND column_name = 'models_available_json'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE `zt_galaxy_contribution`
     ADD COLUMN `models_available_json` varchar(4096) NULL DEFAULT NULL COMMENT ''节点上报的上游可用模型名，JSON 数组，仅作控制台候选项''',
  'SELECT ''zt_galaxy_contribution.models_available_json 已存在，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
