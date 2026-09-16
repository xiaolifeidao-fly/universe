package repository

import (
	"context"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// 共享端的邀请关系与邀请奖励。
//
// 和使用端那套（points.go 里的 GalaxyReferral）是两张表、两套邀请码：两端是两批人，
// 码混在一个命名空间里时，一个共享端的码被填进使用端的注册页会「查得到但返错人」。

// CreateProviderReferral 建一行邀请关系。user_id 或邀请码撞了唯一键都不写，返回 false，
// 由调用方决定是换一个码重试，还是去读已经存在的那一行。
func (r *GalaxyRepository) CreateProviderReferral(ctx context.Context, row *GalaxyProviderReferral) (bool, error) {
	result := r.Db.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(row)
	if result.Error != nil {
		return false, result.Error
	}
	return result.RowsAffected > 0, nil
}

func (r *GalaxyRepository) FindProviderReferralByUser(ctx context.Context, bizLine, userID string) (*GalaxyProviderReferral, error) {
	var row GalaxyProviderReferral
	err := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine).Where("user_id = ?", userID).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *GalaxyRepository) FindProviderReferralByCode(ctx context.Context, bizLine, code string) (*GalaxyProviderReferral, error) {
	var row GalaxyProviderReferral
	err := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine).Where("invite_code = ?", code).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *GalaxyRepository) CountProviderInvitees(ctx context.Context, bizLine, inviterID string) (int64, error) {
	var total int64
	err := r.Db.WithContext(ctx).Model(&GalaxyProviderReferral{}).
		Where("biz_line = ?", bizLine).Where("invited_by = ?", inviterID).
		Count(&total).Error
	return total, err
}

// ListProviderInvitees 用了这个人邀请码注册的共享端账号，新的在前。
func (r *GalaxyRepository) ListProviderInvitees(ctx context.Context, bizLine, inviterID string, offset, limit int) ([]*GalaxyProviderReferral, int64, error) {
	tx := r.Db.WithContext(ctx).Model(&GalaxyProviderReferral{}).
		Where("biz_line = ?", bizLine).Where("invited_by = ?", inviterID)
	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []*GalaxyProviderReferral
	err := tx.Order("created_time desc, id desc").Offset(offset).Limit(limit).Find(&rows).Error
	return rows, total, err
}

// ReferralReward 邀请人从某一个被邀请人身上拿到的奖励合计与最近一次的时间。
type ReferralReward struct {
	InviteeUserID string    `gorm:"column:related_user_id"`
	Amount        int64     `gorm:"column:amount"`
	LastAt        time.Time `gorm:"column:last_at"`
}

// SumProviderReferralByInvitee 按被邀请人汇总奖励。
//
// 两种类型一起加：ref_clawback 是负数（申诉成立时按原额反向记一笔），
// 所以求和就是净额，不用调用方自己去减。
func (r *GalaxyRepository) SumProviderReferralByInvitee(ctx context.Context, bizLine, inviterID string, inviteeIDs []string) (map[string]ReferralReward, error) {
	rewards := map[string]ReferralReward{}
	if len(inviteeIDs) == 0 {
		return rewards, nil
	}
	var rows []ReferralReward
	err := r.Db.WithContext(ctx).Model(&GalaxyProviderLedger{}).
		Where("biz_line = ?", bizLine).Where("owner_user_id = ?", inviterID).
		Where("type IN ?", []string{"referral", "ref_clawback"}).
		Where("related_user_id IN ?", inviteeIDs).
		Select("related_user_id, SUM(amount) AS amount, MAX(created_at) AS last_at").
		Group("related_user_id").Scan(&rows).Error
	for _, row := range rows {
		rewards[row.InviteeUserID] = row
	}
	return rewards, err
}

// FindProviderLedgerByTxn 按幂等键取一行。申诉追回时用它找回当初那笔奖励
// —— 反向流水必须按**当初真的给出去的那个数**记，重算一遍会因为比例改过而对不上。
func (r *GalaxyRepository) FindProviderLedgerByTxn(ctx context.Context, bizLine, txnID string) (*GalaxyProviderLedger, error) {
	var row GalaxyProviderLedger
	err := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine).Where("txn_id = ?", txnID).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// OwnerHasMachine 这个账号名下有没有过某一台设备（按设备指纹认，解绑掉的也算）。
//
// 邀请奖励要靠它挡住「自己邀请自己的小号」：奖励是平台额外发的，把机器挂到
// 被邀请的小号名下就能白拿一笔。指纹是节点自报的，挡不住改过的客户端，
// 但挡得住「同一台机器换个账号再配一次」这种顺手就能做的事。
func (r *GalaxyRepository) OwnerHasMachine(ctx context.Context, bizLine, ownerUserID, fingerprint string) (bool, error) {
	if fingerprint == "" || ownerUserID == "" {
		return false, nil
	}
	var total int64
	err := r.Db.WithContext(ctx).Model(&GalaxyNode{}).
		Where("biz_line = ?", bizLine).
		Where("owner_user_id = ?", ownerUserID).
		Where("machine_fingerprint = ?", fingerprint).
		Limit(1).Count(&total).Error
	return total > 0, err
}

