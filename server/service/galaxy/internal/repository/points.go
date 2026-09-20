package repository

import (
	"context"
	"strings"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// 使用者积分、邀请关系与运营开关的持久化。
//
// 改余额的两个方法（CreditPoints / DebitPoints）都要在 Tx 里和那一行流水一起调：
// 它们回的 balance_after 是本事务里读到的值，脱离事务读，并发的另一笔会让它对不上。

// ---------- 积分余额 ----------

func (r *GalaxyRepository) FindPointsAccount(ctx context.Context, bizLine, ownerUserID string) (*GalaxyPointsAccount, error) {
	var row GalaxyPointsAccount
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("owner_user_id = ?", ownerUserID).
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// SumPointsBalances 一次取回几个人的余额。运营翻密钥、翻账号时一页查一次，
// 不按行查 —— 一页二十行就是二十次往返。查不到的人不出现在结果里，按 0 读。
func (r *GalaxyRepository) SumPointsBalances(ctx context.Context, bizLine string, ownerUserIDs []string) (map[string]int64, error) {
	balances := map[string]int64{}
	ids := uniqueNonEmpty(ownerUserIDs)
	if len(ids) == 0 {
		return balances, nil
	}
	var rows []*GalaxyPointsAccount
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("owner_user_id IN ?", ids).
		Find(&rows).Error
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		balances[row.OwnerUserID] = row.Balance
	}
	return balances, nil
}

func uniqueNonEmpty(values []string) []string {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

// CreditPoints 加积分，账户不存在就建。返回加完之后的余额。
func (r *GalaxyRepository) CreditPoints(ctx context.Context, bizLine, ownerUserID string, amount int64) (int64, error) {
	err := r.Db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "biz_line"}, {Name: "owner_user_id"}},
		DoUpdates: clause.Assignments(map[string]any{
			"balance":      clause.Expr{SQL: "zt_galaxy_points_account.balance + ?", Vars: []any{amount}},
			"updated_time": time.Now(),
		}),
	}).Create(&GalaxyPointsAccount{BizLine: bizLine, OwnerUserID: ownerUserID, Balance: amount}).Error
	if err != nil {
		return 0, err
	}
	row, err := r.FindPointsAccount(ctx, bizLine, ownerUserID)
	if err != nil {
		return 0, err
	}
	return row.Balance, nil
}

// DebitPoints 扣积分。条件更新保证不会扣成负数：第一个返回值为假就是余额不够（含账户不存在）。
func (r *GalaxyRepository) DebitPoints(ctx context.Context, bizLine, ownerUserID string, amount int64) (bool, int64, error) {
	result := r.Db.WithContext(ctx).Model(&GalaxyPointsAccount{}).
		Where("biz_line = ?", bizLine).Where("owner_user_id = ?", ownerUserID).
		Where("balance >= ?", amount).
		UpdateColumns(map[string]any{"balance": gorm.Expr("balance - ?", amount), "updated_time": time.Now()})
	if result.Error != nil {
		return false, 0, result.Error
	}
	if result.RowsAffected == 0 {
		return false, 0, nil
	}
	row, err := r.FindPointsAccount(ctx, bizLine, ownerUserID)
	if err != nil {
		return false, 0, err
	}
	return true, row.Balance, nil
}

// ---------- 积分流水 ----------

// InsertPointsLedger 写一行流水。txn_id 撞了就什么都不写，返回 false ——
// 调用方据此回滚同一事务里的余额变动，这样重放一次请求不会多记一笔钱。
func (r *GalaxyRepository) InsertPointsLedger(ctx context.Context, row *GalaxyPointsLedger) (bool, error) {
	result := r.Db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "biz_line"}, {Name: "txn_id"}},
		DoNothing: true,
	}).Create(row)
	if result.Error != nil {
		return false, result.Error
	}
	return result.RowsAffected > 0, nil
}

