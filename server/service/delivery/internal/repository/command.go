package repository

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type CommandQuery struct {
	BizLine   string
	UserID    string
	ProgramID int64
	State     string
	Offset    int
	Limit     int
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

func (r *DeliveryRepository) UpsertCommandWorker(
	ctx context.Context, row *DeliveryCommandWorker, workspaces []*DeliveryCommandWorkerWorkspace,
) error {
	now := time.Now()
	return r.Db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var existing DeliveryCommandWorker
		err := tx.Model(&DeliveryCommandWorker{}).
			Where("biz_line = ?", row.BizLine).
			Where("user_id = ?", row.UserID).
			Where("worker_id = ?", row.WorkerID).
			First(&existing).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			row.CreatedTime = now
			row.UpdatedTime = now
			row.LastHeartbeatAt = now
			if err := tx.Create(row).Error; err != nil {
				return err
			}
		} else if err != nil {
			return err
		} else if err := tx.Model(&existing).Updates(map[string]any{
			"display_name": row.DisplayName, "capabilities_json": row.CapabilitiesJSON,
			"last_heartbeat_at": now, "updated_time": now,
		}).Error; err != nil {
			return err
		}
		if err := tx.Where("biz_line = ?", row.BizLine).
			Where("user_id = ?", row.UserID).
			Where("worker_id = ?", row.WorkerID).
			Delete(&DeliveryCommandWorkerWorkspace{}).Error; err != nil {
			return err
		}
		for _, workspace := range workspaces {
			workspace.CreatedTime = now
			workspace.UpdatedTime = now
		}
		if len(workspaces) > 0 {
			return tx.Create(&workspaces).Error
		}
		return nil
	})
}

func (r *DeliveryRepository) TouchCommandWorker(ctx context.Context, bizLine, userID, workerID string) (int64, error) {
	result := r.Db.WithContext(ctx).Model(&DeliveryCommandWorker{}).
		Where("biz_line = ?", bizLine).
		Where("user_id = ?", userID).
		Where("worker_id = ?", workerID).
		Updates(map[string]any{"last_heartbeat_at": time.Now(), "updated_time": time.Now()})
	return result.RowsAffected, result.Error
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
