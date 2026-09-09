-- 关掉 MySQL 给语义时间列偷偷加的 ON UPDATE CURRENT_TIMESTAMP。
--
-- 起因：控制台上出现「离线，最近心跳 51 秒前」这种自相矛盾的一行。查下去发现
-- zt_galaxy_node.last_beat_at 的列定义是：
--
--   null=NO  default=CURRENT_TIMESTAMP  extra="DEFAULT_GENERATED on update CURRENT_TIMESTAMP"
--
-- 没人这么写过。这是 MySQL 在 explicit_defaults_for_timestamp=OFF（本库就是 0）时
-- 对**每张表第一个 TIMESTAMP 列**的隐式规则：没有显式 DEFAULT 就自动补上
-- NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP。
-- 建表时只写 `timestamp null` 压不住它 —— 必须显式给 DEFAULT NULL。
--
-- 后果是「对这一行做任何 UPDATE，这个时间列都被改写成当前时间」，而这些列的值
-- 是有语义的：
--
--   zt_galaxy_price.effective_from    在唯一键里，且是「按生效时间取当时的价」的依据。
--                                     改价的 UPDATE 会改写它 —— 历史账单重算不出当时的价。
--   zt_galaxy_consent_record.accepted_at   同意条款的时间是法律记录。
--   zt_galaxy_node.last_beat_at       心跳时间，被巡检的 UPDATE 顺手刷新。
--   zt_galaxy_artifact.expires_at     产物保留期。
--   zt_galaxy_ledger_session.last_turn_at  会话空闲回收的依据。
--   zt_galaxy_audit_probe.checked_at  抽检时间。
--   zt_galaxy_quota_window.snapshot_at 额度窗口快照时间。
--   zt_bizline_share_link.expires_at   分享链接有效期。
--   zt_delivery_command_worker.last_heartbeat_at  工作机心跳，死掉的机器会显得还活着。
--   zt_delivery_requirement_completion_notification.completed_at  完成时间（这一列没有
--                                     ON UPDATE，但 NOT NULL DEFAULT CURRENT_TIMESTAMP
--                                     会让「没填」静默变成「现在」）。
--
-- **不动 created_time / updated_time**：那两列本来就该是 NOT NULL DEFAULT CURRENT_TIMESTAMP，
-- updated_time 带 ON UPDATE 更是想要的行为。这份迁移只碰语义列。
--
-- 幂等：MODIFY 是幂等的，重复执行只是把列改成同一个定义。
-- 不改数据，只改列定义；NOT NULL → NULL 不会丢任何已有值。
--
-- 源头也一并改了（否则 AutoMigrate 会把它建回去）：
--   server/service/galaxy/internal/repository/model.go   type:timestamp null default null
--   server/service/bizline/internal/repository/model.go
--   server/service/delivery/internal/repository/model.go
--   server/galaxy.sql                                    timestamp NULL DEFAULT NULL

-- ---------- 共享池 ----------
ALTER TABLE `zt_galaxy_node`             MODIFY `last_beat_at`    timestamp NULL DEFAULT NULL;
ALTER TABLE `zt_galaxy_price`            MODIFY `effective_from`  timestamp NULL DEFAULT NULL;
ALTER TABLE `zt_galaxy_consent_record`   MODIFY `accepted_at`     timestamp NULL DEFAULT NULL;
ALTER TABLE `zt_galaxy_artifact`         MODIFY `expires_at`      timestamp NULL DEFAULT NULL;
ALTER TABLE `zt_galaxy_ledger_session`   MODIFY `last_turn_at`    timestamp NULL DEFAULT NULL;
ALTER TABLE `zt_galaxy_audit_probe`      MODIFY `checked_at`      timestamp NULL DEFAULT NULL;
ALTER TABLE `zt_galaxy_quota_window`     MODIFY `snapshot_at`     timestamp NULL DEFAULT NULL;

-- ---------- 其它模块，同一个毛病 ----------
ALTER TABLE `zt_bizline_share_link`      MODIFY `expires_at`      timestamp NULL DEFAULT NULL;
ALTER TABLE `zt_delivery_command_worker` MODIFY `last_heartbeat_at` timestamp NULL DEFAULT NULL;
ALTER TABLE `zt_delivery_requirement_completion_notification`
                                         MODIFY `completed_at`    timestamp NULL DEFAULT NULL;

-- ---------- 跑完自查：这条应该一行都查不出来 ----------
-- SELECT table_name, column_name, is_nullable, column_default, extra
--   FROM information_schema.columns
--  WHERE table_schema = DATABASE() AND data_type = 'timestamp'
--    AND extra LIKE '%on update%'
--    AND column_name NOT IN ('created_time','updated_time');
