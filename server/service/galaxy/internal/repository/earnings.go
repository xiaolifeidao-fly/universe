package repository

import (
	"context"
	"time"

	"gorm.io/gorm"
)

// 收益侧的查询集中在这里：积分账本、按天趋势、提现申请。
//
// 账本行本身在 unit.go 的 SaveProviderLedger 那边写入（结算路径上的事），
// 这一份只读它 —— 控制台要的是「按人回查」，而结算写的是「按贡献落账」，
// 两者的过滤维度不一样，混在一个文件里迟早有人拿写路径的索引去跑读路径的查询。

// LedgerQuery 是积分账本的过滤条件。CIDs 由调用方按「这个人名下的贡献」解析后填入 ——
// 旧账本行可能没写 owner_user_id（结算路径后来才补的），只按 owner 查会漏掉它们。
type LedgerQuery struct {
	BizLine     string
	OwnerUserID string
	CIDs        []string
	Types       []string
	From        time.Time
	To          time.Time
	Offset      int
	Limit       int
}

func (r *GalaxyRepository) ledgerScope(ctx context.Context, q LedgerQuery) *gorm.DB {
	return scopeProviderLedger(r.Db.WithContext(ctx).Model(&GalaxyProviderLedger{}), q, "")
}

// scopeProviderLedger 账本的查询范围。范围条件只写这一份 —— 它决定一个人
// 看得到哪些钱，抄第二份就意味着有一天两份会不一样，而那种不一样叫越权。
//
// alias 是账本表的别名。**join 的时候必须给**：biz_line / cid 这些列在
// zt_galaxy_unit 上也有，不带前缀 MySQL 报 1052，而不是替你挑一个。
func scopeProviderLedger(tx *gorm.DB, q LedgerQuery, alias string) *gorm.DB {
	col := func(name string) string {
		if alias == "" {
			return name
		}
		return alias + "." + name
	}
	tx = tx.Where(col("biz_line")+" = ?", q.BizLine)
	// owner 与 cid 是「或」不是「且」：结算那条路径写的是 cid，
	// 提现与驳回写的是 owner（它们不属于任何一条贡献）。
	switch {
	case q.OwnerUserID != "" && len(q.CIDs) > 0:
		tx = tx.Where(col("owner_user_id")+" = ? OR "+col("cid")+" IN ?", q.OwnerUserID, q.CIDs)
	case q.OwnerUserID != "":
		tx = tx.Where(col("owner_user_id")+" = ?", q.OwnerUserID)
	case len(q.CIDs) > 0:
		tx = tx.Where(col("cid")+" IN ?", q.CIDs)
	default:
		// 两个维度都空表示「这个人什么都没有」。不加条件会把全平台的账本查出来，
		// 那是越权，不是空结果。
		tx = tx.Where("1 = 0")
	}
	if len(q.Types) > 0 {
		tx = tx.Where(col("type")+" IN ?", q.Types)
	}
	if !q.From.IsZero() {
		tx = tx.Where(col("created_at")+" >= ?", q.From)
	}
	if !q.To.IsZero() {
		tx = tx.Where(col("created_at")+" < ?", q.To)
	}
	return tx
}

// ListProviderLedger 积分账本分页。返回总数，供控制台画页码。
func (r *GalaxyRepository) ListProviderLedger(ctx context.Context, q LedgerQuery) ([]*GalaxyProviderLedger, int64, error) {
	tx := r.ledgerScope(ctx, q)
	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	if q.Limit > 0 {
		tx = tx.Offset(q.Offset).Limit(q.Limit)
	}
	var rows []*GalaxyProviderLedger
	err := tx.Order("created_at desc, id desc").Find(&rows).Error
	return rows, total, err
}

// SumProviderLedger 一个时间窗内的积分合计。提现是负数，所以求和就是净额。
func (r *GalaxyRepository) SumProviderLedger(ctx context.Context, q LedgerQuery) (int64, error) {
	var total *int64
	err := r.ledgerScope(ctx, q).Select("SUM(amount)").Scan(&total).Error
	if err != nil || total == nil {
		return 0, err
	}
	return *total, nil
}

// DailyAmount 是趋势图的一天。Date 是数据库时区下的 YYYY-MM-DD。
type DailyAmount struct {
	Date   string `gorm:"column:day"`
	Amount int64  `gorm:"column:amount"`
}

