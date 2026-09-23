package repository

import (
	"context"
	"fmt"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type CommandQuery struct {
	BizLine   string
	UserID    string
	ProgramID int64
	State     string
	// ExcludeCommandTypes 把快照类命令挡在运行记录之外：会话页几秒读一次，
	// 不过滤的话用户自己发的那条执行命令会被顶到列表几十条以后。
	ExcludeCommandTypes []string
	Offset              int
	Limit               int
}

func (r *DeliveryRepository) FindCommand(ctx context.Context, bizLine, userID, commandID string) (*DeliveryCommand, error) {
	var row DeliveryCommand
	err := r.Db.WithContext(ctx).Model(&DeliveryCommand{}).
		Where("biz_line = ?", bizLine).
		Where("user_id = ?", userID).
		Where("command_id = ?", commandID).
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *DeliveryRepository) FindCommandByIdempotency(ctx context.Context, bizLine, userID, key string) (*DeliveryCommand, error) {
	var row DeliveryCommand
	err := r.Db.WithContext(ctx).Model(&DeliveryCommand{}).
		Where("biz_line = ?", bizLine).
		Where("user_id = ?", userID).
		Where("idempotency_key = ?", key).
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *DeliveryRepository) ListCommands(ctx context.Context, q CommandQuery) ([]*DeliveryCommand, int64, error) {
	tx := r.Db.WithContext(ctx).Model(&DeliveryCommand{}).
		Where("biz_line = ?", q.BizLine).
		Where("user_id = ?", q.UserID)
	if q.ProgramID > 0 {
		tx = tx.Where("program_id = ?", q.ProgramID)
	}
	if q.State != "" {
		tx = tx.Where("state = ?", q.State)
	}
	if len(q.ExcludeCommandTypes) > 0 {
		tx = tx.Where("command_type NOT IN ?", q.ExcludeCommandTypes)
	}
	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	if q.Limit > 0 {
		tx = tx.Offset(q.Offset).Limit(q.Limit)
	}
	var rows []*DeliveryCommand
	err := tx.Order("created_time desc, id desc").Find(&rows).Error
	return rows, total, err
}

func (r *DeliveryRepository) CreateCommand(ctx context.Context, row *DeliveryCommand, event *DeliveryCommandEvent) error {
	now := time.Now()
	row.CreatedTime = now
	row.UpdatedTime = now
	if row.Version <= 0 {
		row.Version = 1
	}
	event.CreatedAt = now
	return r.Db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(row).Error; err != nil {
			return err
		}
		return tx.Create(event).Error
	})
}

func (r *DeliveryRepository) ListCommandEvents(ctx context.Context, bizLine, userID, commandID string, afterID int64, limit int) ([]*DeliveryCommandEvent, error) {
	tx := r.Db.WithContext(ctx).Model(&DeliveryCommandEvent{}).
		Where("biz_line = ?", bizLine).
		Where("user_id = ?", userID).
		Where("command_id = ?", commandID)
	if afterID > 0 {
		tx = tx.Where("id > ?", afterID)
	}
	if limit > 0 {
		tx = tx.Limit(limit)
	}
	var rows []*DeliveryCommandEvent
	err := tx.Order("id asc").Find(&rows).Error
	return rows, err
}

func (r *DeliveryRepository) FindNextPendingCommand(ctx context.Context, bizLine, userID string, programID int64, commandTypes []string) (*DeliveryCommand, error) {
	var row DeliveryCommand
	err := r.Db.WithContext(ctx).Model(&DeliveryCommand{}).
		Where("biz_line = ?", bizLine).
		Where("user_id = ?", userID).
		Where("program_id = ?", programID).
		Where("state = ?", "pending").
		Where("cancel_requested = ?", false).
		Where("command_type IN ?", commandTypes).
		Order("created_time asc, id asc").
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// TryLeaseCommand is intentionally an UPDATE predicate rather than a read-lock-write
// sequence. Multiple worker processes can race here, but only one can change pending.
func (r *DeliveryRepository) TryLeaseCommand(
	ctx context.Context, bizLine, userID, commandID, workerID, leaseToken string, expiresAt time.Time, event *DeliveryCommandEvent,
) (bool, error) {
	claimed := false
	err := r.Db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		result := tx.Model(&DeliveryCommand{}).
			Where("biz_line = ?", bizLine).
			Where("user_id = ?", userID).
			Where("command_id = ?", commandID).
			Where("state = ?", "pending").
			Where("cancel_requested = ?", false).
			Updates(map[string]any{
				"state": "leased", "lease_token": leaseToken, "lease_worker_id": workerID,
				"lease_expires_at": expiresAt, "attempt_count": gorm.Expr("attempt_count + 1"),
				"version": gorm.Expr("version + 1"), "updated_time": time.Now(),
			})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return nil
		}
		claimed = true
		event.CreatedAt = time.Now()
		return tx.Create(event).Error
	})
	return claimed, err
}

