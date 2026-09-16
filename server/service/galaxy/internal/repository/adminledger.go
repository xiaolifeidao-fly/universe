package repository

import (
	"context"
	"time"

	"gorm.io/gorm"
)

// 三本账的运营读取。
//
// 结算会同时写三行：消费侧扣的是**用量**（按计量单位发的额度），供给侧记的是**微积分**，
// 平台侧记的是**微分**。三张表的 amount 是三个不同的量纲 —— 这是这组查询存在的
// 主要理由，也是它必须按侧分开查、分开显示的理由：把三个数放在一列里加起来，
// 得到的是一个没有意义的数字。
//
// 和 earnings.go 的 ledgerScope 分开写，因为**它们的默认行为必须相反**：
// 那一个在过滤维度全空时故意 `1 = 0`（那是某个人的账本，查不到人就该是空，不是全站）；
// 这一个不带维度就是全站 —— 它本来就是运营视角。两者混用一个函数，迟早有人
// 顺手去掉那个守卫，把用户侧的接口变成一个越权入口。

const (
	LedgerSideConsumer = "consumer"
	LedgerSideProvider = "provider"
	LedgerSidePlatform = "platform"
)

// AdminLedgerQuery 三本账通用的过滤条件。
type AdminLedgerQuery struct {
	BizLine string
	Side    string
	Types   []string
	// Keyword 按幂等键、工单号，以及这一侧的主体（密钥 / 贡献 / 主人）模糊找。
	Keyword string
	From    time.Time
	To      time.Time
	Offset  int
	Limit   int
}

// LedgerEntry 一行账本。三侧共用一个形状，各自没有的列留空 ——
// 三张表的列不一样，为每一侧单独定义一个结构会让上层多出两份几乎一样的映射代码。
type LedgerEntry struct {
	TxnID  string `gorm:"column:txn_id"`
	Type   string `gorm:"column:type"`
	Unit   string `gorm:"column:unit"`
	Amount int64  `gorm:"column:amount"`
	Price  int64  `gorm:"column:price"`
	UnitID string `gorm:"column:unit_id"`
	// KeyID / BalanceAfter 只有消费侧有。
	KeyID        string `gorm:"column:key_id"`
	BalanceAfter int64  `gorm:"column:balance_after"`
	// CID / OwnerUserID / RelatedUserID 只有供给侧有。
	CID           string    `gorm:"column:cid"`
	OwnerUserID   string    `gorm:"column:owner_user_id"`
	RelatedUserID string    `gorm:"column:related_user_id"`
	CreatedAt     time.Time `gorm:"column:created_at"`
}

// LedgerTypeTotal 某一类流水的笔数与合计。
type LedgerTypeTotal struct {
	Type   string `gorm:"column:type"`
	Count  int64  `gorm:"column:cnt"`
	Amount int64  `gorm:"column:amount"`
}

// ledgerTable 这一侧查哪张表、选哪些列、按哪些列搜。
func ledgerTable(side string) (model any, columns []string, searchable []string) {
	switch side {
	case LedgerSideProvider:
		return &GalaxyProviderLedger{},
			[]string{"txn_id", "type", "unit", "amount", "price", "unit_id", "cid", "owner_user_id", "related_user_id", "created_at"},
			[]string{"txn_id", "unit_id", "cid", "owner_user_id"}
	case LedgerSidePlatform:
		return &GalaxyPlatformLedger{},
			[]string{"txn_id", "type", "amount", "unit_id", "created_at"},
			[]string{"txn_id", "unit_id"}
	default:
		return &GalaxyConsumerLedger{},
			[]string{"txn_id", "type", "unit", "amount", "price", "unit_id", "key_id", "balance_after", "created_at"},
			[]string{"txn_id", "unit_id", "key_id"}
	}
}

func (r *GalaxyRepository) adminLedgerScope(query AdminLedgerQuery) *gorm.DB {
	model, _, searchable := ledgerTable(query.Side)
	tx := r.Db.Model(model).Where("biz_line = ?", query.BizLine)
	if len(query.Types) > 0 {
		tx = tx.Where("type IN ?", query.Types)
	}
	if query.Keyword != "" {
		like := "%" + query.Keyword + "%"
		// 逐列 OR 拼出来，不是把列名拼进 SQL 字符串 —— searchable 虽然是常量，
		// 但拼字符串这个写法本身会被后来人照抄到一个带用户输入的地方去。
		condition := r.Db.Where(searchable[0]+" LIKE ?", like)
		for _, column := range searchable[1:] {
			condition = condition.Or(column+" LIKE ?", like)
		}
		tx = tx.Where(condition)
	}
	if !query.From.IsZero() {
		tx = tx.Where("created_at >= ?", query.From)
	}
	if !query.To.IsZero() {
		tx = tx.Where("created_at < ?", query.To)
	}
	return tx
}

// ListAdminLedger 分页读某一侧的账本。
func (r *GalaxyRepository) ListAdminLedger(ctx context.Context, query AdminLedgerQuery) ([]LedgerEntry, int64, error) {
	var total int64
	if err := r.adminLedgerScope(query).WithContext(ctx).Count(&total).Error; err != nil {
		return nil, 0, err
	}
	_, columns, _ := ledgerTable(query.Side)
	tx := r.adminLedgerScope(query).WithContext(ctx).
		Select(columns).Order("created_at desc, id desc")
	if query.Limit > 0 {
		tx = tx.Limit(query.Limit).Offset(query.Offset)
	}
	var rows []LedgerEntry
	err := tx.Scan(&rows).Error
	return rows, total, err
}

// SumAdminLedgerByType 按类型分组的笔数与合计。
//
// 它统计的是**整个筛选条件**，不是当前这一页 —— 一页 20 行里加出来的「合计」
// 会随翻页变，那不是账。
func (r *GalaxyRepository) SumAdminLedgerByType(ctx context.Context, query AdminLedgerQuery) ([]LedgerTypeTotal, error) {
	var rows []LedgerTypeTotal
	err := r.adminLedgerScope(query).WithContext(ctx).
		Select("type, COUNT(*) AS cnt, SUM(amount) AS amount").
		Group("type").Order("type").Scan(&rows).Error
	return rows, err
}
