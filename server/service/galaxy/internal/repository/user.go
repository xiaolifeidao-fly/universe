package repository

import (
	"context"
	"errors"
	"strings"
	"time"

	"gorm.io/gorm"
)

// Galaxy 账号的持久化。和任务宇宙的 zt_identity_user 没有任何往来：
// 这里不读、不写、不 join 那边的表。

func IsNotFound(err error) bool { return errors.Is(err, gorm.ErrRecordNotFound) }

func (r *GalaxyRepository) CreateUser(ctx context.Context, row *GalaxyUser) error {
	return r.Db.WithContext(ctx).Create(row).Error
}

// FindUser 按业务键取。令牌里签的就是它。
func (r *GalaxyRepository) FindUser(ctx context.Context, bizLine, userID string) (*GalaxyUser, error) {
	var row GalaxyUser
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("user_id = ?", userID).
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// FindUserByName 登录与注册查重的入口。用户名按端唯一，不带端查就会拿错人。
func (r *GalaxyRepository) FindUserByName(ctx context.Context, bizLine, side, username string) (*GalaxyUser, error) {
	var row GalaxyUser
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("side = ?", side).Where("username = ?", username).
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// BumpTokenVersion 改几列，同时让这个账号已经发出去的令牌全部作废。values 的键是列名。
//
// 账号上的改动（改密码、重置、停用、启用）全都走这一个口子，没有「只改列不作废令牌」的版本：
// 这几件事每一件都要当场生效。
//
// 加一在 SQL 里做：先读出来加一再写回去，并发的两次处置（运营停用的同时本人在改密码）
// 会互相覆盖，其中一次的作废就丢了。它还顺带让 RowsAffected 在「值没变」时也不为 0 ——
// 启用一个本来就启用的账号不会被误判成账号不存在。
func (r *GalaxyRepository) BumpTokenVersion(ctx context.Context, bizLine, userID string, values map[string]any) error {
	updates := map[string]any{"token_version": gorm.Expr("token_version + 1")}
	for column, value := range values {
		updates[column] = value
	}
	result := r.Db.WithContext(ctx).Model(&GalaxyUser{}).
		Where("biz_line = ?", bizLine).Where("user_id = ?", userID).
		Updates(updates)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

func (r *GalaxyRepository) TouchUserLogin(ctx context.Context, bizLine, userID string, at time.Time) error {
	return r.Db.WithContext(ctx).Model(&GalaxyUser{}).
		Where("biz_line = ?", bizLine).Where("user_id = ?", userID).
		Update("last_login_at", at).Error
}

// UserQuery 运营的账号列表。Side 必填：两端是两批人，混在一张表里翻没有意义。
type UserQuery struct {
	BizLine string
	Side    string
	Keyword string
	Status  string
	// ProviderType 只对共享端有意义。individual 的判定是「没有工作室那一行」，
	// 因为散户在 zt_galaxy_provider 里通常没有行。
	ProviderType string
	Offset       int
	Limit        int
}

func (r *GalaxyRepository) ListUsers(ctx context.Context, query UserQuery) ([]*GalaxyUser, int64, error) {
	tx := r.Db.WithContext(ctx).Model(&GalaxyUser{}).
		Where("biz_line = ?", query.BizLine).Where("side = ?", query.Side)
	if query.Status != "" {
		tx = tx.Where("status = ?", query.Status)
	}
	if keyword := strings.TrimSpace(query.Keyword); keyword != "" {
		like := "%" + escapeLike(keyword) + "%"
		tx = tx.Where("(username LIKE ? OR display_name LIKE ? OR user_id = ?)", like, like, keyword)
	}
	if query.ProviderType != "" {
		studios := r.Db.Model(&GalaxyProvider{}).Select("owner_user_id").
			Where("biz_line = ?", query.BizLine).Where("provider_type = ?", "studio")
		if query.ProviderType == "studio" {
			tx = tx.Where("user_id IN (?)", studios)
		} else {
			tx = tx.Where("user_id NOT IN (?)", studios)
		}
	}
	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []*GalaxyUser
	err := tx.Order("created_time desc").Offset(query.Offset).Limit(query.Limit).Find(&rows).Error
	return rows, total, err
}

// ListUsersByIDs 批量取，给列表视图补上「这台机器是谁的」。不存在的 id 不在结果里。
func (r *GalaxyRepository) ListUsersByIDs(ctx context.Context, bizLine string, userIDs []string) ([]*GalaxyUser, error) {
	if len(userIDs) == 0 {
		return nil, nil
	}
	var rows []*GalaxyUser
	err := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine).Where("user_id IN ?", userIDs).Find(&rows).Error
	return rows, err
}

// escapeLike 关键字里的 % 和 _ 按字面量搜。不转义的话搜一个下划线等于搜全部。
func escapeLike(value string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(value)
}