func (r *GalaxyRepository) FindPointsLedger(ctx context.Context, bizLine, txnID string) (*GalaxyPointsLedger, error) {
	var row GalaxyPointsLedger
	err := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine).Where("txn_id = ?", txnID).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// PointsLedgerQuery 流水的过滤条件。OwnerKeyword 是运营按人找：模糊匹配使用端的用户名 / 昵称，或者精确匹配账号 id。
type PointsLedgerQuery struct {
	BizLine      string
	OwnerUserID  string
	OwnerKeyword string
	Types        []string
	Offset       int
	Limit        int
}

func (r *GalaxyRepository) ListPointsLedger(ctx context.Context, query PointsLedgerQuery) ([]*GalaxyPointsLedger, int64, error) {
	tx := r.Db.WithContext(ctx).Model(&GalaxyPointsLedger{}).Where("biz_line = ?", query.BizLine)
	if query.OwnerUserID != "" {
		tx = tx.Where("owner_user_id = ?", query.OwnerUserID)
	}
	if keyword := strings.TrimSpace(query.OwnerKeyword); keyword != "" {
		tx = tx.Where("owner_user_id IN (?)", r.consumersByKeyword(query.BizLine, keyword))
	}
	if len(query.Types) > 0 {
		tx = tx.Where("type IN ?", query.Types)
	}
	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []*GalaxyPointsLedger
	err := tx.Order("created_at desc, id desc").Offset(query.Offset).Limit(query.Limit).Find(&rows).Error
	return rows, total, err
}

// sumAmount 积分合计显式转成整数：SUM 的结果类型各家实现不一（MySQL 给 DECIMAL，
// 有的引擎给浮点），积分是钱，不能有一步经过浮点。
const sumAmount = "CAST(SUM(amount) AS SIGNED) AS amount"

// SumPointsByType 一个人每种流水的合计（带符号），积分页顶上那排数字从这里来。
func (r *GalaxyRepository) SumPointsByType(ctx context.Context, bizLine, ownerUserID string) (map[string]int64, error) {
	var rows []struct {
		Type   string
		Amount int64
	}
	err := r.Db.WithContext(ctx).Model(&GalaxyPointsLedger{}).
		Where("biz_line = ?", bizLine).Where("owner_user_id = ?", ownerUserID).
		Select("type, " + sumAmount).Group("type").Scan(&rows).Error
	sums := make(map[string]int64, len(rows))
	for _, row := range rows {
		sums[row.Type] = row.Amount
	}
	return sums, err
}

// SumReferralByInvitee 邀请人从每个被邀请人身上各拿到了多少返现。
func (r *GalaxyRepository) SumReferralByInvitee(ctx context.Context, bizLine, inviterID string, inviteeIDs []string) (map[string]int64, error) {
	sums := map[string]int64{}
	if len(inviteeIDs) == 0 {
		return sums, nil
	}
	var rows []struct {
		RelatedUserID string
		Amount        int64
	}
	err := r.Db.WithContext(ctx).Model(&GalaxyPointsLedger{}).
		Where("biz_line = ?", bizLine).Where("owner_user_id = ?", inviterID).
		Where("type = ?", "referral").Where("related_user_id IN ?", inviteeIDs).
		Select("related_user_id, " + sumAmount).Group("related_user_id").Scan(&rows).Error
	for _, row := range rows {
		sums[row.RelatedUserID] = row.Amount
	}
	return sums, err
}

// ---------- 邀请关系 ----------

func (r *GalaxyRepository) FindReferralByUser(ctx context.Context, bizLine, userID string) (*GalaxyReferral, error) {
	var row GalaxyReferral
	err := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine).Where("user_id = ?", userID).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *GalaxyRepository) FindReferralByCode(ctx context.Context, bizLine, code string) (*GalaxyReferral, error) {
	var row GalaxyReferral
	err := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine).Where("invite_code = ?", code).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// CreateReferral 建一行邀请关系。user_id 或邀请码撞了唯一键都不写，返回 false，
