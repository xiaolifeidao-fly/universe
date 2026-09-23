package repository

import (
	"context"
	"strings"
	"time"
)

func (r *ManagerRepository) CreateUser(ctx context.Context, row *ManagerUser) error {
	return r.Db.WithContext(ctx).Create(row).Error
}

func (r *ManagerRepository) FindUser(ctx context.Context, userID string) (*ManagerUser, error) {
	var row ManagerUser
	err := r.Db.WithContext(ctx).Where("user_id = ?", userID).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *ManagerRepository) FindUserByUsername(ctx context.Context, username string) (*ManagerUser, error) {
	var row ManagerUser
	err := r.Db.WithContext(ctx).Where("username = ?", strings.TrimSpace(username)).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *ManagerRepository) UpdateUser(ctx context.Context, userID string, values map[string]any) error {
	return r.Db.WithContext(ctx).Model(&ManagerUser{}).
		Where("user_id = ?", userID).Updates(values).Error
}

// UserQuery 账号列表的过滤条件。
type UserQuery struct {
	Keyword string
	Status  string
	Offset  int
	Limit   int
}

func (r *ManagerRepository) ListUsers(ctx context.Context, q UserQuery) ([]*ManagerUser, int64, error) {
	tx := r.Db.WithContext(ctx).Model(&ManagerUser{})
	if keyword := strings.TrimSpace(q.Keyword); keyword != "" {
		like := "%" + keyword + "%"
		tx = tx.Where("username LIKE ? OR display_name LIKE ?", like, like)
	}
	if q.Status != "" {
		tx = tx.Where("status = ?", q.Status)
	}
	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	if q.Limit > 0 {
		tx = tx.Offset(q.Offset).Limit(q.Limit)
	}
	var rows []*ManagerUser
	err := tx.Order("created_time desc, id desc").Find(&rows).Error
	return rows, total, err
}

func (r *ManagerRepository) DeleteUser(ctx context.Context, userID string) error {
	return r.Tx(ctx, func(tx *ManagerRepository) error {
		row, err := tx.FindUser(ctx, userID)
		if err != nil {
			return err
		}
		if err := tx.Db.WithContext(ctx).Where("user_id = ?", row.ID).Delete(&ManagerUserRole{}).Error; err != nil {
			return err
		}
		return tx.Db.WithContext(ctx).Where("user_id = ?", userID).Delete(&ManagerUser{}).Error
	})
}

func (r *ManagerRepository) TouchLogin(ctx context.Context, userID string, at time.Time) error {
	return r.Db.WithContext(ctx).Model(&ManagerUser{}).
		Where("user_id = ?", userID).Update("last_login_at", at).Error
}

func (r *ManagerRepository) SaveLoginRecord(ctx context.Context, row *ManagerLoginRecord) error {
	return r.Db.WithContext(ctx).Create(row).Error
}

func (r *ManagerRepository) ListLoginRecords(ctx context.Context, userID string, limit int) ([]*ManagerLoginRecord, error) {
	tx := r.Db.WithContext(ctx)
	if userID != "" {
		tx = tx.Where("user_id = ?", userID)
	}
	if limit > 0 {
		tx = tx.Limit(limit)
	}
	var rows []*ManagerLoginRecord
	err := tx.Order("created_time desc, id desc").Find(&rows).Error
	return rows, err
}
