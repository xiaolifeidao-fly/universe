package repository

import (
	"context"
	"time"

	"gorm.io/gorm/clause"
)

type UnitQuery struct {
	BizLine     string
	ConsumerKey string
	// ConsumerKeys 是「这个人名下的全部密钥」。控制台按人查，一个人手里通常有好几把；
	// 用 IN 一次查完，省掉逐把密钥查再在内存里归并的 N+1。
	// 调用方要自己保证「这人一把密钥都没有」时根本不查 —— 空切片会被当成没有这个条件。
	ConsumerKeys []string
	CID          string
	Kind         string
	// Primitive 让 relay/session/job 在 SQL 里就分开。放内存里过滤的话，
	// LIMIT 先生效、过滤后生效，一页能被筛得几乎为空。
	Primitive string
	From      time.Time
	To        time.Time
	Offset    int
	Limit     int
}

func (r *GalaxyRepository) CreateUnit(ctx context.Context, row *GalaxyUnit, event *GalaxyUnitEvent) error {
	return r.Tx(ctx, func(tx *GalaxyRepository) error {
		if err := tx.Db.WithContext(ctx).Create(row).Error; err != nil {
			return err
		}
		if event != nil {
			return tx.Db.WithContext(ctx).Create(event).Error
		}
		return nil
	})
}

func (r *GalaxyRepository) FindUnit(ctx context.Context, bizLine, unitID string) (*GalaxyUnit, error) {
	var row GalaxyUnit
	err := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine).Where("unit_id = ?", unitID).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *GalaxyRepository) UpdateUnit(ctx context.Context, bizLine, unitID string, values map[string]any) error {
	return r.Db.WithContext(ctx).Model(&GalaxyUnit{}).
		Where("biz_line = ?", bizLine).Where("unit_id = ?", unitID).
		Updates(values).Error
}

// ListStaleUnits 找出可能已经跑丢的单元：还没到终态，但很久没有更新过。
// 索引以 state 打头而不是 biz_line —— 这是跨消费者的巡检，
// 先把状态收敛到几行之内再按时间扫描才有意义。
func (r *GalaxyRepository) ListStaleUnits(ctx context.Context, bizLine, primitive string, before time.Time, limit int) ([]*GalaxyUnit, error) {
	tx := r.Db.WithContext(ctx).Model(&GalaxyUnit{}).
		Where("biz_line = ?", bizLine).
		Where("state IN ?", []string{string("placed"), string("running"), string("streaming")}).
		Where("updated_time < ?", before)
	if primitive != "" {
		tx = tx.Where("primitive = ?", primitive)
	}
	if limit > 0 {
		tx = tx.Limit(limit)
	}
	var rows []*GalaxyUnit
	err := tx.Order("updated_time").Find(&rows).Error
	return rows, err
}

func (r *GalaxyRepository) AppendUnitEvent(ctx context.Context, row *GalaxyUnitEvent) error {
	return r.Db.WithContext(ctx).Create(row).Error
}

func (r *GalaxyRepository) ListUnitEvents(ctx context.Context, bizLine, unitID string, fromSeq int) ([]*GalaxyUnitEvent, error) {
	tx := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("unit_id = ?", unitID)
	if fromSeq > 0 {
		tx = tx.Where("seq > ?", fromSeq)
	}
	var rows []*GalaxyUnitEvent
	err := tx.Order("seq, id").Find(&rows).Error
	return rows, err
}

func (r *GalaxyRepository) ListUnits(ctx context.Context, q UnitQuery) ([]*GalaxyUnit, int64, error) {
	tx := r.Db.WithContext(ctx).Model(&GalaxyUnit{}).Where("biz_line = ?", q.BizLine)
	if q.ConsumerKey != "" {
		tx = tx.Where("consumer_key = ?", q.ConsumerKey)
	}
	if len(q.ConsumerKeys) > 0 {
		tx = tx.Where("consumer_key IN ?", q.ConsumerKeys)
	}
	if q.CID != "" {
		tx = tx.Where("cid = ?", q.CID)
	}
	if q.Kind != "" {
		tx = tx.Where("kind = ?", q.Kind)
	}
	if q.Primitive != "" {
		tx = tx.Where("primitive = ?", q.Primitive)
	}
	if !q.From.IsZero() {
		tx = tx.Where("created_time >= ?", q.From)
	}
	if !q.To.IsZero() {
		tx = tx.Where("created_time < ?", q.To)
	}
	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	if q.Limit > 0 {
		tx = tx.Offset(q.Offset).Limit(q.Limit)
	}
	var rows []*GalaxyUnit
	err := tx.Order("created_time desc, id desc").Find(&rows).Error
	return rows, total, err
}

// ---------- 计量 ----------

// SaveMeterRecords 结算流水。幂等键是 (unit_id, attempt, unit)：
// 同一次结算重放不会把用量记两遍，这是「预留—结算幂等」的落点。
func (r *GalaxyRepository) SaveMeterRecords(ctx context.Context, rows []*GalaxyMeterRecord) error {
	if len(rows) == 0 {
		return nil
	}
	return r.Db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "biz_line"}, {Name: "unit_id"}, {Name: "attempt"}, {Name: "unit"}},
		DoNothing: true,
	}).Create(rows).Error
}

// UsageRow 是用量查询的聚合结果：按 kind + 上游 + 单位求和。
type UsageRow struct {
	Kind string `gorm:"column:kind"`
	// Provider 是执行这笔用量的上游（claude_oauth / codex_chatgpt 等）。
	// 单元行被清掉或还没写上游时是空串。
	Provider string `gorm:"column:provider"`
	Unit     string `gorm:"column:unit"`
	Amount   int64  `gorm:"column:amount"`
	Calls    int64  `gorm:"column:calls"`
}

