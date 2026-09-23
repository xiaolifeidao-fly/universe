package repository

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"gorm.io/gorm"
)

// Galaxy 账号的持久化。和任务宇宙的 zt_identity_user 没有任何往来：
// 这里不读、不写、不 join 那边的表。
//
// 两端两张表：共享端 zt_galaxy_provider_user，使用端 zt_galaxy_consumer_user。
// 所以这里每个方法都要一个 side —— 拿不出端就查不了账号。这正是分表想要的：
// 没有「不带端」的查法，也就不会有哪次查询漏掉端、把另一端的人捞出来。
//
// 读写都用 Table(...) 指定表名、扫进 GalaxyUser：两个表类型都由它派生，列一模一样，
// 各写一遍只会让两边慢慢长歪。表名统一从 users / usersTable 出，别在别处拼。

func IsNotFound(err error) bool { return errors.Is(err, gorm.ErrRecordNotFound) }

// usersTable 端对应的表名。端不认识返回空串，由调用方翻成错误。
func usersTable(side string) string {
	switch side {
	case SideProvider:
		return (&GalaxyProviderUser{}).TableName()
	case SideConsumer:
		return (&GalaxyConsumerUser{}).TableName()
	}
	return ""
}

// users 一端账号表的查询起点，已经带上 biz_line。
//
// Model 和 Table 都要：Table 决定语句落到哪张表，Model 给 GORM 那份列的定义 ——
// 少了它，Updates(map) 不知道有 updated_time 这么个 autoUpdateTime 列，
// 而库里的时间列刻意没有 ON UPDATE（见 20260908_timestamp_no_auto_update），
// 更新时间就会永远停在建号那一刻。
//
// 端不认识当场报错，不退回某一端：默认一端的话，一个拼错的 side 会安安静静地
// 在共享端里查使用端的人，查不到就报「账号不存在」，没人看得出是端传错了。
func (r *GalaxyRepository) users(ctx context.Context, bizLine, side string) (*gorm.DB, error) {
	table := usersTable(side)
	if table == "" {
		return nil, fmt.Errorf("未知的账号端: %s", side)
	}
	return r.Db.WithContext(ctx).Table(table).Model(&GalaxyUser{}).Where("biz_line = ?", bizLine), nil
}

// CreateUser 落到 row.Side 那张表。ID 与时间戳回填进 row。
func (r *GalaxyRepository) CreateUser(ctx context.Context, row *GalaxyUser) error {
	table := usersTable(row.Side)
	if table == "" {
		return fmt.Errorf("未知的账号端: %s", row.Side)
	}
	return r.Db.WithContext(ctx).Table(table).Create(row).Error
}

// FindUser 按业务键取。令牌里签的就是它。
func (r *GalaxyRepository) FindUser(ctx context.Context, bizLine, side, userID string) (*GalaxyUser, error) {
	tx, err := r.users(ctx, bizLine, side)
	if err != nil {
		return nil, err
	}
	return firstUser(tx.Where("user_id = ?", userID), side)
}

// FindUserByName 登录与注册查重的入口。
func (r *GalaxyRepository) FindUserByName(ctx context.Context, bizLine, side, username string) (*GalaxyUser, error) {
	tx, err := r.users(ctx, bizLine, side)
	if err != nil {
		return nil, err
	}
	return firstUser(tx.Where("username = ?", username), side)
}

// firstUser 取一行并补上 Side —— 库里没有这一列，它由这一行来自哪张表决定。
func firstUser(tx *gorm.DB, side string) (*GalaxyUser, error) {
	var row GalaxyUser
	if err := tx.First(&row).Error; err != nil {
		return nil, err
	}
	row.Side = side
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
func (r *GalaxyRepository) BumpTokenVersion(ctx context.Context, bizLine, side, userID string, values map[string]any) error {
	tx, err := r.users(ctx, bizLine, side)
	if err != nil {
		return err
	}
	updates := map[string]any{"token_version": gorm.Expr("token_version + 1")}
	for column, value := range values {
		updates[column] = value
	}
	result := tx.Where("user_id = ?", userID).Updates(updates)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

func (r *GalaxyRepository) TouchUserLogin(ctx context.Context, bizLine, side, userID string, at time.Time) error {
	tx, err := r.users(ctx, bizLine, side)
	if err != nil {
		return err
	}
	return tx.Where("user_id = ?", userID).Update("last_login_at", at).Error
}

// UserQuery 运营的账号列表。Side 必填：两端是两张表，不说查哪张就无从查起。
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
	tx, err := r.users(ctx, query.BizLine, query.Side)
	if err != nil {
		return nil, 0, err
	}
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
	if err := tx.Order("created_time desc").Offset(query.Offset).Limit(query.Limit).Find(&rows).Error; err != nil {
		return nil, 0, err
	}
	for _, row := range rows {
		row.Side = query.Side
	}
	return rows, total, nil
}

// ListUsersByIDs 批量取一端的账号，给列表视图补上「这台机器是谁的」。
// 不存在的 id 不在结果里 —— 另一端的 id 传进来也一样查不到，这是对的。
func (r *GalaxyRepository) ListUsersByIDs(ctx context.Context, bizLine, side string, userIDs []string) ([]*GalaxyUser, error) {
	if len(userIDs) == 0 {
		return nil, nil
	}
	tx, err := r.users(ctx, bizLine, side)
	if err != nil {
		return nil, err
	}
	var rows []*GalaxyUser
	if err := tx.Where("user_id IN ?", userIDs).Find(&rows).Error; err != nil {
		return nil, err
	}
	for _, row := range rows {
		row.Side = side
	}
	return rows, nil
}

// consumersByKeyword 按关键字（用户名、昵称，或者整个账号 id）匹配使用端账号，
// 只 Select user_id，给别的表当「按主人搜」的子查询用 —— 积分流水和算力密钥都要它。
//
// 写死使用端：这两张表的主人只可能是消费者。共享端的人在这里搜不到，也不该搜到。
func (r *GalaxyRepository) consumersByKeyword(bizLine, keyword string) *gorm.DB {
	like := "%" + escapeLike(keyword) + "%"
	return r.Db.Table(usersTable(SideConsumer)).Select("user_id").
		Where("biz_line = ?", bizLine).
		Where("(username LIKE ? OR display_name LIKE ? OR user_id = ?)", like, like, keyword)
}

// escapeLike 关键字里的 % 和 _ 按字面量搜。不转义的话搜一个下划线等于搜全部。
func escapeLike(value string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(value)
}
