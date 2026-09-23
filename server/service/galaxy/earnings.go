package galaxy

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 提供者的收益面：今天这一页的全部数字、积分账本、提现（S-07 里供给侧那半）。
//
// 口径只在这个文件里定义一次。之前「今天赚了多少」是控制台自己把记录加一遍算出来的，
// 那样每加一个入口就多一份可能算错的口径 —— 而且前端拿不到已结算/待结算的区别。

const (
	payoutPending = "pending"

	// 账本类型。和 billing.go 结算时写下的那两个字符串是同一套词汇表。
	ledgerSettle = "settle"
	ledgerPayout = "payout"
	// unitCredit 提现流水的计量单位：动的是积分，不是 token。
	unitCredit = "credit"
)

// ProviderDashboard 「今天」那一页。
func (s *service) ProviderDashboard(ctx context.Context, ownerUserID string) (dto.ProviderDashboard, error) {
	now := time.Now()
	scope, err := s.ledgerScope(ctx, ownerUserID)
	if err != nil {
		return dto.ProviderDashboard{}, err
	}

	nodes, err := s.repository.ListNodesByOwner(ctx, bizLine, ownerUserID)
	if err != nil {
		return dto.ProviderDashboard{}, err
	}
	view := dto.ProviderDashboard{Nodes: len(nodes)}
	for _, node := range nodes {
		if node.Banned || node.Status != statusActive {
			continue
		}
		view.Online = true
		// 本轮共享的起点：节点这一次上线的时间。它由 Pair / hello 写，
		// 掉线再上线会刷新，所以「已连续 6 天 14 小时」不会把中断的那段算进去。
		if at := node.OnlineSince; at != nil && (view.SharingSince == nil || at.Before(*view.SharingSince)) {
			view.SharingSince = at
		}
	}

	if view.Credits, err = s.creditSummary(ctx, ownerUserID, scope, now); err != nil {
		return dto.ProviderDashboard{}, err
	}

	dayStart := startOfDay(now)
	if view.Today, err = s.dayStats(ctx, scope, dayStart, dayStart.AddDate(0, 0, 1)); err != nil {
		return dto.ProviderDashboard{}, err
	}
	if view.Yesterday, err = s.dayStats(ctx, scope, dayStart.AddDate(0, 0, -1), dayStart); err != nil {
		return dto.ProviderDashboard{}, err
	}
	if view.Trend, err = s.trend(ctx, scope, dayStart.AddDate(0, 0, -6), dayStart.AddDate(0, 0, 1)); err != nil {
		return dto.ProviderDashboard{}, err
	}
	return view, nil
}