// SumProviderLedgerByDay 按天分组求和，画趋势用。
//
// 分组放在 SQL 里而不是把明细捞回来在内存里归并：一周的账本行数和调用次数同阶，
// 活跃提供者一天就上千行，全捞回来只为了加个和不值当。
func (r *GalaxyRepository) SumProviderLedgerByDay(ctx context.Context, q LedgerQuery) ([]DailyAmount, error) {
	var rows []DailyAmount
	err := r.ledgerScope(ctx, q).
		Select("DATE(created_at) AS day, SUM(amount) AS amount").
		Group("DATE(created_at)").Order("day").Scan(&rows).Error
	return rows, err
}

// ModelAmount 一个模型在一个时间窗里挣了多少微积分。
type ModelAmount struct {
	Model  string `gorm:"column:model"`
	Amount int64  `gorm:"column:amount"`
}

// SumProviderLedgerByModel 按模型分组求和，共享端的模型页用它回答「这个模型给我赚了多少」。
//
// 模型只记在单元行上、账本里没有，所以要 join 回去 —— 和 SumUsage 是同一个原因。
// 单元行已经被清掉的那些归进空串那一组：钱是真赚过的，只是说不出是哪个模型赚的。
// 丢掉它们会让这一页的合计比收益页少一截，而两页对不上比少一行信息更难查。
func (r *GalaxyRepository) SumProviderLedgerByModel(ctx context.Context, q LedgerQuery) ([]ModelAmount, error) {
	tx := r.Db.WithContext(ctx).
		Table((&GalaxyProviderLedger{}).TableName() + " AS l").
		Joins("LEFT JOIN " + (&GalaxyUnit{}).TableName() + " AS u ON u.biz_line = l.biz_line AND u.unit_id = l.unit_id")
	var rows []ModelAmount
	err := scopeProviderLedger(tx, q, "l").
		Select("COALESCE(u.model, '') AS model, SUM(l.amount) AS amount").
		Group("u.model").Scan(&rows).Error
	return rows, err
}

// ---------- 提现 ----------

func (r *GalaxyRepository) CreatePayout(ctx context.Context, row *GalaxyPayout) error {
	return r.Db.WithContext(ctx).Create(row).Error
}

func (r *GalaxyRepository) ListPayouts(ctx context.Context, bizLine, ownerUserID string, limit int) ([]*GalaxyPayout, error) {
	tx := r.Db.WithContext(ctx).Model(&GalaxyPayout{}).
		Where("biz_line = ?", bizLine).Where("owner_user_id = ?", ownerUserID)
	if limit > 0 {
		tx = tx.Limit(limit)
	}
	var rows []*GalaxyPayout
	err := tx.Order("created_time desc, id desc").Find(&rows).Error
	return rows, err
}

// SumPayouts 已受理的提现积分合计。驳回的不算 —— 那笔积分已经退回账户了。
func (r *GalaxyRepository) SumPayouts(ctx context.Context, bizLine, ownerUserID string) (int64, error) {
	var total *int64
	err := r.Db.WithContext(ctx).Model(&GalaxyPayout{}).
		Where("biz_line = ?", bizLine).Where("owner_user_id = ?", ownerUserID).
		Where("status IN ?", []string{"pending", "paid"}).
		Select("SUM(credits)").Scan(&total).Error
	if err != nil || total == nil {
		return 0, err
	}
	return *total, nil
}

// DeductCredit 扣积分。带 balance >= amount 的条件 —— 并发两次提现时，
// 后一次会更新到 0 行，调用方据此拒绝，而不是把余额扣成负数。
func (r *GalaxyRepository) DeductCredit(ctx context.Context, bizLine, ownerUserID string, amount int64) (bool, error) {
	result := r.Db.WithContext(ctx).Model(&GalaxyCreditAccount{}).
		Where("biz_line = ?", bizLine).Where("owner_user_id = ?", ownerUserID).
		Where("balance >= ?", amount).
		UpdateColumn("balance", gorm.Expr("balance - ?", amount))
	if result.Error != nil {
		return false, result.Error
	}
	return result.RowsAffected > 0, nil
}

// AvgFirstByteMs 首字延迟：从单元创建到首字节。
//
// 起点用 created_time 而不是 started_at —— 消费者感受到的等待里包含排队，
// 而 started_at 是派到节点之后才有的。用后者会把「池子里没人接单」这段掩盖掉。
func (r *GalaxyRepository) AvgFirstByteMs(ctx context.Context, q UnitQuery) (int64, error) {
	var avg *float64
	err := r.unitScope(ctx, q).
		Where("first_byte_at IS NOT NULL").
		Select("AVG(TIMESTAMPDIFF(MICROSECOND, created_time, first_byte_at))").
		Scan(&avg).Error
	if err != nil || avg == nil {
		return 0, err
	}
	return int64(*avg / 1000), nil
}