// ---------- 邀请返现：运营侧 ----------

// InviterStat 一个邀请人的战绩：拉来几个人、平台为此付出多少。
type InviterStat struct {
	InviterID string `gorm:"column:invited_by"`
	Invitees  int64  `gorm:"column:invitees"`
}

// TopInviters 按拉来的人数排的邀请人。side 决定查哪一端的关系表。
//
// 排行在 SQL 里做：这张表一行一个注册账号，为了数一下拉回内存等于把全站账号拉一遍。
// invited_by 为空的是自己注册的，不算邀请人 —— 不排除的话排第一的永远是那个空字符串。
func (r *GalaxyRepository) TopInviters(ctx context.Context, bizLine, side string, limit int) ([]InviterStat, error) {
	var rows []InviterStat
	tx := r.Db.WithContext(ctx).Model(referralModel(side)).
		Where("biz_line = ?", bizLine).Where("invited_by <> ?", "").
		Select("invited_by, COUNT(*) AS invitees").
		Group("invited_by").Order("invitees desc")
	if limit > 0 {
		tx = tx.Limit(limit)
	}
	err := tx.Scan(&rows).Error
	return rows, err
}

// ReferralRow 一行邀请关系，两端同构。
type ReferralRow struct {
	UserID      string    `gorm:"column:user_id"`
	InviteCode  string    `gorm:"column:invite_code"`
	InvitedBy   string    `gorm:"column:invited_by"`
	CreatedTime time.Time `gorm:"column:created_time"`
}

// AdminReferralQuery 运营翻邀请关系的过滤条件。
type AdminReferralQuery struct {
	BizLine string
	// Side consumer / provider。两端是两张表、两套码，码不通用。
	Side string
	// InviterID 只看这个人拉来的。
	InviterID string
	// Keyword 按账号 id 或邀请码模糊找。
	Keyword string
	// InvitedOnly 只看「被人邀请来的」，滤掉自己注册的那一大批。
	InvitedOnly bool
	Offset      int
	Limit       int
}

// referralModel side 决定查哪张表。两端是两批人、两张表，混查会把
// 共享端的 pu_ 和使用端的 cu_ 拌在一起 —— 那两个 id 空间本来就没有关系。
func referralModel(side string) any {
	if side == "provider" {
		return &GalaxyProviderReferral{}
	}
	return &GalaxyReferral{}
}

func (r *GalaxyRepository) adminReferralScope(query AdminReferralQuery) *gorm.DB {
	tx := r.Db.Model(referralModel(query.Side)).Where("biz_line = ?", query.BizLine)
	if query.InviterID != "" {
		tx = tx.Where("invited_by = ?", query.InviterID)
	} else if query.InvitedOnly {
		tx = tx.Where("invited_by <> ?", "")
	}
	if query.Keyword != "" {
		like := "%" + query.Keyword + "%"
		tx = tx.Where("user_id LIKE ? OR invite_code LIKE ? OR invited_by LIKE ?", like, like, like)
	}
	return tx
}

// ListAdminReferrals 分页列邀请关系。
func (r *GalaxyRepository) ListAdminReferrals(ctx context.Context, query AdminReferralQuery) ([]ReferralRow, int64, error) {
	var total int64
	if err := r.adminReferralScope(query).WithContext(ctx).Count(&total).Error; err != nil {
		return nil, 0, err
	}
	tx := r.adminReferralScope(query).WithContext(ctx).
		Select("user_id", "invite_code", "invited_by", "created_time").
		Order("created_time desc, id desc")
	if query.Limit > 0 {
		tx = tx.Limit(query.Limit).Offset(query.Offset)
	}
	var rows []ReferralRow
	err := tx.Scan(&rows).Error
	return rows, total, err
}

// SumReferralPayouts 这些邀请人各自总共被返了多少。
//
// 使用端记在积分账本、共享端记在供给侧账本 —— 两本账两张表，按 side 分叉。
// 共享端把 ref_clawback（申诉成立时的反向流水，负数）一起加进来，求和就是净额。
func (r *GalaxyRepository) SumReferralPayouts(ctx context.Context, bizLine, side string, inviterIDs []string) (map[string]int64, error) {
	sums := map[string]int64{}
	if len(inviterIDs) == 0 {
		return sums, nil
	}
	var rows []struct {
		OwnerUserID string
		Amount      int64
	}
	tx := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine).Where("owner_user_id IN ?", inviterIDs)
	if side == "provider" {
		tx = tx.Model(&GalaxyProviderLedger{}).Where("type IN ?", []string{"referral", "ref_clawback"})
	} else {
		tx = tx.Model(&GalaxyPointsLedger{}).Where("type = ?", "referral")
	}
	err := tx.Select("owner_user_id, SUM(amount) AS amount").Group("owner_user_id").Scan(&rows).Error
	for _, row := range rows {
		sums[row.OwnerUserID] = row.Amount
	}
	return sums, err
}