// creditSummary 积分的四个口径 + 三个时间窗。
//
// 可提现 = 账户余额 − 争议期内刚结算的那部分。争议期内的积分留在余额里（它确实是
// 这个人的），但提不出来 —— 一旦争议成立要原路追回，钱已经打出去就追不回来了。
func (s *service) creditSummary(ctx context.Context, ownerUserID string, scope repository.LedgerQuery, now time.Time) (dto.CreditSummary, error) {
	var summary dto.CreditSummary

	balance, err := s.CreditBalance(ctx, ownerUserID)
	if err != nil {
		return summary, err
	}
	withdrawn, err := s.repository.SumPayouts(ctx, bizLine, ownerUserID)
	if err != nil {
		return summary, err
	}

	hold := scope
	// 邀请奖励同样要过争议期：它跟着被邀请人的那笔收益走，那笔被追回时奖励也要退。
	// 让它一到账就能提，等于把追回的风险留给平台。
	hold.Types = append([]string{ledgerSettle}, referralTypes...)
	hold.From = now.AddDate(0, 0, -s.cfg().PayoutHoldDays)
	pending, err := s.repository.SumProviderLedger(ctx, hold)
	if err != nil {
		return summary, err
	}
	if pending > balance {
		// 结算比提现快得多，正常不会走到这里；真走到了说明余额被别的路径动过，
		// 按「全部待结算」处理比让可提现变成负数安全。
		pending = balance
	}

	dayStart := startOfDay(now)
	windows := []struct {
		target *int64
		from   time.Time
	}{
		{&summary.Today, dayStart},
		{&summary.Week, dayStart.AddDate(0, 0, -6)},
		{&summary.Month, startOfMonth(now)},
	}
	earned := scope
	earned.Types = []string{ledgerSettle}
	for _, window := range windows {
		earned.From = window.from
		earned.To = time.Time{}
		value, err := s.repository.SumProviderLedger(ctx, earned)
		if err != nil {
			return summary, err
		}
		*window.target = value
	}
	earned.From = time.Time{}
	total, err := s.repository.SumProviderLedger(ctx, earned)
	if err != nil {
		return summary, err
	}

	// 邀请奖励单独给一格：上面那几个口径只算自己贡献算力赚的，
	// 邀请带来的那部分在里面一点都看不见，而它确实在余额里。
	referral := scope
	referral.Types = referralTypes
	referral.From, referral.To = time.Time{}, time.Time{}
	referralTotal, err := s.repository.SumProviderLedger(ctx, referral)
	if err != nil {
		return summary, err
	}

	summary.Available = balance - pending
	summary.Pending = pending
	summary.Withdrawn = withdrawn
	summary.Total = total
	summary.Referral = referralTotal
	return summary, nil
}

// formatPoints 把微积分写成人看的积分（1,000,000 = 1 积分 = ¥1）。
// 只用于错误信息：界面上的格式化在前端，服务端不替它排版。
func formatPoints(micro int64) string {
	if micro%priceScale == 0 {
		return strconv.FormatInt(micro/priceScale, 10)
	}
	return strconv.FormatFloat(float64(micro)/priceScale, 'f', -1, 64)
}

// dayStats 一段时间的执行统计。单元表是权威：积分从账本来，次数与用量从单元来。
func (s *service) dayStats(ctx context.Context, scope repository.LedgerQuery, from, to time.Time) (dto.DayStats, error) {
	stats := dto.DayStats{Usage: contract.Metering{}}
	if len(scope.CIDs) == 0 {
		return stats, nil
	}
	credits := scope
	credits.Types = []string{ledgerSettle}
	credits.From, credits.To = from, to
	credit, err := s.repository.SumProviderLedger(ctx, credits)
	if err != nil {
		return stats, err
	}
	stats.Credits = credit

	summary, err := s.repository.SummariseUnits(ctx, repository.UnitQuery{
		BizLine: bizLine, CIDs: scope.CIDs, From: from, To: to,
	})
	if err != nil {
		return stats, err
	}
	stats.Calls = summary.Calls
	stats.Failed = summary.Failed
	stats.AvgDurationMs = summary.AvgDurationMs
	for unit, amount := range summary.Usage {
		stats.Usage[contract.MeterUnit(unit)] = amount
	}
	return stats, nil
}

// trend 最近 N 天的积分。缺的那天补 0 —— 前端画柱子时不该再去对齐日期。
func (s *service) trend(ctx context.Context, scope repository.LedgerQuery, from, to time.Time) ([]dto.DailyPoint, error) {
	query := scope
	query.Types = []string{ledgerSettle}
	query.From, query.To = from, to
	rows, err := s.repository.SumProviderLedgerByDay(ctx, query)
	if err != nil {
		return nil, err
	}
	byDay := map[string]int64{}
	for _, row := range rows {
		// MySQL 的 DATE() 回来可能带时间部分（驱动把它当 datetime 解），截前 10 位。
		byDay[truncate(row.Date, 10)] = row.Amount
	}
	points := make([]dto.DailyPoint, 0, 7)
	for day := from; day.Before(to); day = day.AddDate(0, 0, 1) {
		key := day.Format("2006-01-02")
		points = append(points, dto.DailyPoint{Date: key, Amount: byDay[key]})
	}
	return points, nil
}