// AbandonPendingCommand 把一条还没被领取的命令直接判死，用于 Worker 领取时发现
// 它已经没有意义（例如过期的界面快照）。只动 pending 行：正在跑的命令由租约收口。
func (r *DeliveryRepository) AbandonPendingCommand(ctx context.Context, bizLine, userID, commandID, message string) (bool, error) {
	changed := false
	err := r.Db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		now := time.Now()
		result := tx.Model(&DeliveryCommand{}).
			Where("biz_line = ?", bizLine).
			Where("user_id = ?", userID).
			Where("command_id = ?", commandID).
			Where("state = ?", "pending").
			Updates(map[string]any{
				"state": "timed_out", "finished_at": now, "version": gorm.Expr("version + 1"), "updated_time": now,
			})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return nil
		}
		changed = true
		return tx.Create(&DeliveryCommandEvent{
			BizLine: bizLine, CommandID: commandID, UserID: userID, Kind: "stale_discarded", State: "timed_out", Message: message, DataJSON: "{}", CreatedAt: now,
		}).Error
	})
	return changed, err
}

func (r *DeliveryRepository) UpsertCommandWorker(
	ctx context.Context, row *DeliveryCommandWorker, workspaces []*DeliveryCommandWorkerWorkspace,
) error {
	now := time.Now()
	return r.Db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		row.CreatedTime = now
		row.UpdatedTime = now
		row.LastHeartbeatAt = now
		// 一台 Worker 的执行通道和只读通道会同时注册：先查后插一定会撞
		// uk_dlv_command_worker，判重交给唯一键，不在应用层猜有没有。
		if err := tx.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "biz_line"}, {Name: "user_id"}, {Name: "worker_id"}},
			DoUpdates: clause.AssignmentColumns([]string{"display_name", "capabilities_json", "last_heartbeat_at", "updated_time"}),
		}).Create(row).Error; err != nil {
			return err
		}
		programIDs := make([]int64, 0, len(workspaces))
		for _, workspace := range workspaces {
			workspace.CreatedTime = now
			workspace.UpdatedTime = now
			programIDs = append(programIDs, workspace.ProgramID)
		}
		// 只删这次没再报上来的映射。整段删光再插会让并发的两条通道互相删掉对方
		// 刚插进去的行，然后一起撞唯一键。
		stale := tx.Where("biz_line = ?", row.BizLine).
			Where("user_id = ?", row.UserID).
			Where("worker_id = ?", row.WorkerID)
		if len(programIDs) > 0 {
			stale = stale.Where("program_id NOT IN (?)", programIDs)
		}
		if err := stale.Delete(&DeliveryCommandWorkerWorkspace{}).Error; err != nil {
			return err
		}
		if len(workspaces) == 0 {
			return nil
		}
		return tx.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "biz_line"}, {Name: "user_id"}, {Name: "worker_id"}, {Name: "program_id"}},
			DoUpdates: clause.AssignmentColumns([]string{"updated_time"}),
		}).Create(&workspaces).Error
	})
}

// TouchCommandWorker 回答的是「这台 Worker 还在不在」，不是「改了几行」。
// last_heartbeat_at 是秒级 timestamp，同一秒里两条通道各打一次心跳时，第二次
// 更新出来的值和库里一模一样，MySQL 的 RowsAffected 就是 0——那是「没变化」，
// 不是「记录不存在」，所以 0 的时候要再确认一次存在性。
func (r *DeliveryRepository) TouchCommandWorker(ctx context.Context, bizLine, userID, workerID string) (bool, error) {
	now := time.Now()
	result := r.Db.WithContext(ctx).Model(&DeliveryCommandWorker{}).
		Where("biz_line = ?", bizLine).
		Where("user_id = ?", userID).
		Where("worker_id = ?", workerID).
		Updates(map[string]any{"last_heartbeat_at": now, "updated_time": now})
	if result.Error != nil {
		return false, result.Error
	}
	if result.RowsAffected > 0 {
		return true, nil
	}
	var count int64
	if err := r.Db.WithContext(ctx).Model(&DeliveryCommandWorker{}).
		Where("biz_line = ?", bizLine).
		Where("user_id = ?", userID).
		Where("worker_id = ?", workerID).
		Count(&count).Error; err != nil {
		return false, err
	}
	return count > 0, nil
}