// 由调用方决定是换一个码重试，还是去读已经存在的那一行。
func (r *GalaxyRepository) CreateReferral(ctx context.Context, row *GalaxyReferral) (bool, error) {
	result := r.Db.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(row)
	if result.Error != nil {
		return false, result.Error
	}
	return result.RowsAffected > 0, nil
}

func (r *GalaxyRepository) CountInvitees(ctx context.Context, bizLine, inviterID string) (int64, error) {
	var total int64
	err := r.Db.WithContext(ctx).Model(&GalaxyReferral{}).
		Where("biz_line = ?", bizLine).Where("invited_by = ?", inviterID).
		Count(&total).Error
	return total, err
}

// ListInvitees 用了这个人邀请码注册的账号，新的在前。
func (r *GalaxyRepository) ListInvitees(ctx context.Context, bizLine, inviterID string, offset, limit int) ([]*GalaxyReferral, int64, error) {
	tx := r.Db.WithContext(ctx).Model(&GalaxyReferral{}).
		Where("biz_line = ?", bizLine).Where("invited_by = ?", inviterID)
	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []*GalaxyReferral
	err := tx.Order("created_time desc, id desc").Offset(offset).Limit(limit).Find(&rows).Error
	return rows, total, err
}

// ---------- 运营开关 ----------

func (r *GalaxyRepository) FindSetting(ctx context.Context, bizLine, key string) (*GalaxySetting, error) {
	var row GalaxySetting
	err := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine).Where("setting_key = ?", key).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *GalaxyRepository) SaveSetting(ctx context.Context, row *GalaxySetting) error {
	return r.Db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "biz_line"}, {Name: "setting_key"}},
		DoUpdates: clause.AssignmentColumns([]string{"value", "updated_by", "updated_time"}),
	}).Create(row).Error
}

// ListSettings 全部运营开关。表很小（几十行），一次取完 ——
// 逐个 FindSetting 会让「把配置读一遍」变成几十次往返，而这件事每隔十几秒就要做一次。
func (r *GalaxyRepository) ListSettings(ctx context.Context, bizLine string) ([]*GalaxySetting, error) {
	var rows []*GalaxySetting
	err := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine).Order("setting_key").Find(&rows).Error
	return rows, err
}

// DeleteSetting 删掉一行开关，让这一项退回配置文件里的值。
//
// 「改回默认」不能靠写一个默认值进去：默认值是配置文件给的，各环境不一样，
// 而且它还会随版本变。删掉那一行，读的时候自然就落回底下那一层。
func (r *GalaxyRepository) DeleteSetting(ctx context.Context, bizLine, key string) error {
	return r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("setting_key = ?", key).
		Delete(&GalaxySetting{}).Error
}

// ---------- 运营的密钥列表 ----------

// ConsumerKeyPageQuery 管理端翻全站的算力密钥。Keyword 匹配密钥 id、别名，或者主人的用户名 / 昵称 / 账号 id。
type ConsumerKeyPageQuery struct {
	BizLine     string
	OwnerUserID string
	Keyword     string
	Status      string
	Offset      int
	Limit       int
}

func (r *GalaxyRepository) ListConsumerKeyPage(ctx context.Context, query ConsumerKeyPageQuery) ([]*GalaxyConsumerKey, int64, error) {
	tx := r.Db.WithContext(ctx).Model(&GalaxyConsumerKey{}).Where("biz_line = ?", query.BizLine)
	if query.OwnerUserID != "" {
		tx = tx.Where("owner_user_id = ?", query.OwnerUserID)
	}
	if query.Status != "" {
		tx = tx.Where("status = ?", query.Status)
	}
	if keyword := strings.TrimSpace(query.Keyword); keyword != "" {
		like := "%" + escapeLike(keyword) + "%"
		owners := r.consumersByKeyword(query.BizLine, keyword)
		tx = tx.Where("(key_id = ? OR alias LIKE ? OR owner_user_id IN (?))", keyword, like, owners)
	}
	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []*GalaxyConsumerKey
	err := tx.Order("created_time desc, id desc").Offset(query.Offset).Limit(query.Limit).Find(&rows).Error
	return rows, total, err
}