// SumUsage 按 kind + 上游 + 单位汇总用量。
//
// 上游只记在单元表上，计量流水里没有 —— 流水的幂等键是 (unit_id, attempt, unit)，
// 往里加一列冗余就多一处会和单元表对不上的事实。所以这里按 unit_id 关联回去取，
// 走的是 uk_gx_unit_id 唯一索引，每行一次点查。
// 关联用 LEFT JOIN：单元行不在了也不能把这笔用量从账单里抹掉，
// 只是上游显示成空而已。
func (r *GalaxyRepository) SumUsage(ctx context.Context, q UnitQuery) ([]UsageRow, error) {
	tx := r.Db.WithContext(ctx).
		Table((&GalaxyMeterRecord{}).TableName()+" AS m").
		Joins("LEFT JOIN "+(&GalaxyUnit{}).TableName()+" AS u ON u.biz_line = m.biz_line AND u.unit_id = m.unit_id").
		Select("m.kind AS kind, COALESCE(u.provider, '') AS provider, m.unit AS unit, " +
			"SUM(m.amount) AS amount, COUNT(DISTINCT m.unit_id) AS calls").
		Where("m.biz_line = ?", q.BizLine)
	if q.ConsumerKey != "" {
		tx = tx.Where("m.consumer_key = ?", q.ConsumerKey)
	}
	if len(q.ConsumerKeys) > 0 {
		tx = tx.Where("m.consumer_key IN ?", q.ConsumerKeys)
	}
	if q.CID != "" {
		tx = tx.Where("m.cid = ?", q.CID)
	}
	if q.Kind != "" {
		tx = tx.Where("m.kind = ?", q.Kind)
	}
	if !q.From.IsZero() {
		tx = tx.Where("m.created_at >= ?", q.From)
	}
	if !q.To.IsZero() {
		tx = tx.Where("m.created_at < ?", q.To)
	}
	var rows []UsageRow
	// 分组按 u.provider 而不是 COALESCE 的别名：别名和 u.provider 同名，
	// MySQL 在 GROUP BY 里会当成歧义列报错。NULL 与空串在分组上是同一组，结果一样。
	err := tx.Group("m.kind, u.provider, m.unit").Order("m.kind, u.provider, m.unit").Find(&rows).Error
	return rows, err
}

func (r *GalaxyRepository) SaveUsageMismatch(ctx context.Context, row *GalaxyUsageMismatch) error {
	return r.Db.WithContext(ctx).Create(row).Error
}

// ---------- 账本 ----------

func (r *GalaxyRepository) SaveConsumerLedger(ctx context.Context, rows []*GalaxyConsumerLedger) error {
	if len(rows) == 0 {
		return nil
	}
	return r.Db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "biz_line"}, {Name: "txn_id"}},
		DoNothing: true,
	}).Create(rows).Error
}

func (r *GalaxyRepository) SaveProviderLedger(ctx context.Context, rows []*GalaxyProviderLedger) error {
	if len(rows) == 0 {
		return nil
	}
	return r.Db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "biz_line"}, {Name: "txn_id"}},
		DoNothing: true,
	}).Create(rows).Error
}

func (r *GalaxyRepository) SavePlatformLedger(ctx context.Context, rows []*GalaxyPlatformLedger) error {
	if len(rows) == 0 {
		return nil
	}
	return r.Db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "biz_line"}, {Name: "txn_id"}},
		DoNothing: true,
	}).Create(rows).Error
}

// AddCredit 提供者积分入账。P1 只记账，P2 接提现。
func (r *GalaxyRepository) AddCredit(ctx context.Context, bizLine, ownerUserID string, amount int64) error {
	if amount == 0 || ownerUserID == "" {
		return nil
	}
	return r.Db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "biz_line"}, {Name: "owner_user_id"}},
		DoUpdates: clause.Assignments(map[string]any{"balance": clause.Expr{SQL: "zt_galaxy_credit_account.balance + ?", Vars: []any{amount}}}),
	}).Create(&GalaxyCreditAccount{BizLine: bizLine, OwnerUserID: ownerUserID, Balance: amount}).Error
}

func (r *GalaxyRepository) FindCreditAccount(ctx context.Context, bizLine, ownerUserID string) (*GalaxyCreditAccount, error) {
	var row GalaxyCreditAccount
	err := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine).Where("owner_user_id = ?", ownerUserID).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// ---------- 定价 ----------

func (r *GalaxyRepository) ListEffectivePrices(ctx context.Context, bizLine string, at time.Time) ([]*GalaxyPrice, error) {
	var rows []*GalaxyPrice
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("effective_from <= ?", at).
		Order("kind, unit, effective_from desc").Find(&rows).Error
	return rows, err
}

func (r *GalaxyRepository) SavePrice(ctx context.Context, row *GalaxyPrice) error {
	return r.Db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "biz_line"}, {Name: "kind"}, {Name: "unit"}, {Name: "effective_from"}},
		DoUpdates: clause.AssignmentColumns([]string{"price", "currency", "provider_share"}),
	}).Create(row).Error
}

// ---------- 产物 ----------

func (r *GalaxyRepository) SaveArtifact(ctx context.Context, row *GalaxyArtifact) error {
	return r.Db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "biz_line"}, {Name: "object_key"}},
		DoUpdates: clause.AssignmentColumns([]string{"unit_id", "owner_key", "kind", "size", "sha256", "content_type", "expires_at"}),
	}).Create(row).Error
}

func (r *GalaxyRepository) FindArtifact(ctx context.Context, bizLine, objectKey string) (*GalaxyArtifact, error) {
	var row GalaxyArtifact
	err := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine).Where("object_key = ?", objectKey).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}