// ProviderLedger 积分账本分页。
func (s *service) ProviderLedger(ctx context.Context, query dto.LedgerQuery) (dto.CreditLedgerPage, error) {
	scope, err := s.ledgerScope(ctx, query.OwnerUserID)
	if err != nil {
		return dto.CreditLedgerPage{}, err
	}
	if query.Type != "" {
		scope.Types = []string{query.Type}
	}
	scope.Offset = query.Offset
	scope.Limit = pageLimit(query.Limit, 50, 200)

	rows, total, err := s.repository.ListProviderLedger(ctx, scope)
	if err != nil {
		return dto.CreditLedgerPage{}, err
	}
	page := dto.CreditLedgerPage{Total: total, Entries: make([]dto.CreditLedgerEntry, 0, len(rows))}
	for _, row := range rows {
		page.Entries = append(page.Entries, dto.CreditLedgerEntry{
			Type: row.Type, Amount: row.Amount, Unit: row.Unit, UnitID: row.UnitID,
			CID: row.CID, CreatedAt: row.CreatedAt,
		})
	}
	return page, nil
}

// ProviderRecords 「我的机器上跑过什么」，分页 + 当前筛选条件下的统计。
//
// 匿名化的承诺没变（C-12）：这里出去的仍然只有 kind、模型、用量、结果，
// 没有消费者身份，也没有请求内容。
func (s *service) ProviderRecords(ctx context.Context, query dto.ProviderRecordQuery) (dto.ProviderRecordPage, error) {
	rows, err := s.repository.ListContributionsByOwner(ctx, bizLine, query.OwnerUserID)
	if err != nil {
		return dto.ProviderRecordPage{}, err
	}
	if len(rows) == 0 {
		return dto.ProviderRecordPage{Records: []dto.ExecutionRecord{}, Models: []string{}, Stats: dto.DayStats{Usage: contract.Metering{}}}, nil
	}

	cids := make([]string, 0, len(rows))
	for _, row := range rows {
		cids = append(cids, row.CID)
	}
	if query.CID != "" {
		// 界面上显示的是去掉节点前缀的短名，两台机器上会重名 —— 全都算进来，
		// 而不是挑第一条。主人问的是「这个能力跑了什么」，不是「哪台机器」。
		matched := make([]string, 0, 2)
		for _, row := range rows {
			if row.CID == query.CID || unscopedCID(row.NodeID, row.CID) == query.CID {
				matched = append(matched, row.CID)
			}
		}
		if len(matched) == 0 {
			return dto.ProviderRecordPage{}, fmt.Errorf("贡献不存在")
		}
		cids = matched
	}

	unitQuery := repository.UnitQuery{
		BizLine: bizLine, CIDs: cids, Model: query.Model, State: query.State,
		From: query.From, To: query.To,
		Offset: query.Offset, Limit: pageLimit(query.Limit, 20, 200),
	}
	units, total, err := s.repository.ListUnits(ctx, unitQuery)
	if err != nil {
		return dto.ProviderRecordPage{}, err
	}

	ids := make([]string, 0, len(units))
	for _, unit := range units {
		ids = append(ids, unit.UnitID)
	}
	perUnit, err := s.repository.SumProviderCreditByUnit(ctx, bizLine, ids)
	if err != nil {
		return dto.ProviderRecordPage{}, err
	}
	nodeOf := nodeOfContribution(rows)
	// 分组名一次解完：记录页要显示「标准 / 深度」，库里存的是 mg_…。
	groupNames := s.groupNames(ctx)
	page := dto.ProviderRecordPage{Total: total, Records: make([]dto.ExecutionRecord, 0, len(units))}
	for _, unit := range units {
		page.Records = append(page.Records, dto.ExecutionRecord{
			UnitID: unit.UnitID, Kind: unit.Kind, Model: unit.Model,
			GroupID: unit.GroupID, GroupName: groupNames[unit.GroupID], State: unit.State,
			ErrorCode: unit.ErrorCode, Usage: decodeMetering(unit.ActualJSON),
			Credits:   perUnit[unit.UnitID],
			NodeID:    nodeOf[unit.CID],
			StartedAt: unit.StartedAt, FinishedAt: unit.FinishedAt,
		})
	}
	if err := s.nameRecordNodes(ctx, query.OwnerUserID, page.Records); err != nil {
		return dto.ProviderRecordPage{}, err
	}

	summary, err := s.repository.SummariseUnits(ctx, unitQuery)
	if err != nil {
		return dto.ProviderRecordPage{}, err
	}
	page.Stats = dto.DayStats{Usage: contract.Metering{}, Calls: summary.Calls, Failed: summary.Failed, AvgDurationMs: summary.AvgDurationMs}
	for unit, amount := range summary.Usage {
		page.Stats.Usage[contract.MeterUnit(unit)] = amount
	}
	credits, err := s.repository.SumProviderLedger(ctx, repository.LedgerQuery{
		BizLine: bizLine, CIDs: cids, Types: []string{ledgerSettle}, From: query.From, To: query.To,
	})
	if err != nil {
		return dto.ProviderRecordPage{}, err
	}
	page.Stats.Credits = credits

	if page.Models, err = s.repository.DistinctUnitModels(ctx, bizLine, cids); err != nil {
		return dto.ProviderRecordPage{}, err
	}
	return page, nil
}