func (r *DeliveryRepository) FindCommandWorker(ctx context.Context, bizLine, userID, workerID string) (*DeliveryCommandWorker, error) {
	var row DeliveryCommandWorker
	err := r.Db.WithContext(ctx).Model(&DeliveryCommandWorker{}).
		Where("biz_line = ?", bizLine).
		Where("user_id = ?", userID).
		Where("worker_id = ?", workerID).
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *DeliveryRepository) ListCommandWorkerWorkspaces(ctx context.Context, userID, workerID string) ([]*DeliveryCommandWorkerWorkspace, error) {
	var rows []*DeliveryCommandWorkerWorkspace
	err := r.Db.WithContext(ctx).Model(&DeliveryCommandWorkerWorkspace{}).
		Where("user_id = ?", userID).
		Where("worker_id = ?", workerID).
		Order("biz_line asc, program_id asc").
		Find(&rows).Error
	return rows, err
}

// FindLatestCommandWorker 回答「这个项目现在有没有执行电脑在听」。手机端在提交
// 命令之前就要知道答案，否则只能等到超时才发现插件根本没开。心跳最新的那台为准：
// 同一个人可能在两台电脑上都映射过同一个项目。
func (r *DeliveryRepository) FindLatestCommandWorker(
	ctx context.Context, bizLine, userID string, programID int64,
) (*DeliveryCommandWorker, error) {
	tx := r.Db.WithContext(ctx).Model(&DeliveryCommandWorker{}).
		Where("biz_line = ?", bizLine).
		Where("user_id = ?", userID)
	if programID > 0 {
		tx = tx.Where("worker_id IN (?)", r.Db.Model(&DeliveryCommandWorkerWorkspace{}).
			Select("worker_id").
			Where("biz_line = ?", bizLine).
			Where("user_id = ?", userID).
			Where("program_id = ?", programID))
	}
	var row DeliveryCommandWorker
	if err := tx.Order("last_heartbeat_at desc, id desc").First(&row).Error; err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *DeliveryRepository) UpdateActiveCommand(
	ctx context.Context, bizLine, userID, commandID, workerID, leaseToken string, values map[string]any, event *DeliveryCommandEvent,
) (bool, error) {
	updated := false
	err := r.Db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		values["version"] = gorm.Expr("version + 1")
		values["updated_time"] = time.Now()
		result := tx.Model(&DeliveryCommand{}).
			Where("biz_line = ?", bizLine).
			Where("user_id = ?", userID).
			Where("command_id = ?", commandID).
			Where("lease_worker_id = ?", workerID).
			Where("lease_token = ?", leaseToken).
			Where("lease_expires_at > ?", time.Now()).
			Where("state IN ?", []string{"leased", "running"}).
			Updates(values)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return nil
		}
		updated = true
		event.CreatedAt = time.Now()
		return tx.Create(event).Error
	})
	return updated, err
}

func (r *DeliveryRepository) RequestCommandCancellation(
	ctx context.Context, bizLine, userID, commandID, message string,
) (*DeliveryCommand, bool, error) {
	var result *DeliveryCommand
	changed := false
	err := r.Db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var row DeliveryCommand
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Model(&DeliveryCommand{}).
			Where("biz_line = ?", bizLine).Where("user_id = ?", userID).Where("command_id = ?", commandID).
			First(&row).Error; err != nil {
			return err
		}
		result = &row
		if row.State == "succeeded" || row.State == "failed" || row.State == "cancelled" || row.State == "timed_out" {
			return nil
		}
		values := map[string]any{"cancel_requested": true, "version": gorm.Expr("version + 1"), "updated_time": time.Now()}
		kind := "cancel_requested"
		state := row.State
		if row.State == "pending" {
			values["state"] = "cancelled"
			values["finished_at"] = time.Now()
			kind = "cancelled"
			state = "cancelled"
		}
		if err := tx.Model(&DeliveryCommand{}).Where("id = ?", row.Id).Updates(values).Error; err != nil {
			return err
		}
		if err := tx.Create(&DeliveryCommandEvent{BizLine: row.BizLine, CommandID: row.CommandID, UserID: row.UserID, Kind: kind, State: state, Message: message, DataJSON: "{}", CreatedAt: time.Now()}).Error; err != nil {
			return err
		}
		changed = true
		row.CancelRequested = true
		row.State = state
		result = &row
		return nil
	})
	return result, changed, err
}