// SumProviderCreditByUnit 每次执行给这条贡献记了多少积分。
//
// 账本按 (unit_id, unit) 一行行记，一次请求通常有 input / output 两行；
// 执行记录上要显示的是这一次的合计，所以在 SQL 里就按 unit_id 加好。
func (r *GalaxyRepository) SumProviderCreditByUnit(ctx context.Context, bizLine string, unitIDs []string) (map[string]int64, error) {
	credits := map[string]int64{}
	if len(unitIDs) == 0 {
		return credits, nil
	}
	var rows []struct {
		UnitID string
		Amount int64
	}
	err := r.Db.WithContext(ctx).Model(&GalaxyProviderLedger{}).
		Where("biz_line = ?", bizLine).Where("unit_id IN ?", unitIDs).Where("type = ?", "settle").
		Select("unit_id, SUM(amount) AS amount").
		Group("unit_id").Scan(&rows).Error
	if err != nil {
		return credits, err
	}
	for _, row := range rows {
		credits[row.UnitID] = row.Amount
	}
	return credits, nil
}

// ---------- 提现：运营侧 ----------

// AdminPayoutQuery 运营翻全站提现单的过滤条件。OwnerUserID 为空表示不限人 ——
// 和 ListPayouts 的「只看某个人」正好相反，所以另起一个查询而不是给它加参数：
// 一个必填的过滤维度变成可选，调用方漏填就会静默地把全站的钱都列出来。
type AdminPayoutQuery struct {
	BizLine     string
	Status      string
	OwnerUserID string
	Keyword     string
	Offset      int
	Limit       int
}

func (r *GalaxyRepository) adminPayoutScope(query AdminPayoutQuery) *gorm.DB {
	tx := r.Db.Model(&GalaxyPayout{}).Where("biz_line = ?", query.BizLine)
	if query.Status != "" {
		tx = tx.Where("status = ?", query.Status)
	}
	if query.OwnerUserID != "" {
		tx = tx.Where("owner_user_id = ?", query.OwnerUserID)
	}
	if query.Keyword != "" {
		like := "%" + query.Keyword + "%"
		tx = tx.Where("payout_id LIKE ? OR owner_user_id LIKE ?", like, like)
	}
	return tx
}

// ListAdminPayouts 分页列全站提现单，同时回总数 —— 待办队列要显示「还剩多少笔」，
// 分两次调用去数会在两次之间漏掉刚进来的那一笔。
func (r *GalaxyRepository) ListAdminPayouts(ctx context.Context, query AdminPayoutQuery) ([]*GalaxyPayout, int64, error) {
	var total int64
	if err := r.adminPayoutScope(query).WithContext(ctx).Count(&total).Error; err != nil {
		return nil, 0, err
	}
	tx := r.adminPayoutScope(query).WithContext(ctx).Order("created_time desc, id desc")
	if query.Limit > 0 {
		tx = tx.Limit(query.Limit).Offset(query.Offset)
	}
	var rows []*GalaxyPayout
	err := tx.Find(&rows).Error
	return rows, total, err
}

// CountPayoutsByStatus 各状态各有多少笔。队列页顶上那排数字用它，一次查完。
func (r *GalaxyRepository) CountPayoutsByStatus(ctx context.Context, bizLine string) (map[string]int64, error) {
	var rows []struct {
		Status string
		Total  int64
	}
	err := r.Db.WithContext(ctx).Model(&GalaxyPayout{}).
		Where("biz_line = ?", bizLine).
		Select("status, COUNT(*) AS total").Group("status").Scan(&rows).Error
	counts := map[string]int64{}
	for _, row := range rows {
		counts[row.Status] = row.Total
	}
	return counts, err
}

func (r *GalaxyRepository) FindPayout(ctx context.Context, bizLine, payoutID string) (*GalaxyPayout, error) {
	var row GalaxyPayout
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("payout_id = ?", payoutID).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// HandlePayout 把一张 pending 的单子改成 paid / rejected。
//
// **条件写在 WHERE 里，不先查后改**：驳回要连带把积分退回账户，两个运营同时点驳回，
// 先查后改会各自读到 pending、各自退一次钱。这里返回 false 表示这一次没改动任何行 ——
// 单子已经被别人处置过了，调用方据此不退款。
func (r *GalaxyRepository) HandlePayout(ctx context.Context, bizLine, payoutID, status, note, handledBy string, at time.Time) (bool, error) {
	result := r.Db.WithContext(ctx).Model(&GalaxyPayout{}).
		Where("biz_line = ?", bizLine).Where("payout_id = ?", payoutID).Where("status = ?", "pending").
		Updates(map[string]any{
			"status": status, "note": note, "handled_by": handledBy,
			"handled_at": at, "updated_time": at,
		})
	return result.RowsAffected > 0, result.Error
}