// ---------- 提现 ----------

// ListPayouts 我的提现申请。
func (s *service) ListPayouts(ctx context.Context, ownerUserID string, limit int) ([]dto.PayoutView, error) {
	rows, err := s.repository.ListPayouts(ctx, bizLine, ownerUserID, pageLimit(limit, 20, 100))
	if err != nil {
		return nil, err
	}
	views := make([]dto.PayoutView, 0, len(rows))
	for _, row := range rows {
		views = append(views, payoutView(row))
	}
	return views, nil
}

// CreatePayout 发起提现。
//
// 顺序是被「钱不能凭空多出来」逼出来的：先条件扣减积分（扣不动就说明余额不够或者
// 有人同时提了另一笔），扣成功才建申请单。反过来先建单再扣，两步之间进程挂掉就会
// 留下一张已受理但没扣过账的单子 —— 那等于白送一笔。
func (s *service) CreatePayout(ctx context.Context, req dto.CreatePayoutRequest) (dto.PayoutView, error) {
	method := strings.TrimSpace(strings.ToLower(req.Method))
	switch method {
	case "alipay", "wechat", "bank":
	default:
		return dto.PayoutView{}, fmt.Errorf("不支持的收款方式: %s", req.Method)
	}
	account := strings.TrimSpace(req.Account)
	if account == "" {
		return dto.PayoutView{}, fmt.Errorf("请填写收款账号")
	}
	// 下面两条都按**微积分**算（1,000,000 = 1 积分 = ¥1），报错时换成积分说，
	// 界面上显示的就是积分 —— 拿微积分的原始数字去提示，用户看到的是一串读不懂的零。
	if req.Credits < s.cfg().PayoutMinCredits {
		return dto.PayoutView{}, fmt.Errorf("单次提现不少于 %s 积分", formatPoints(s.cfg().PayoutMinCredits))
	}
	if req.Credits%int64(s.cfg().PayoutRate) != 0 {
		// 不整除会在折算时留下不足一分的零头，那笔零头既打不出去也退不回来。
		return dto.PayoutView{}, fmt.Errorf("提现金额需为整数积分（%s 积分的整数倍）", formatPoints(int64(s.cfg().PayoutRate)))
	}

	scope, err := s.ledgerScope(ctx, req.OwnerUserID)
	if err != nil {
		return dto.PayoutView{}, err
	}
	summary, err := s.creditSummary(ctx, req.OwnerUserID, scope, time.Now())
	if err != nil {
		return dto.PayoutView{}, err
	}
	if req.Credits > summary.Available {
		return dto.PayoutView{}, fmt.Errorf("可提现积分不足，当前可提 %d", summary.Available)
	}

	ok, err := s.repository.DeductCredit(ctx, bizLine, req.OwnerUserID, req.Credits)
	if err != nil {
		return dto.PayoutView{}, err
	}
	if !ok {
		return dto.PayoutView{}, fmt.Errorf("可提现积分不足")
	}

	now := time.Now()
	row := &repository.GalaxyPayout{
		BizLine: bizLine, PayoutID: "po_" + NewULID(now), OwnerUserID: req.OwnerUserID,
		Credits: req.Credits, Amount: req.Credits / int64(s.cfg().PayoutRate) * priceScale,
		Currency: "CNY", Method: method, Account: account, Status: payoutPending,
	}
	if err := s.repository.CreatePayout(ctx, row); err != nil {
		// 单子没建成就把积分还回去，否则这笔钱谁也拿不到了。
		_ = s.repository.AddCredit(ctx, bizLine, req.OwnerUserID, req.Credits)
		return dto.PayoutView{}, err
	}
	// 账本上记一笔，让「余额少了」在账本里有据可查。幂等键用 payoutId，重放不会记两次。
	_ = s.repository.SaveProviderLedger(ctx, []*repository.GalaxyProviderLedger{{
		BizLine: bizLine, TxnID: row.PayoutID + ":payout", OwnerUserID: req.OwnerUserID,
		Type: ledgerPayout, Unit: unitCredit, Amount: -req.Credits,
	}})
	return payoutView(row), nil
}