func (r *DeliveryRepository) ListExpiredCommands(ctx context.Context, before time.Time, limit int) ([]*DeliveryCommand, error) {
	tx := r.Db.WithContext(ctx).Model(&DeliveryCommand{}).
		Where("lease_expires_at IS NOT NULL").
		Where("lease_expires_at <= ?", before).
		Where("state IN ?", []string{"leased", "running"}).
		Order("lease_expires_at asc")
	if limit > 0 {
		tx = tx.Limit(limit)
	}
	var rows []*DeliveryCommand
	err := tx.Find(&rows).Error
	return rows, err
}

func (r *DeliveryRepository) ListUnclaimedCommands(ctx context.Context, before time.Time, limit int) ([]*DeliveryCommand, error) {
	tx := r.Db.WithContext(ctx).Model(&DeliveryCommand{}).
		Where("state = ?", "pending").
		Where("cancel_requested = ?", false).
		Where("updated_time <= ?", before).
		Order("updated_time asc")
	if limit > 0 {
		tx = tx.Limit(limit)
	}
	var rows []*DeliveryCommand
	err := tx.Find(&rows).Error
	return rows, err
}

// DeleteFinishedCommands 按命令类型清理已终态的命令与其事件行。matchTypes 为真时
// 只删列出的类型，为假时删除列出的类型之外的所有命令 —— 快照命令和执行命令因此
// 能用同一段 SQL、两套留存期。每次只取一批，避免一条 DELETE 锁住整张表。
func (r *DeliveryRepository) DeleteFinishedCommands(
	ctx context.Context, before time.Time, commandTypes []string, matchTypes bool, limit int,
) (int64, error) {
	if len(commandTypes) == 0 && matchTypes {
		return 0, nil
	}
	tx := r.Db.WithContext(ctx).Model(&DeliveryCommand{}).
		Where("state IN ?", []string{"succeeded", "failed", "cancelled", "timed_out"}).
		Where("updated_time <= ?", before)
	if len(commandTypes) > 0 {
		if matchTypes {
			tx = tx.Where("command_type IN ?", commandTypes)
		} else {
			tx = tx.Where("command_type NOT IN ?", commandTypes)
		}
	}
	if limit > 0 {
		tx = tx.Limit(limit)
	}
	var rows []*DeliveryCommand
	if err := tx.Order("updated_time asc, id asc").Find(&rows).Error; err != nil {
		return 0, err
	}
	if len(rows) == 0 {
		return 0, nil
	}
	ids := make([]int64, 0, len(rows))
	// 事件表最大，删除必须走 idx_dlv_command_event_stream，而那条索引以 biz_line 打头：
	// 只按 command_id 删会退化成全表扫描，所以这里按业务线分组。
	commandIDsByBizLine := make(map[string][]string, 2)
	for _, row := range rows {
		ids = append(ids, row.Id)
		commandIDsByBizLine[row.BizLine] = append(commandIDsByBizLine[row.BizLine], row.CommandID)
	}
	err := r.Db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for bizLine, commandIDs := range commandIDsByBizLine {
			if err := tx.Where("biz_line = ?", bizLine).Where("command_id IN ?", commandIDs).
				Delete(&DeliveryCommandEvent{}).Error; err != nil {
				return err
			}
		}
		return tx.Where("id IN ?", ids).Delete(&DeliveryCommand{}).Error
	})
	if err != nil {
		return 0, err
	}
	return int64(len(ids)), nil
}

func (r *DeliveryRepository) RecoverExpiredCommand(ctx context.Context, bizLine, commandID string, before time.Time, maxAttempts int) (*DeliveryCommand, bool, error) {
	var recovered *DeliveryCommand
	changed := false
	err := r.Db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var row DeliveryCommand
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Model(&DeliveryCommand{}).
			Where("biz_line = ?", bizLine).
			Where("command_id = ?", commandID).
			Where("lease_expires_at <= ?", before).
			Where("state IN ?", []string{"leased", "running"}).
			First(&row).Error; err != nil {
			return err
		}
		state := "pending"
		kind := "lease_expired_requeued"
		message := "Worker 租约超时，已重新进入待领取队列"
		if row.AttemptCount >= maxAttempts {
			state = "timed_out"
			kind = "lease_expired_timed_out"
			message = "Worker 租约超时，已达到重新调度上限"
		}
		values := map[string]any{
			"state": state, "lease_token": "", "lease_worker_id": "", "lease_expires_at": nil,
			"version": gorm.Expr("version + 1"), "updated_time": time.Now(),
		}
		if state == "timed_out" {
			values["finished_at"] = time.Now()
		}
		if err := tx.Model(&DeliveryCommand{}).Where("id = ?", row.Id).Updates(values).Error; err != nil {
			return err
		}
		if err := tx.Create(&DeliveryCommandEvent{BizLine: row.BizLine, CommandID: row.CommandID, UserID: row.UserID, Kind: kind, State: state, Message: message, DataJSON: "{}", CreatedAt: time.Now()}).Error; err != nil {
			return err
		}
		row.State = state
		row.LeaseToken = ""
		row.LeaseWorkerID = ""
		row.LeaseExpiresAt = nil
		if state == "timed_out" {
			now := time.Now()
			row.FinishedAt = &now
		}
		recovered = &row
		changed = true
		return nil
	})
	return recovered, changed, err
}

