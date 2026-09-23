package repository

import (
	"context"
	"time"

	"gorm.io/gorm"
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
	// CIDs 是「这个人名下的全部贡献」。同一个短名在两台机器上各有一条，
	// 主人问「这个能力跑了什么」时两条都要算进来。
	CIDs  []string
	Kind  string
	Model string
	// State 按终态筛（completed / failed…）。空表示不筛。
	State string
	// ExcludeStates 反向筛：这几个状态一行都不要。计数和取行共用同一个 scope，
	// 排掉的行同时不进 total —— 否则页脚写「共 11 条」而翻页只翻出 7 行。
	ExcludeStates []string
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

// unitScope 是单元表的过滤条件。列表、计数、统计都从这里长出来 ——
// 三处各拼一遍 WHERE 的话，统计口径迟早和列表对不上，而那种错不会报错，
// 只会让「总计 316 次」和翻页翻出来的行数对不上。
func (r *GalaxyRepository) unitScope(ctx context.Context, q UnitQuery) *gorm.DB {
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
	if len(q.CIDs) > 0 {
		tx = tx.Where("cid IN ?", q.CIDs)
	}
	if q.Kind != "" {
		tx = tx.Where("kind = ?", q.Kind)
	}
	if q.Model != "" {
		tx = tx.Where("model = ?", q.Model)
	}
	if q.State != "" {
		tx = tx.Where("state = ?", q.State)
	}
	if len(q.ExcludeStates) > 0 {
		tx = tx.Where("state NOT IN ?", q.ExcludeStates)
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
	return tx
}

func (r *GalaxyRepository) ListUnits(ctx context.Context, q UnitQuery) ([]*GalaxyUnit, int64, error) {
	tx := r.unitScope(ctx, q)
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

// ListLiveUnitsByContribution 这条贡献上还没走到终态的单元。强制关闭要挨个取消它们。
//
// 不走 unitScope 的 State：那里是单值，而「还在跑」是三个状态（派下去了、在跑、在推流）。
// 取消要一个不落 —— 漏掉的那条会一直挂在消费者那头，直到它自己超时。
// queued 不在其中：它还没落到任何一条贡献上，关这台机器不该动它，它会被派到别处去。
func (r *GalaxyRepository) ListLiveUnitsByContribution(ctx context.Context, bizLine, cid string, limit int) ([]*GalaxyUnit, error) {
	tx := r.Db.WithContext(ctx).Model(&GalaxyUnit{}).
		Where("biz_line = ?", bizLine).Where("cid = ?", cid).
		Where("state IN ?", []string{"placed", "running", "streaming"})
	if limit > 0 {
		tx = tx.Limit(limit)
	}
	var rows []*GalaxyUnit
	err := tx.Order("created_time desc, id desc").Find(&rows).Error
	return rows, err
}

// UnitSummary 一组单元的整体统计。它统计的是**整个筛选条件**，不是当前这一页。
type UnitSummary struct {
	Calls  int64
	Failed int64
	// AvgDurationMs 只算跑到终态的那些。没有终态时间的单元参与不了平均，
	// 把它们当 0 会让平均值随「正在跑的有几个」上下跳。
	AvgDurationMs int64
	Usage         map[string]int64
}

// SummariseUnits 次数、失败数、平均耗时与各计量单位的合计。
//
// 用量不从单元行的 actual_json 里加 —— 那是个 JSON 字符串，SQL 加不动，
// 捞回内存里加就变成「统计要先把几万行拉过来」。计量流水本来就是为求和存在的。
func (r *GalaxyRepository) SummariseUnits(ctx context.Context, q UnitQuery) (UnitSummary, error) {
	summary := UnitSummary{Usage: map[string]int64{}}

	var counted struct {
		Calls    int64
		Failed   int64
		AvgMicro *float64
	}
	err := r.unitScope(ctx, q).Select(
		"COUNT(*) AS calls, " +
			"SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed, " +
			"AVG(CASE WHEN started_at IS NOT NULL AND finished_at IS NOT NULL " +
			"THEN TIMESTAMPDIFF(MICROSECOND, started_at, finished_at) END) AS avg_micro",
	).Scan(&counted).Error
	if err != nil {
		return summary, err
	}
	summary.Calls = counted.Calls
	summary.Failed = counted.Failed
	if counted.AvgMicro != nil {
		summary.AvgDurationMs = int64(*counted.AvgMicro / 1000)
	}

	var rows []struct {
		Unit   string
		Amount int64
	}
	usage := r.Db.WithContext(ctx).
		Table((&GalaxyMeterRecord{}).TableName()+" AS m").
		Joins("JOIN "+(&GalaxyUnit{}).TableName()+" AS u ON u.biz_line = m.biz_line AND u.unit_id = m.unit_id").
		Select("m.unit AS unit, SUM(m.amount) AS amount").
		Where("m.biz_line = ?", q.BizLine)
	if q.CID != "" {
		usage = usage.Where("u.cid = ?", q.CID)
	}
	if len(q.CIDs) > 0 {
		usage = usage.Where("u.cid IN ?", q.CIDs)
	}
	if q.ConsumerKey != "" {
		usage = usage.Where("u.consumer_key = ?", q.ConsumerKey)
	}
	if len(q.ConsumerKeys) > 0 {
		usage = usage.Where("u.consumer_key IN ?", q.ConsumerKeys)
	}
	if q.Kind != "" {
		usage = usage.Where("u.kind = ?", q.Kind)
	}
	if q.Model != "" {
		usage = usage.Where("u.model = ?", q.Model)
	}
	if q.State != "" {
		usage = usage.Where("u.state = ?", q.State)
	}
	if !q.From.IsZero() {
		usage = usage.Where("u.created_time >= ?", q.From)
	}
	if !q.To.IsZero() {
		usage = usage.Where("u.created_time < ?", q.To)
	}
	if err := usage.Group("m.unit").Scan(&rows).Error; err != nil {
		return summary, err
	}
	for _, row := range rows {
		summary.Usage[row.Unit] = row.Amount
	}
	return summary, nil
}

// DistinctUnitModels 这些贡献上出现过的模型，供筛选下拉用。
func (r *GalaxyRepository) DistinctUnitModels(ctx context.Context, bizLine string, cids []string) ([]string, error) {
	if len(cids) == 0 {
		return []string{}, nil
	}
	var models []string
	err := r.Db.WithContext(ctx).Model(&GalaxyUnit{}).
		Where("biz_line = ?", bizLine).Where("cid IN ?", cids).Where("model <> ''").
		Distinct().Order("model").Pluck("model", &models).Error
	if models == nil {
		models = []string{}
	}
	return models, err
}

// SumConsumerCostByUnit 每次请求扣了多少钱（微分）。
//
// 账本行是按 (unit_id, unit) 一行行记的，一次请求通常有 input / output 两行；
// 逐笔视图要的是这一次的合计，所以在 SQL 里就按 unit_id 加好。
func (r *GalaxyRepository) SumConsumerCostByUnit(ctx context.Context, bizLine string, unitIDs []string) (map[string]int64, error) {
	costs := map[string]int64{}
	if len(unitIDs) == 0 {
		return costs, nil
	}
	var rows []struct {
		UnitID string
		Cost   int64
	}
	err := r.Db.WithContext(ctx).Model(&GalaxyConsumerLedger{}).
		Where("biz_line = ?", bizLine).Where("unit_id IN ?", unitIDs).Where("type = ?", "settle").
		Select("unit_id, SUM(amount * price DIV 1000000) AS cost").
		Group("unit_id").Scan(&rows).Error
	if err != nil {
		return costs, err
	}
	for _, row := range rows {
		costs[row.UnitID] = row.Cost
	}
	return costs, nil
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
	// Model 这笔用量调的是哪个模型。和 Provider 一样只记在单元表上，
	// 单元行被清掉时是空串 —— 那时取价只能回落到 kind 的兜底价。
	Model string `gorm:"column:model"`
	// GroupID 这笔用量落在哪个模型分组上。和 Model 同源同命：只记在单元表上，
	// 单元行被清掉时是空串，那时取价回落到模型通价 —— 和当初结算时单元行
	// 已经没了的情形一致。
	GroupID string `gorm:"column:group_id"`
	// Effort 这笔用量上游实际跑的那一档。不进取价（价钱按分组收），
	// 留着是因为逐笔记录页要答「那一次到底按多深跑的」。
	Effort string `gorm:"column:effort"`
	Unit   string `gorm:"column:unit"`
	Amount int64  `gorm:"column:amount"`
	Calls  int64  `gorm:"column:calls"`
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
		Select("m.kind AS kind, COALESCE(u.provider, '') AS provider, COALESCE(u.model, '') AS model, "+
			"COALESCE(u.group_id, '') AS group_id, COALESCE(u.effort, '') AS effort, m.unit AS unit, "+
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
	// 模型与分组都进分组条件：计价已经按这两维走了，汇总还合着算的话，账单上那个
	// Cost 会拿模型通价去乘一笔其实按分组价收过的量 —— 而且是静默算错。
	// 强度跟着一起分，是为了逐笔记录页能显示它；它不参与取价。
	err := tx.Group("m.kind, u.provider, u.model, u.group_id, u.effort, m.unit").
		Order("m.kind, u.provider, u.model, u.group_id, u.effort, m.unit").Find(&rows).Error
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

// SaveConsumerLedgerRow / SaveProviderLedgerRow 一次写一行，并告诉调用方**到底插进去没有**。
//
// 批量版拿不到这个答案（多行时 RowsAffected 是合计），而账本和余额必须绑在一起写：
// 账本按 (biz_line, txn_id) 幂等，余额却是加减 —— 批量写完再按总额加一次的话，
// 一次重放（节点重发 complete）就是白发一笔钱、白扣一次额度。
func (r *GalaxyRepository) SaveConsumerLedgerRow(ctx context.Context, row *GalaxyConsumerLedger) (bool, error) {
	return insertLedgerRow(ctx, r, row)
}

func (r *GalaxyRepository) SaveProviderLedgerRow(ctx context.Context, row *GalaxyProviderLedger) (bool, error) {
	return insertLedgerRow(ctx, r, row)
}

func insertLedgerRow[T any](ctx context.Context, r *GalaxyRepository, row *T) (bool, error) {
	result := r.Db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "biz_line"}, {Name: "txn_id"}},
		DoNothing: true,
	}).Create(row)
	if result.Error != nil {
		return false, result.Error
	}
	return result.RowsAffected > 0, nil
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

// ListEffectivePrices 此刻已经生效的价目行。kind 为空表示不限（门户、运营台、
// 共享端模型页都要跨 kind 看），计费与争议那两条路径一定要带上它。
//
// **两处都是为了让这条查询走在唯一键上，而不是全表扫一遍再排一遍。**
//
//	uk_gx_price = (biz_line, kind, model_id, group_id, unit, effective_from)
//
//	· 带 kind：biz_line 恒等于 'galaxy'，不带 kind 等于没有过滤条件；
//	  带上它索引才收窄到这一个 kind 的那几十行。计费是每笔请求都走的路径，
//	  而这张表只会越长越大 —— 调价是插新行，旧行留作历史，永远不删。
//	· 升序：ORDER BY 必须和索引同向。末尾写 desc 的话前四列顺着、第五列反着，
//	  MySQL 用不了索引的顺序，只能捞回来 filesort。
//
// 升序的代价是「同一组里最后一条才是最新生效的」—— 取价的那几处按这个来
// （resolvePrices、portalPrices）。注意别把这个顺序套到 ListAllPrices 上：
// 那一份含未来价，「最新且已到点」不是简单的取头取尾。
func (r *GalaxyRepository) ListEffectivePrices(ctx context.Context, bizLine, kind string, at time.Time) ([]*GalaxyPrice, error) {
	tx := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine)
	if kind != "" {
		tx = tx.Where("kind = ?", kind)
	}
	var rows []*GalaxyPrice
	err := tx.Where("effective_from <= ?", at).
		Order("kind, model_id, group_id, unit, effective_from").Find(&rows).Error
	return rows, err
}

// ListAllPrices 价目表的全部行，含还没到生效时间的。运营要在生效前就把下一档价
// 排进去并看得见它，ListEffectivePrices 按 effective_from <= now 过滤，排进去的那行
// 在界面上会凭空消失 —— 运营只能反复保存同一行，直到某天发现价格被改过两遍。
func (r *GalaxyRepository) ListAllPrices(ctx context.Context, bizLine string) ([]*GalaxyPrice, error) {
	var rows []*GalaxyPrice
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).
		// 兜底价（model_id = ''）排在这个 kind 的最前面：界面上先看到「这个 kind 收多少」，
		// 再看到各个模型的特例。model_id 升序天然就是这个顺序，空串最小。
		Order("kind, model_id, group_id, unit, effective_from desc").Find(&rows).Error
	return rows, err
}

