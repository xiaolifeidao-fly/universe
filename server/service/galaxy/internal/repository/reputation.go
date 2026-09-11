package repository

import (
	"context"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// AdjustReputation 给这几份信誉记录加减分，每一份都顺带把上次结算以来回升的部分结进来。
//
// 回升和扣分必须在同一条语句里算完。先读出来在 Go 里算、再写回去的话，两次并发的扣分
// （同一台机器同时掉了两个请求）会互相覆盖，丢掉一次。
//
// 几份之间不包事务：扣分本来就是尽力而为（调用方不看错误），账号那份记上了、设备那份
// 没记上，最坏是某一份少扣一次，不值得为它把这条路径拖进事务。没有行就按满分起算建一行。
func (r *GalaxyRepository) AdjustReputation(ctx context.Context, bizLine string, subjects []string, delta, recoveryPerDay float64, at time.Time) error {
	for _, subject := range subjects {
		err := r.Db.WithContext(ctx).Clauses(clause.OnConflict{
			Columns: []clause.Column{{Name: "biz_line"}, {Name: "subject"}},
			// 顺序不能换：MySQL 从左到右赋值，右边的表达式看到的是左边刚写进去的值。
			// reputation 算回升要用**旧的** reputation_at，所以它必须排在 reputation_at 前面。
			DoUpdates: clause.Set{
				{Column: clause.Column{Name: "reputation"}, Value: gorm.Expr(
					"GREATEST(0, LEAST(1, LEAST(1, reputation + ? * GREATEST(0, TIMESTAMPDIFF(SECOND, COALESCE(reputation_at, ?), ?)) / 86400) + ?))",
					recoveryPerDay, at, at, delta)},
				{Column: clause.Column{Name: "reputation_at"}, Value: at},
				{Column: clause.Column{Name: "updated_time"}, Value: at},
			},
		}).Create(&GalaxyReputation{
			BizLine: bizLine, Subject: subject, Reputation: clampScore(1 + delta), ReputationAt: at,
		}).Error
		if err != nil {
			return err
		}
	}
	return nil
}

// ListReputations 按主体批量取。没有行的主体不在结果里，调用方按满分算。
func (r *GalaxyRepository) ListReputations(ctx context.Context, bizLine string, subjects []string) ([]*GalaxyReputation, error) {
	if len(subjects) == 0 {
		return nil, nil
	}
	var rows []*GalaxyReputation
	err := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine).Where("subject IN ?", subjects).Find(&rows).Error
	return rows, err
}

// ListProviders 这些账号的身份行。没有行的账号是散户。
func (r *GalaxyRepository) ListProviders(ctx context.Context, bizLine string, ownerUserIDs []string) ([]*GalaxyProvider, error) {
	if len(ownerUserIDs) == 0 {
		return nil, nil
	}
	var rows []*GalaxyProvider
	err := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine).Where("owner_user_id IN ?", ownerUserIDs).Find(&rows).Error
	return rows, err
}

// SaveProviderType 改账号的身份。改回散户也留着行，不删：谁、什么时候改的要查得到。
func (r *GalaxyRepository) SaveProviderType(ctx context.Context, row *GalaxyProvider) error {
	return r.Db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "biz_line"}, {Name: "owner_user_id"}},
		DoUpdates: clause.AssignmentColumns([]string{"provider_type", "updated_by", "updated_time"}),
	}).Create(row).Error
}

// FillNodeFingerprint 给还没有指纹的节点补上。只补不改：一条节点记录代表的是
// 配对时的那台机器，令牌被拷到另一台机器上，也不该顶着新机器的身份换一份信誉。
func (r *GalaxyRepository) FillNodeFingerprint(ctx context.Context, bizLine, nodeID, fingerprint string) error {
	return r.Db.WithContext(ctx).Model(&GalaxyNode{}).
		Where("biz_line = ?", bizLine).Where("node_id = ?", nodeID).
		Where("(machine_fingerprint IS NULL OR machine_fingerprint = '')").
		Update("machine_fingerprint", fingerprint).Error
}

func clampScore(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
}
