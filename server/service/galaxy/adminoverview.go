package galaxy

import (
	"context"
	"time"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 运营总览：「今天要做什么」。
//
// 共享池的运营散在十几个页面上。没有这一页，判断「有没有事要处理」只能一页页翻 ——
// 而那些事里有几件是**有人在等**：提现停在待处理就是有人的钱既不在手上也没打出去，
// 订单停在待付款就是有人付了钱没拿到额度。
//
// 所以这一页上每一项都是一个待办计数，点进去就是对应那一页。不放趋势图：
// 一块看着好看但不指向任何动作的仪表盘，第二周就没人看了。

// overviewMismatchDays 总览里「近期偏差」往回看几天。与偏差页的默认口径一致。
const overviewMismatchDays = mismatchDefaultDays

// AdminOverview 一次取回运营总览要的全部数字。
//
// 取不到的那几块记进 Degraded，**不当成 0** —— 控制面没配 Redis 时池水位是空的，
// 显示成「在线 0」会被读成「池子空了」，那是完全不同的一件事，而且会引来一次
// 本不该发生的排障。
func (s *service) AdminOverview(ctx context.Context) (dto.AdminOverview, error) {
	now := time.Now()
	view := dto.AdminOverview{Degraded: []string{}}

	if counts, err := s.repository.CountPayoutsByStatus(ctx, bizLine); err != nil {
		return view, err
	} else {
		view.PendingPayouts = counts[payoutPending]
	}
	if counts, err := s.repository.CountOrdersByStatus(ctx, bizLine); err != nil {
		return view, err
	} else {
		view.PendingOrders = counts[orderPending]
	}
	open, err := s.repository.CountOpenDisputes(ctx, bizLine, "")
	if err != nil {
		return view, err
	}
	view.OpenDisputes = open

	// 线索只要一个总数，取一行就够 —— limit 传 1，别把整页拉回来。
	if _, total, err := s.repository.ListLeads(ctx, bizLine, leadStatusNew, 0, 1); err != nil {
		return view, err
	} else {
		view.NewLeads = total
	}

	if banned, err := s.repository.CountBannedMachines(ctx, bizLine); err != nil {
		return view, err
	} else {
		view.BannedMachines = banned
	}

	if _, mismatches, err := s.repository.ListUsageMismatches(ctx, repository.MismatchQuery{
		BizLine: bizLine, From: now.AddDate(0, 0, -overviewMismatchDays), Limit: 1,
	}); err != nil {
		return view, err
	} else {
		view.RecentMismatches = mismatches
	}

	// 有量无价：这部分钱正在被静默算成 0，是这一页上最不该漏掉的一条。
	prices, err := s.AdminPrices(ctx)
	if err != nil {
		return view, err
	}
	view.UnpricedUnits = len(prices.Unpriced)

	// 今天的工单。按状态分组一次查完。
	states, err := s.repository.CountUnitsByState(ctx, bizLine, now.Truncate(24*time.Hour))
	if err != nil {
		return view, err
	}
	for state, total := range states {
		view.Today.Units += total
		switch {
		case contract.UnitState(state) == contract.UnitFailed:
			view.Today.Failed += total
		case !contract.UnitState(state).Terminal():
			view.Today.Running += total
		}
	}

	// 池水位在 Redis 上。它是唯一可能整块取不到的一项 —— 别让它带塌整个总览。
	pool, err := s.PoolStatus(ctx)
	if err != nil {
		view.Degraded = append(view.Degraded, "pool")
		return view, nil
	}
	view.Pool.Lanes = len(pool.Lanes)
	for _, lane := range pool.Lanes {
		view.Pool.Contributions += lane.Contributions
		view.Pool.Online += lane.Online
		view.Pool.SeatsTotal += lane.SeatsTotal
		view.Pool.SeatsUsed += lane.SeatsUsed
		view.Pool.Inflight += lane.Inflight
		view.Pool.WaitQueue += lane.WaitQueueDepth
	}
	return view, nil
}
