package repository

import (
	"context"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// 管理端仪表盘要的那几组数。
//
// 这一组查询和别处最大的不同是**没有主体**：它问的是「今天全站」「此刻全池」，
// 不是「这个人的」。所以每一条都要自己交代清楚扫的是什么范围 ——
// 少一个时间边界，这里就是一次全表扫描。
//
// 用量那三条（计量流水 + 两本账）不直接给接口用：它们是按小时汇总的**原料**，
// 由 admindashboard.go 切成小时桶算一次、写进 zt_galaxy_usage_rollup，
// 之后仪表盘读的是汇总表。见那张表的注释。

// ---------- 账号：今日登录 ----------

// AccountStat 一端账号的三个数。
type AccountStat struct {
	// Total 这一端的账号总数（含停用的）。
	Total int64 `gorm:"column:total"`
	// LoggedIn 今天登录过的人数。last_login_at 只前进不后退，
	// 所以「最近一次登录落在今天」和「今天登录过」是同一批人。
	//
	// 它回答不了「登录了几次」—— 那要另立一张登录流水表。
	// 日活这个口径下，人数才是要的那个数。
	LoggedIn int64 `gorm:"column:logged_in"`
	// Registered 今天新注册的人数。
	Registered int64 `gorm:"column:registered"`
}

// AccountStatSince 某一端账号的总数、今日登录数与今日注册数，一次查完。
//
// 三个数分三条 COUNT 的话是把同一张表扫三遍 —— 而这三个条件都落在同一批行上。
func (r *GalaxyRepository) AccountStatSince(ctx context.Context, bizLine, side string, dayStart time.Time) (AccountStat, error) {
	var stat AccountStat
	tx, err := r.users(ctx, bizLine, side)
	if err != nil {
		return stat, err
	}
	err = tx.Select(
		"COUNT(*) AS total, "+
			"CAST(SUM(CASE WHEN last_login_at >= ? THEN 1 ELSE 0 END) AS SIGNED) AS logged_in, "+
			"CAST(SUM(CASE WHEN created_time >= ? THEN 1 ELSE 0 END) AS SIGNED) AS registered",
		dayStart, dayStart).Scan(&stat).Error
	return stat, err
}

// ---------- 机器：在线与身份 ----------

// NodePresence 一台机器此刻的在场情况。
type NodePresence struct {
	NodeID string `gorm:"column:node_id"`
	// ProviderType individual=散户 / studio=工作室。
	// **没有 provider 行就是散户**（注册默认散户，只有管理端能设成工作室），
	// 所以这里把空值折成 individual，而不是留一个第三类出来。
	ProviderType string `gorm:"column:provider_kind"`
	// Online 心跳还在。status 由巡检每分钟刷新，但心跳时刻才是事实：
	// 巡检停了（或者刚好卡在两轮之间），status 会停在 active 而机器早就走了。
	Online bool `gorm:"column:online"`
	Banned bool `gorm:"column:banned"`
}

// ListNodePresence 列出没被解绑的机器，带上主人的身份与此刻是否在线。
//
// 不在 SQL 里分组计数，是因为同一批行还要拿去和贡献表对齐（「有额度的机器数」
// 要知道是哪几台，不只是几台）。机器数和用户数同阶，不和请求数同阶 —— 拉回来数得动。
func (r *GalaxyRepository) ListNodePresence(ctx context.Context, bizLine string, aliveAfter time.Time) ([]NodePresence, error) {
	var rows []NodePresence
	err := r.Db.WithContext(ctx).
		Table((&GalaxyNode{}).TableName()+" AS n").
		Joins("LEFT JOIN "+(&GalaxyProvider{}).TableName()+" AS p ON p.biz_line = n.biz_line AND p.owner_user_id = n.owner_user_id").
		// 别名叫 provider_kind 不叫 provider_type：和 p.provider_type 同名的话，
		// 分组时 MySQL 分不清指的是哪一个，直接报歧义列。
		Select("n.node_id AS node_id, n.banned AS banned, "+
			"CASE WHEN p.provider_type IS NULL OR p.provider_type = '' THEN 'individual' ELSE p.provider_type END AS provider_kind, "+
			"CASE WHEN n.status = 'active' AND n.last_beat_at >= ? THEN 1 ELSE 0 END AS online", aliveAfter).
		Where("n.biz_line = ?", bizLine).
		Where("n.status <> ?", "revoked").
		Scan(&rows).Error
	return rows, err
}

// ---------- 算力剩余：授权与窗口计数 ----------

// ListQuotaWindowsByKeys 取这些窗口键下的全部计数快照。
//
// 按窗口键查而不是按 cid 查：当下生效的窗口键只有几个（每种窗口一个），
// 而 cid 有几千个 —— IN 一个几千项的列表，语句本身就先长到几十 KB。
// 走 idx_gx_quota_window_key。
func (r *GalaxyRepository) ListQuotaWindowsByKeys(ctx context.Context, bizLine string, keys []string) ([]*GalaxyQuotaWindow, error) {
	if len(keys) == 0 {
		return nil, nil
	}
	var rows []*GalaxyQuotaWindow
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("window_key IN ?", keys).
		Find(&rows).Error
	return rows, err
}

// ---------- 充值 ----------

// RechargeStat 今日进账。两条路各记各的，**不能相加**：
// 积分充值是运营线下收钱之后充进来的，渠道支付是使用者自己付的。
type RechargeStat struct {
	Count  int64 `gorm:"column:cnt"`
	Amount int64 `gorm:"column:amount"`
}

// SumPointsRecharge 某段时间内运营充进去的积分与对应实付金额。
// 走 idx_gx_points_ledger_type (biz_line, type, created_at)。
func (r *GalaxyRepository) SumPointsRecharge(ctx context.Context, bizLine string, from, to time.Time) (RechargeStat, int64, error) {
	var row struct {
		Count  int64 `gorm:"column:cnt"`
		Paid   int64 `gorm:"column:paid"`
		Points int64 `gorm:"column:points"`
	}
	err := r.Db.WithContext(ctx).Model(&GalaxyPointsLedger{}).
		Select("COUNT(*) AS cnt, CAST(COALESCE(SUM(base_amount), 0) AS SIGNED) AS paid, CAST(COALESCE(SUM(amount), 0) AS SIGNED) AS points").
		Where("biz_line = ?", bizLine).Where("type = ?", "recharge").
		Where("created_at >= ?", from).Where("created_at < ?", to).
		Scan(&row).Error
	return RechargeStat{Count: row.Count, Amount: row.Paid}, row.Points, err
}

// OrderPayStat 某种支付方式下的成交。
type OrderPayStat struct {
	// Method points=花积分买的（钱在充值那一刻就进来了，别重复计）；channel=渠道直接付的。
	Method string `gorm:"column:method"`
	Count  int64  `gorm:"column:cnt"`
	Amount int64  `gorm:"column:amount"`
}

// SumOrdersPaid 某段时间内付掉的订单，按支付方式分开。
//
// 按 paid_at 筛而不是 created_time：今天付掉的昨天那张单，钱是今天进来的。
// 订单表上没有 paid_at 的索引 —— 这张表一行一笔订单，量级和用户数同阶，
// 扫一遍是几毫秒的事（同 20260916_galaxy_admin_indexes.sql 里的那段说明）。
func (r *GalaxyRepository) SumOrdersPaid(ctx context.Context, bizLine string, from, to time.Time) ([]OrderPayStat, error) {
	var rows []OrderPayStat
	err := r.Db.WithContext(ctx).Model(&GalaxyOrder{}).
		Select("CASE WHEN pay_method = 'points' THEN 'points' ELSE 'channel' END AS method, "+
			"COUNT(*) AS cnt, CAST(COALESCE(SUM(amount), 0) AS SIGNED) AS amount").
		Where("biz_line = ?", bizLine).
		Where("status IN ?", []string{"paid", "fulfilled"}).
		Where("paid_at >= ?", from).Where("paid_at < ?", to).
		Group("method").Scan(&rows).Error
	return rows, err
}

// ---------- 用量汇总的原料 ----------

// UsageSlice 一段时间里、某个（模型 × 路由键 × 能力 × 计量单位）上的合计。
//
// 模型 / 路由键 / 能力三样都取回来，是因为类别（claude / codex）要靠它们推：
// 模型名最准，但单元行不一定记得下模型（非 LLM 的 kind、老数据），
// 那时路由键（claude_oauth / codex_chatgpt）还认得出来。
type UsageSlice struct {
	Model    string `gorm:"column:model"`
	Provider string `gorm:"column:provider"`
	Kind     string `gorm:"column:kind"`
	Unit     string `gorm:"column:unit"`
	// Amount 计量合计。量纲随 Unit 而定。
	Amount int64 `gorm:"column:amount"`
	// Cost 金额合计（微元）。只有两本账那两条查询填它，计量流水那条恒为 0。
	Cost int64 `gorm:"column:cost"`
}

// usageJoin 三条查询共用的形状：按时间切一刀，回 unit 表补上模型与路由键。
//
// 每一条都必须带 from/to —— 这三张是池子里最大的表，没有时间边界就是全表扫描。
//
// 调用方的 GROUP BY 一律写 u.model / u.provider 这样的**原列**，不写 SELECT 里的别名：
// 别名和列同名时 MySQL 在分组里分不清指的是哪一个，直接报歧义列。
// NULL 和空串在分组上本来就是同一组，折叠成空串放在 Go 那边做。
func (r *GalaxyRepository) usageJoin(ctx context.Context, table, alias, bizLine string, from, to time.Time, timeColumn string) *gorm.DB {
	return r.Db.WithContext(ctx).
		Table(table+" AS "+alias).
		Joins("LEFT JOIN "+(&GalaxyUnit{}).TableName()+" AS u ON u.biz_line = "+alias+".biz_line AND u.unit_id = "+alias+".unit_id").
		Where(alias+".biz_line = ?", bizLine).
		Where(alias+"."+timeColumn+" >= ?", from).
		Where(alias+"."+timeColumn+" < ?", to)
}

// SumMeterSlice 计量流水的合计。这是**用量**的唯一出处 —— 账本只记钱。
func (r *GalaxyRepository) SumMeterSlice(ctx context.Context, bizLine string, from, to time.Time) ([]UsageSlice, error) {
	var rows []UsageSlice
	err := r.usageJoin(ctx, (&GalaxyMeterRecord{}).TableName(), "m", bizLine, from, to, "created_at").
		Select("COALESCE(u.model, '') AS model, COALESCE(u.provider, '') AS provider, m.kind AS kind, m.unit AS unit, " +
			"CAST(SUM(m.amount) AS SIGNED) AS amount, 0 AS cost").
		Group("u.model, u.provider, m.kind, m.unit").Scan(&rows).Error
	return rows, err
}

// SumConsumerSettleSlice 使用端这一段结算掉的用量与金额。
//
// 金额是**逐笔**算的：consumer_ledger 存的是「这一笔多少量 × 当时的单价」，
// 而计费本身就是每一笔向下取整的。先加总再乘单价的话，算出来的数比真收的多一点点，
// 而且随笔数增长 —— 对账时那个差额没人解释得清。
func (r *GalaxyRepository) SumConsumerSettleSlice(ctx context.Context, bizLine string, from, to time.Time) ([]UsageSlice, error) {
	var rows []UsageSlice
	err := r.usageJoin(ctx, (&GalaxyConsumerLedger{}).TableName(), "l", bizLine, from, to, "created_at").
		Where("l.type = ?", "settle").
		Select("COALESCE(u.model, '') AS model, COALESCE(u.provider, '') AS provider, COALESCE(u.kind, '') AS kind, l.unit AS unit, " +
			"CAST(SUM(l.amount) AS SIGNED) AS amount, " +
			"CAST(SUM((l.amount * l.price) DIV 1000000) AS SIGNED) AS cost").
		Group("u.model, u.provider, u.kind, l.unit").Scan(&rows).Error
	return rows, err
}

// SumProviderSettleSlice 共享端这一段挣到的钱。
//
// 这一侧的 amount 列记的**已经是钱**（微积分，与微元同量纲），不是 token 数 ——
// 所以它填的是 Cost，Amount 留空。两侧的 amount 是两个量纲，这是这套账最容易记反的地方。
func (r *GalaxyRepository) SumProviderSettleSlice(ctx context.Context, bizLine string, from, to time.Time) ([]UsageSlice, error) {
	var rows []UsageSlice
	err := r.usageJoin(ctx, (&GalaxyProviderLedger{}).TableName(), "l", bizLine, from, to, "created_at").
		Where("l.type = ?", "settle").
		Select("COALESCE(u.model, '') AS model, COALESCE(u.provider, '') AS provider, COALESCE(u.kind, '') AS kind, l.unit AS unit, " +
			"0 AS amount, CAST(SUM(l.amount) AS SIGNED) AS cost").
		Group("u.model, u.provider, u.kind, l.unit").Scan(&rows).Error
	return rows, err
}

// ---------- 用量汇总表 ----------

type DashboardRequestState struct {
	State string
	Count int64
}

// DashboardRequestStates counts requests created in the reporting interval.
func (r *GalaxyRepository) DashboardRequestStates(ctx context.Context, bizLine string, from, to time.Time) ([]DashboardRequestState, error) {
	var rows []DashboardRequestState
	err := r.Db.WithContext(ctx).Model(&GalaxyUnit{}).
		Where("biz_line = ? AND created_time >= ? AND created_time < ?", bizLine, from, to).
		Select("state, COUNT(*) AS count").Group("state").Scan(&rows).Error
	return rows, err
}

// ListUsageRollup 取 [from, to) 里已经算好的小时桶，含标记行。
func (r *GalaxyRepository) ListUsageRollup(ctx context.Context, bizLine string, from, to time.Time) ([]*GalaxyUsageRollup, error) {
	var rows []*GalaxyUsageRollup
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).
		Where("stat_hour >= ?", from).Where("stat_hour < ?", to).
		Order("stat_hour").Find(&rows).Error
	return rows, err
}

