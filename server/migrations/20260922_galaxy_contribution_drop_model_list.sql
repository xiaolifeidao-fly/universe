-- 共享端的模型范围只剩「加入了哪些分组」一道闸，模型通配名单两列撤掉。
--
-- 20260922_galaxy_model_group.sql 把分组做成了中转的基本单位：价挂在分组上、
-- 密钥选中分组才签得出来、共享者把分组加进车道才接得到单。而分组属于某一个模型，
-- 所以「这台机器提供哪些模型能力」这件事，加入的分组已经回答完了 ——
-- 旁边那份 models_allow_json / models_deny_json 通配名单从此是第二道、
-- 并且**没有界面入口**的闸：
--
--   1. 两个维度各拦一半。主人在共享设置里勾上了「Claude Sonnet 5 · 标准」，
--      单还是派不过来，因为名单那一列写着 claude-opus-*；而界面上看不出是谁拦的。
--   2. 名单是通配模式（claude-sonnet-*），分组是业务键（mg_…）—— 两套写法、
--      两套语义，落在同一个问题上。
--   3. 这一列本来就在被悄悄清空：ReplaceContributions 的 upsert 把
--      models_allow_json / models_deny_json 列进了 DoUpdates，而节点从来不上报名单
--      （CapabilityReport 里只有 availableModels），每走一次那条路径，主人填的名单
--      就被覆盖成空。也就是说这份规则在生产上早已不可信。
--
-- **要在发新版 galaxy-api / galaxy-hub-api 之前或之后都可以跑**：新版不再读写这两列，
-- 旧版读到的是自己写下的值 —— 没有一边会因为缺列报错的时刻。稳妥的顺序仍然是
-- 先发版、后跑迁移（那时这两列已经没有任何读者）。
--
-- 幂等：判过存在性，跑第二遍是一句「已移除，跳过」。
--
-- 不回填 groups_json：空 = 不限，也就是「什么分组的单都接」。原先靠 allow 名单
-- 收窄过范围的车道，跑完这一版会变成什么都接 —— 这是有意的，且必须让主人知道：
-- 把名单里的通配模式翻译成分组是机器做不了的判断（claude-sonnet-* 对应哪几个档次，
-- 只有主人自己清楚），猜一份出来等于替他做了「接不接深度档」这个花钱的决定。
-- 第 2 段把受影响的车道列出来，发版公告按它通知。

-- 1) 先把「原先收窄过范围」的车道报出来。这些主人需要回到共享设置里重新勾分组。
--    正常情况下这条查询返回的行数很少 —— 见上面第 3 条，这一列长期被清空。
SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_contribution'
     AND column_name = 'models_allow_json'
);
SET @sql := IF(@exists > 0,
  'SELECT `cid`, `node_id`, `owner_user_id`, `models_allow_json`, `models_deny_json`, `groups_json`
     FROM `zt_galaxy_contribution`
    WHERE (`models_allow_json` IS NOT NULL AND `models_allow_json` NOT IN ('''', ''[]''))
       OR (`models_deny_json`  IS NOT NULL AND `models_deny_json`  NOT IN ('''', ''[]''))',
  'SELECT ''models_allow_json 已移除，无需盘点''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2) 丢掉两列。
SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_contribution'
     AND column_name = 'models_allow_json'
);
SET @sql := IF(@exists > 0,
  'ALTER TABLE `zt_galaxy_contribution` DROP COLUMN `models_allow_json`',
  'SELECT ''zt_galaxy_contribution.models_allow_json 已移除，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'zt_galaxy_contribution'
     AND column_name = 'models_deny_json'
);
SET @sql := IF(@exists > 0,
  'ALTER TABLE `zt_galaxy_contribution` DROP COLUMN `models_deny_json`',
  'SELECT ''zt_galaxy_contribution.models_deny_json 已移除，跳过''');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 3) models_available_json 留着，不要一起丢：它是**节点报上来的事实**
--    （上游此刻有哪些模型），界面拿它在分组旁边标一句「这台机器有」。
--    它不是规则，任何判定都不看它 —— 这也正是它能留下来的原因。
SELECT COUNT(*) AS `还带着上游可用模型标注的车道`
  FROM `zt_galaxy_contribution`
 WHERE `models_available_json` IS NOT NULL AND `models_available_json` NOT IN ('', '[]');