func (r *DeliveryRepository) RecoverUnclaimedCommand(ctx context.Context, bizLine, commandID string, before time.Time, maxDispatches int) (*DeliveryCommand, bool, error) {
	var recovered *DeliveryCommand
	changed := false
	err := r.Db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var row DeliveryCommand
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Model(&DeliveryCommand{}).
			Where("biz_line = ?", bizLine).
			Where("command_id = ?", commandID).
			Where("state = ?", "pending").
			Where("cancel_requested = ?", false).
			Where("updated_time <= ?", before).
			First(&row).Error; err != nil {
			return err
		}
		state := "pending"
		kind := "dispatch_requeued"
		message := "等待 Worker 领取超过两分钟，已重新发送领取通知"
		values := map[string]any{"dispatch_count": gorm.Expr("dispatch_count + 1"), "updated_time": time.Now(), "version": gorm.Expr("version + 1")}
		if row.DispatchCount >= maxDispatches {
			state = "timed_out"
			kind = "dispatch_timed_out"
			message = "等待 Worker 领取超时，已达到重新调度上限"
			values["state"] = state
			values["finished_at"] = time.Now()
		}
		if err := tx.Model(&DeliveryCommand{}).Where("id = ?", row.Id).Updates(values).Error; err != nil {
			return err
		}
		if err := tx.Create(&DeliveryCommandEvent{BizLine: row.BizLine, CommandID: row.CommandID, UserID: row.UserID, Kind: kind, State: state, Message: message, DataJSON: "{}", CreatedAt: time.Now()}).Error; err != nil {
			return err
		}
		row.State = state
		row.DispatchCount++
		if state == "timed_out" {
			now := time.Now()
			row.FinishedAt = &now
		}
		recovered = &row
		changed = true
		return nil
	})
	return recovered, changed, err
}

// FindCommandWorkerUserForProgram resolves which console user's Worker currently
// serves one project. Business intake is submitted by the server on a business
// user's behalf; that user has no console identity and no Worker of its own, so
// its command must be filed under the owner of the Worker already mapped to the
// project. Ordering by heartbeat keeps the newest live Worker authoritative when
// several consoles have mapped the same project.
func (r *DeliveryRepository) FindCommandWorkerUserForProgram(ctx context.Context, bizLine string, programID int64, since time.Time) (string, error) {
	worker := &DeliveryCommandWorker{}
	workspace := &DeliveryCommandWorkerWorkspace{}
	var row DeliveryCommandWorker
	err := r.Db.WithContext(ctx).Model(&DeliveryCommandWorker{}).
		Joins(fmt.Sprintf(
			"JOIN %s AS ws ON ws.biz_line = %s.biz_line AND ws.user_id = %s.user_id AND ws.worker_id = %s.worker_id",
			workspace.TableName(), worker.TableName(), worker.TableName(), worker.TableName(),
		)).
		Where(fmt.Sprintf("%s.biz_line = ?", worker.TableName()), bizLine).
		Where("ws.program_id = ?", programID).
		Where(fmt.Sprintf("%s.last_heartbeat_at >= ?", worker.TableName()), since).
		Order(fmt.Sprintf("%s.last_heartbeat_at desc", worker.TableName())).
		First(&row).Error
	if err != nil {
		return "", err
	}
	return row.UserID, nil
}

// FindLatestCommandActivity reads only the newest activity a Worker reported.
// A long turn emits an activity every couple of seconds, so the ascending,
// limited event listing eventually stops containing the current snapshot; a
// caller that renders live progress needs the tail, not the head.
func (r *DeliveryRepository) FindLatestCommandActivity(ctx context.Context, bizLine, userID, commandID string) (*DeliveryCommandEvent, error) {
	var row DeliveryCommandEvent
	err := r.Db.WithContext(ctx).Model(&DeliveryCommandEvent{}).
		Where("biz_line = ?", bizLine).
		Where("user_id = ?", userID).
		Where("command_id = ?", commandID).
		Where("kind = ?", "activity").
		Order("id desc").
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}