// ListRolledHours 这段里哪些小时桶已经算过了，只取标记行。
//
// 和 ListUsageRollup 分开：巡检每分钟要问一次「有没有漏的小时」，
// 而它只需要小时列表 —— 把两天的明细行一起拉回来，是每分钟一次的无谓搬运。
func (r *GalaxyRepository) ListRolledHours(ctx context.Context, bizLine string, from, to time.Time) ([]time.Time, error) {
	var hours []time.Time
	err := r.Db.WithContext(ctx).Model(&GalaxyUsageRollup{}).
		Where("biz_line = ?", bizLine).
		Where("category = ?", "").Where("unit = ?", "").
		Where("stat_hour >= ?", from).Where("stat_hour < ?", to).
		Order("stat_hour").Pluck("stat_hour", &hours).Error
	return hours, err
}

// SaveUsageRollup 整行覆盖地写回一批汇总。
//
// 覆盖而不是累加：写进去的是「这一桶重算出来的绝对值」，所以同一个小时算几遍、
// 几个进程同时算，结果都一样。累加的话，补算一次就把那个小时翻了倍。
func (r *GalaxyRepository) SaveUsageRollup(ctx context.Context, rows []*GalaxyUsageRollup) error {
	if len(rows) == 0 {
		return nil
	}
	// 一条 INSERT 发完，不分批：一个小时桶的行数是「类别 × 计量单位」，
	// 几十行的量级。分批要多一次事务往返，换不来什么。
	return r.Db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "biz_line"}, {Name: "stat_hour"}, {Name: "category"}, {Name: "unit"}},
		DoUpdates: clause.AssignmentColumns([]string{"amount", "consumer_amount", "provider_amount", "rolled_at"}),
	}).Create(rows).Error
}

// DeleteUsageRollupHour 清掉一个小时桶已有的行。
//
// 重算之前先删：上一次算出来有量、这一次没有的那些格子（比如争议追回之后某个模型
// 当小时归零）不会自己消失，只靠覆盖写的话它们会留在表上，成为一份永远不再更新的旧账。
func (r *GalaxyRepository) DeleteUsageRollupHour(ctx context.Context, bizLine string, hour time.Time) error {
	return r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("stat_hour = ?", hour).
		Delete(&GalaxyUsageRollup{}).Error
}