// DeletePrice 删掉一行价目。按唯一键定位，少一列就会连坐删掉隔壁分组的价。
func (r *GalaxyRepository) DeletePrice(ctx context.Context, bizLine, kind, modelID, groupID, unit string, effectiveFrom time.Time) error {
	return r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("kind = ?", kind).
		Where("model_id = ?", modelID).Where("group_id = ?", groupID).
		Where("unit = ?", unit).Where("effective_from = ?", effectiveFrom).
		Delete(&GalaxyPrice{}).Error
}

// DeletePricesOfGroup 删掉一个分组名下的全部价目行。分组被删时连带清理 ——
// 留着的话，下一个用同一个 group_id 建出来的分组会凭空继承一套价。
func (r *GalaxyRepository) DeletePricesOfGroup(ctx context.Context, bizLine, groupID string) error {
	if groupID == "" {
		return nil
	}
	return r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("group_id = ?", groupID).
		Delete(&GalaxyPrice{}).Error
}

func (r *GalaxyRepository) SavePrice(ctx context.Context, row *GalaxyPrice) error {
	return r.Db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{
			{Name: "biz_line"}, {Name: "kind"}, {Name: "model_id"}, {Name: "group_id"},
			{Name: "unit"}, {Name: "effective_from"},
		},
		DoUpdates: clause.AssignmentColumns([]string{"price", "currency", "provider_price", "provider_share"}),
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

// ---------- 用量偏差：运营侧 ----------

// MismatchQuery 用量偏差的过滤条件。
type MismatchQuery struct {
	BizLine string
	CID     string
	Unit    string
	// MinRatio 只看偏差不小于它的。0 表示不筛。
	MinRatio float64
	From     time.Time
	Offset   int
	Limit    int
}

func (r *GalaxyRepository) mismatchScope(query MismatchQuery) *gorm.DB {
	tx := r.Db.Model(&GalaxyUsageMismatch{}).Where("biz_line = ?", query.BizLine)
	if query.CID != "" {
		tx = tx.Where("cid = ?", query.CID)
	}
	if query.Unit != "" {
		tx = tx.Where("unit = ?", query.Unit)
	}
	if query.MinRatio > 0 {
		tx = tx.Where("ratio >= ?", query.MinRatio)
	}
	if !query.From.IsZero() {
		tx = tx.Where("created_at >= ?", query.From)
	}
	return tx
}

// ListUsageMismatches 节点自报与 Hub 解析对不上的那些记录。
//
// 这张表此前**只写不读**：超过阈值就落一行，然后没有任何地方看得见它。
// 于是「某台机器一直在虚报用量」这件事，在库里有据可查，在管理端查不出来。
func (r *GalaxyRepository) ListUsageMismatches(ctx context.Context, query MismatchQuery) ([]*GalaxyUsageMismatch, int64, error) {
	var total int64
	if err := r.mismatchScope(query).WithContext(ctx).Count(&total).Error; err != nil {
		return nil, 0, err
	}
	tx := r.mismatchScope(query).WithContext(ctx).Order("created_at desc, id desc")
	if query.Limit > 0 {
		tx = tx.Limit(query.Limit).Offset(query.Offset)
	}
	var rows []*GalaxyUsageMismatch
	err := tx.Find(&rows).Error
	return rows, total, err
}

// CountMismatchesByCID 每条贡献各有多少次偏差，按次数从多到少。
//
// 逐条记录说明不了问题 —— 偶发一次是解析抖动，同一条贡献反复上榜才是虚报。
// 排行在 SQL 里做：捞回内存里数，等于为了一个计数把几万行拉过来。
func (r *GalaxyRepository) CountMismatchesByCID(ctx context.Context, query MismatchQuery, limit int) ([]MismatchCount, error) {
	var rows []MismatchCount
	tx := r.mismatchScope(query).WithContext(ctx).
		Select("cid, COUNT(*) AS times, MAX(ratio) AS worst_ratio").
		Group("cid").Order("times desc")
	if limit > 0 {
		tx = tx.Limit(limit)
	}
	err := tx.Scan(&rows).Error
	return rows, err
}

// MismatchCount 一条贡献的偏差次数与最大偏差。
type MismatchCount struct {
	CID        string
	Times      int64
	WorstRatio float64
}

// CountUnitsByState 各状态各有多少单元。运营总览那一排数字用它。
func (r *GalaxyRepository) CountUnitsByState(ctx context.Context, bizLine string, since time.Time) (map[string]int64, error) {
	var rows []struct {
		State string
		Total int64
	}
	tx := r.Db.WithContext(ctx).Model(&GalaxyUnit{}).Where("biz_line = ?", bizLine)
	if !since.IsZero() {
		tx = tx.Where("created_time >= ?", since)
	}
	err := tx.Select("state, COUNT(*) AS total").Group("state").Scan(&rows).Error
	counts := map[string]int64{}
	for _, row := range rows {
		counts[row.State] = row.Total
	}
	return counts, err
}
