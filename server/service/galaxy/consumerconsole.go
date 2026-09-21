package galaxy

import (
	"context"
	"time"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 消费者控制台的两块新视图：一排概览数字，和逐笔扣费。
//
// 逐笔和 Usage 那份汇总是两个问题：汇总回答「这个月花了多少」，逐笔回答
// 「14:28 那次为什么扣了 2,288」。后者是申诉的入口 —— 申诉钉的是
// (unitId, attempt)，不摆出 unitId 就没法从账单点进申诉。

// ConsumerDashboard 密钥页与使用记录页共用的那排数字。
func (s *service) ConsumerDashboard(ctx context.Context, ownerUserID string, days int) (dto.ConsumerDashboard, error) {
	view := dto.ConsumerDashboard{
		Days: pageLimit(days, 10, 90), Currency: "CNY",
		Today: dto.DayStats{Usage: contract.Metering{}},
	}

	// 余额挂在账户上，和有几把密钥无关 —— 一把都没有也要报得出这个数，
	// 否则新账号打开页面看到的是「余额 0」，而他刚充过钱。
	account, err := s.repository.FindPointsAccount(ctx, bizLine, ownerUserID)
	if err != nil && !notFound(err) {
		return view, err
	}
	if account != nil {
		view.Balance = account.Balance
	}

	rows, err := s.repository.ListConsumerKeys(ctx, bizLine, ownerUserID)
	if err != nil {
		return view, err
	}
	now := time.Now()
	keys := make([]string, 0, len(rows))
	for _, row := range rows {
		keys = append(keys, row.KeyID)
		view.Keys++
		if usableKey(row, now) {
			view.ActiveKeys++
		}
	}
	if len(keys) == 0 {
		return view, nil
	}

	dayStart := startOfDay(now)
	summary, err := s.repository.SummariseUnits(ctx, repository.UnitQuery{
		BizLine: bizLine, ConsumerKeys: keys, From: dayStart, To: dayStart.AddDate(0, 0, 1),
	})
	if err != nil {
		return view, err
	}
	view.Today.Calls = summary.Calls
	view.Today.Failed = summary.Failed
	view.Today.AvgDurationMs = summary.AvgDurationMs
	for unit, amount := range summary.Usage {
		view.Today.Usage[contract.MeterUnit(unit)] = amount
	}

	// 花费用现成的账单口径算，不另起一套：这个数字和「使用记录」页脚的合计
	// 必须是同一个来源，否则两处差一分钱就会被当成计费出错。
	report, err := s.Usage(ctx, dto.UsageQuery{
		ConsumerKeys: keys, From: now.AddDate(0, 0, -view.Days), To: now,
	})
	if err != nil {
		return view, err
	}
	view.SpentMicros = report.TotalFee
	view.AvgFirstByteMs, err = s.repository.AvgFirstByteMs(ctx, repository.UnitQuery{
		BizLine: bizLine, ConsumerKeys: keys, From: dayStart, To: dayStart.AddDate(0, 0, 1),
	})
	if err != nil {
		return view, err
	}
	return view, nil
}

// OwnedUsageRecords 逐笔扣费。范围由令牌决定，请求里的 keyId 只能收窄。
func (s *service) OwnedUsageRecords(ctx context.Context, query dto.UsageRecordQuery) (dto.UsageRecordPage, error) {
	rows, err := s.repository.ListConsumerKeys(ctx, bizLine, query.OwnerUserID)
	if err != nil {
		return dto.UsageRecordPage{}, err
	}
	alias := map[string]string{}
	owned := make([]string, 0, len(rows))
	for _, row := range rows {
		owned = append(owned, row.KeyID)
		alias[row.KeyID] = row.Alias
	}
	keys := narrowKeys(owned, query.KeyID)
	if len(keys) == 0 {
		return dto.UsageRecordPage{Records: []dto.UsageRecord{}}, nil
	}

	units, total, err := s.repository.ListUnits(ctx, repository.UnitQuery{
		BizLine: bizLine, ConsumerKeys: keys, Kind: query.Kind, State: query.State,
		From: query.From, To: query.To,
		Offset: query.Offset, Limit: pageLimit(query.Limit, 20, 200),
	})
	if err != nil {
		return dto.UsageRecordPage{}, err
	}

	ids := make([]string, 0, len(units))
	for _, unit := range units {
		ids = append(ids, unit.UnitID)
	}
	costs, err := s.repository.SumConsumerCostByUnit(ctx, bizLine, ids)
	if err != nil {
		return dto.UsageRecordPage{}, err
	}

	page := dto.UsageRecordPage{Total: total, Records: make([]dto.UsageRecord, 0, len(units))}
	for _, unit := range units {
		record := dto.UsageRecord{
			UnitID: unit.UnitID, KeyID: unit.ConsumerKey, KeyAlias: alias[unit.ConsumerKey],
			Kind: unit.Kind, Provider: unit.Provider, Model: unit.Model, Effort: unit.Effort, State: unit.State,
			Attempt: unit.Attempt, ErrorCode: unit.ErrorCode, Usage: decodeMetering(unit.ActualJSON),
			Cost: costs[unit.UnitID], Currency: "CNY",
			StartedAt: unit.StartedAt, FinishedAt: unit.FinishedAt,
		}
		if unit.StartedAt != nil && unit.FinishedAt != nil {
			record.DurationMs = unit.FinishedAt.Sub(*unit.StartedAt).Milliseconds()
		}
		page.Records = append(page.Records, record)
	}
	return page, nil
}