func payoutView(row *repository.GalaxyPayout) dto.PayoutView {
	return dto.PayoutView{
		PayoutID: row.PayoutID, Credits: row.Credits, Amount: row.Amount, Currency: row.Currency,
		Fee: row.Fee, Method: row.Method, Account: maskAccount(row.Account), Status: row.Status,
		Note: row.Note, HandledAt: row.HandledAt, CreatedTime: row.CreatedTime,
	}
}

// maskAccount 收款账号只回打码后的。它进了前端就会进日志、进截图，
// 而列表里要回答的只是「打到哪个账号」，认得出来就够了。
func maskAccount(account string) string {
	if at := strings.Index(account, "@"); at > 0 {
		return "***" + account[at:]
	}
	runes := []rune(account)
	if len(runes) <= 4 {
		return "****"
	}
	return string(runes[:2]) + strings.Repeat("*", len(runes)-4) + string(runes[len(runes)-2:])
}

// ledgerScope 把「这个人」翻译成账本的过滤条件。
//
// 结算写的是 cid（那条路径上只有贡献），提现写的是 owner。两个维度都要带上，
// 否则账本要么漏掉收益，要么漏掉提现。
func (s *service) ledgerScope(ctx context.Context, ownerUserID string) (repository.LedgerQuery, error) {
	rows, err := s.repository.ListContributionsByOwner(ctx, bizLine, ownerUserID)
	if err != nil {
		return repository.LedgerQuery{}, err
	}
	cids := make([]string, 0, len(rows))
	for _, row := range rows {
		cids = append(cids, row.CID)
	}
	sort.Strings(cids)
	return repository.LedgerQuery{BizLine: bizLine, OwnerUserID: ownerUserID, CIDs: cids}, nil
}

func startOfDay(at time.Time) time.Time {
	return time.Date(at.Year(), at.Month(), at.Day(), 0, 0, 0, 0, at.Location())
}

func startOfMonth(at time.Time) time.Time {
	return time.Date(at.Year(), at.Month(), 1, 0, 0, 0, 0, at.Location())
}

// pageLimit 页大小的统一收口。上限是防「limit=100000 把库拖死」，不是产品限制。
func pageLimit(requested, fallback, max int) int {
	if requested <= 0 {
		return fallback
	}
	if requested > max {
		return max
	}
	return requested
}
