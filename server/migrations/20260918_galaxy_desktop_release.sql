-- 桌面客户端（Nova 共享端 / Orbit 使用端）的版本分发。
--
-- 客户端那一侧是 electron-updater：应用按平台去 OSS 上取一个固定文件名的清单
-- （latest-mac.yml / latest.yml / latest-linux.yml），比版本号，下载清单里指的包，
-- 校验 sha512，装上。**它不经过服务端的任何接口** —— 清单和包都在公开读的 OSS 目录里
-- （<oss.dirPrefix>/desktop/<端>/），地址由两个端 webview 的 runtime.json 配，
-- 桌面壳启动探 /api/desktop-health 时带走。
--
-- 所以这张表不是「客户端要查的东西」，是运营那一侧的账：发过哪些版本、谁发的、
-- 现在这个通道对外的清单该是哪一份。
--
-- 和 zt_galaxy_bridge_release 的两点不同，都是包变大带来的：
--
--   1. 没有 sha256、没有发布签名。ai-bridge 的包才三兆，字节经服务端，所以能在写进去
--      之前算校验、验签；桌面安装包一百多兆，管理端浏览器拿签名地址直传 OSS，
--      服务端一个字节都不经手。校验值在清单里（electron-builder 打包时算的 sha512），
--      客户端下载完自己比对；「这个包是我们发的」要靠代码签名，那是打包机上的事。
--   2. 多一个 staging 状态：发版是「先登记拿地址 → 浏览器传 → 再发布」两步，
--      中间停在 staging。staging 的行对客户端不存在。
--
-- manifest 存的就是要写到 OSS 上的那份 yml 原文。整份存下来是故意的：它是
-- electron-builder 的产物，字段随版本会变（blockMapSize、minimumSystemVersion、
-- packages…），拆成列再拼回去等于我们要跟着它的格式走一辈子；而且下架要能
-- **回到上一版** —— 把上一行的原文重新写回去就行。

CREATE TABLE IF NOT EXISTS `zt_galaxy_desktop_release` (
  `id`            bigint AUTO_INCREMENT,
  `biz_line`      varchar(32),                                  -- 业务线，池内固定 galaxy
  `release_id`    varchar(40),                                  -- 业务键 dr_…
  `product`       varchar(16),                                  -- nova=共享端 / orbit=使用端
  `channel`       varchar(16),                                  -- mac / win / linux，决定清单文件名
  `version`       varchar(32),                                  -- 语义版本，如 0.1.1
  `manifest_file` varchar(64),                                  -- latest-mac.yml / latest.yml / latest-linux.yml
  `manifest`      mediumtext,                                   -- 要写到 OSS 上的 yml 原文（含 releaseNotes）
  `files_json`    text,                                         -- [{name,size,sha512}]，给运营列表用，不是下载依据
  `size`          bigint,                                       -- 这一版全部文件的字节数之和
  `notes`         text,                                         -- 版本说明，会写进清单，客户端更新提示里原样展示
  `status`        varchar(16),                                  -- staging=已登记待上传 / published / withdrawn
  `published_by`  varchar(64),                                  -- 操作的管理端账号
  `published_at`  timestamp NULL DEFAULT NULL,                  -- 最近一次发布的时刻
  `created_time`  datetime(3) NULL,
  `updated_time`  datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_gx_desktop_release_id` (`biz_line`,`release_id`),
  -- 一个端 × 一个通道 × 一个版本只有一行：重传就是覆盖它（service 层只在这一行
  -- 不是 published 时才允许覆盖 —— 覆盖一个在架的版本，等于同一个版本号下有两份字节）。
  UNIQUE INDEX `uk_gx_desktop_release_target` (`biz_line`,`product`,`channel`,`version`),
  INDEX `idx_gx_desktop_release_channel` (`biz_line`,`product`,`channel`,`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
