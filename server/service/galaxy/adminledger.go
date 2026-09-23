package galaxy

import (
	"context"
	"strings"
	"time"

	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 三本账的逐笔流水。
//
// 结算汇总回答「这个月一共多少」，这一页回答「那一笔是怎么记的」—— 对账、申诉、
// 以及「平台这个月到底赚了多少」都要从这里查。**平台侧那本账此前完全没有读的路**：
// 毛利与坏账一直在写，而管理端任何一页都看不到它。
//
// 三张表的 amount 是三个不同的量纲，这一点必须一路透到界面上（AmountUnit），
// 否则界面会拿同一套「÷1,000,000 显示成元」的规则去渲染消费侧那一列，
// 得到一个荒唐的小数，而看的人不会意识到自己在读一个错的数。

// ledgerDefaultDays 账本默认往回看几天。
const ledgerDefaultDays = 30

// ledgerTypesBySide 每一侧会出现的流水类型。给界面做下拉用 ——
// 让运营去背 ref_clawback 这种字符串，等于让他永远筛不到那一类。
var ledgerTypesBySide = map[string][]string{
	dto.LedgerSideConsumer: {"topup", "reserve", "settle", "refund", "expire"},
	dto.LedgerSideProvider: {"contribute", "settle", "payout", "clawback", "referral", "ref_clawback"},
	dto.LedgerSidePlatform: {"fee", "baddebt"},
}

// ledgerAmountUnit 这一侧的 amount 是什么量纲。
var ledgerAmountUnit = map[string]string{
	// 消费侧扣的是额度本身：按计量单位发，也按计量单位扣。
	dto.LedgerSideConsumer: "metering",
	// 供给侧记的是微积分，和信用账户余额同一量纲。
	dto.LedgerSideProvider: "credit",
	// 平台侧记的是微分 —— 抽成与坏账都是钱。
	dto.LedgerSidePlatform: "money",
}

// AdminLedger 某一侧账本的逐笔流水 + 按类型的合计。
func (s *service) AdminLedger(ctx context.Context, query dto.AdminLedgerQuery) (dto.AdminLedgerPage, error) {
	side := strings.TrimSpace(query.Side)
	if _, known := ledgerTypesBySide[side]; !known {
		side = dto.LedgerSideConsumer
	}
	days := query.Days
	if days <= 0 {
		days = ledgerDefaultDays
	}
	var types []string
	if kind := strings.TrimSpace(query.Type); kind != "" {
		types = []string{kind}
	}
	scope := repository.AdminLedgerQuery{
		BizLine: bizLine, Side: side, Types: types,
		Keyword: strings.TrimSpace(query.Keyword),
		From:    time.Now().AddDate(0, 0, -days),
		Offset:  query.Offset, Limit: pageLimit(query.Limit, 20, 200),
	}
	rows, total, err := s.repository.ListAdminLedger(ctx, scope)
	if err != nil {
		return dto.AdminLedgerPage{}, err
	}
	// 合计按**整个筛选条件**算，所以清掉分页参数再查一次 ——
	// 一页 20 行里加出来的「合计」会随翻页变，那不是账。
	totalScope := scope
	totalScope.Offset, totalScope.Limit = 0, 0
	totals, err := s.repository.SumAdminLedgerByType(ctx, totalScope)
	if err != nil {
		return dto.AdminLedgerPage{}, err
	}

	page := dto.AdminLedgerPage{
		Total: total, Side: side, Days: days,
		AmountUnit: ledgerAmountUnit[side], Types: ledgerTypesBySide[side],
		Entries: make([]dto.LedgerEntry, 0, len(rows)),
		Totals:  make([]dto.LedgerTypeTotal, 0, len(totals)),
	}
	for _, row := range totals {
		page.Totals = append(page.Totals, dto.LedgerTypeTotal{Type: row.Type, Count: row.Count, Amount: row.Amount})
	}

	// 供给侧的行上有主人，查一次名字 —— 一串 pu_01J… 认不出是谁。
	names := map[string]string{}
	if side == dto.LedgerSideProvider {
		owners := make([]string, 0, len(rows))
		for _, row := range rows {
			owners = append(owners, row.OwnerUserID)
		}
		if names, err = s.userNames(ctx, dto.SideProvider, owners); err != nil {
			return dto.AdminLedgerPage{}, err
		}
	}
	for _, row := range rows {
		page.Entries = append(page.Entries, dto.LedgerEntry{
			TxnID: row.TxnID, Type: row.Type, Unit: row.Unit, Amount: row.Amount,
			Price: row.Price, UnitID: row.UnitID,
			KeyID: row.KeyID, BalanceAfter: row.BalanceAfter,
			CID: row.CID, OwnerUserID: row.OwnerUserID, OwnerName: names[row.OwnerUserID],
			RelatedUserID: row.RelatedUserID, CreatedAt: row.CreatedAt,
		})
	}
	return page, nil
}
