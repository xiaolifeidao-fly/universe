package galaxy

import (
	"context"
	"sort"
	"strings"
	"time"

	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 管理端仪表盘：今天来了多少人、跑了多少量、收了多少钱、池子还剩多少。
//
// 和运营总览（adminoverview.go）分开：那一页数的是待办，这一页数的是经营。
//
// 这一页最贵的一块是用量，它走一张按小时的汇总表，在 usagerollup.go 里。

// quotaSnapshotStaleAfter 额度计数器的快照超过这么久没更新就算旧数。
// 快照是每分钟一次的巡检写回来的，三倍间隔还没动就说明巡检或 Redis 出事了 ——
// 此时「已用」是个旧数，算出来的剩余会偏多，界面上必须说出来。
const quotaSnapshotStaleAfter = 3 * time.Minute

// AdminDashboard 一次取回仪表盘要的全部数字。
func (s *service) AdminDashboard(ctx context.Context) (dto.AdminDashboard, error) {
	now := time.Now()
	dayStart := startOfDay(now)
	view := dto.AdminDashboard{
		GeneratedAt: now,
		Date:        dayStart.Format("2006-01-02"),
		DayStart:    dayStart,
		Degraded:    []string{},
	}

	accounts, err := s.dashboardAccounts(ctx, dayStart)
	if err != nil {
		return view, err
	}
	view.Accounts = accounts

	presence, err := s.repository.ListNodePresence(ctx, bizLine, now.Add(-s.cfg().HeartbeatTimeout))
	if err != nil {
		return view, err
	}
	view.Machines = machinesOf(presence)

	usage, rolledUntil, err := s.usageRange(ctx, dayStart, now)
	if err != nil {
		return view, err
	}
	view.Usage = usage
	view.Usage.RolledUntil = rolledUntil

	revenue, err := s.dashboardRevenue(ctx, dayStart, now)
	if err != nil {
		return view, err
	}
	view.Revenue = revenue

	tracking, err := s.dashboardTracking(ctx, dayStart)
	if err != nil {
		return view, err
	}
	view.Tracking = tracking

	capacity, err := s.dashboardCapacity(ctx, presence, now)
	if err != nil {
		return view, err
	}
	view.Capacity = capacity
	if capacity.Stale {
		view.Degraded = append(view.Degraded, "capacity")
	}
	return view, nil
}

// ---------- 账号 ----------

func (s *service) dashboardAccounts(ctx context.Context, dayStart time.Time) (dto.DashboardAccounts, error) {
	var out dto.DashboardAccounts
	provider, err := s.repository.AccountStatSince(ctx, bizLine, repository.SideProvider, dayStart)
	if err != nil {
		return out, err
	}
	consumer, err := s.repository.AccountStatSince(ctx, bizLine, repository.SideConsumer, dayStart)
	if err != nil {
		return out, err
	}
	out.Provider = dto.DashboardAccountStat{LoggedIn: provider.LoggedIn, Registered: provider.Registered, Total: provider.Total}
	out.Consumer = dto.DashboardAccountStat{LoggedIn: consumer.LoggedIn, Registered: consumer.Registered, Total: consumer.Total}
	return out, nil
}

// ---------- 机器 ----------

// machinesOf 数在线机器，并把在线的那些按散户 / 工作室分开。
func machinesOf(rows []repository.NodePresence) dto.DashboardMachines {
	var out dto.DashboardMachines
	for _, row := range rows {
		out.Total++
		if row.Banned {
			out.Banned++
		}
		if !row.Online {
			out.Offline++
			continue
		}
		out.Online++
		// 身份只分两种，认不出来的算散户 —— 注册默认就是散户，
		// 多出一个「未知」栏只会让两个数加不出在线总数。
		if row.ProviderType == dto.ProviderStudio {
			out.Studio++
		} else {
			out.Individual++
		}
	}
	return out
}

// ---------- 进账 ----------

func (s *service) dashboardRevenue(ctx context.Context, from, to time.Time) (dto.DashboardRevenue, error) {
	var out dto.DashboardRevenue
	recharge, points, err := s.repository.SumPointsRecharge(ctx, bizLine, from, to)
	if err != nil {
		return out, err
	}
	out.RechargeCount, out.RechargePaid, out.RechargePoints = recharge.Count, recharge.Amount, points

	orders, err := s.repository.SumOrdersPaid(ctx, bizLine, from, to)
	if err != nil {
		return out, err
	}
	for _, row := range orders {
		if row.Method == "points" {
			out.PointsCount, out.PointsPaid = row.Count, row.Amount
			continue
		}
		out.ChannelCount, out.ChannelPaid = row.Count, row.Amount
	}
	return out, nil
}

// ---------- 算力剩余 ----------

// dashboardCapacity 此刻池子里还剩多少 token 额度。
//
// 只算**在线**的机器：离线机器的剩余额度此刻一个 token 都放不出来，
// 把它们加进来会得出一个池子根本兑现不了的数。
//
// 上限来自共享者自己设的授权（zt_galaxy_quota_grant），已用来自额度计数器
// 每分钟回写的快照（zt_galaxy_quota_window）。权威的计数器在 Redis 上 ——
// 这里读快照而不是逐条去问 Redis：几千条贡献就是几千次往返，而仪表盘会自动刷新。
// 代价是数字最多旧一分钟，SnapshotAt 把这件事说出来。
func (s *service) dashboardCapacity(ctx context.Context, presence []repository.NodePresence, now time.Time) (dto.DashboardCapacity, error) {
	out := dto.DashboardCapacity{Windows: []dto.DashboardCapacityWindow{}}
	online := map[string]bool{}
	for _, row := range presence {
		if row.Online {
			online[row.NodeID] = true
		}
	}
	out.OnlineMachines = int64(len(online))
	if len(online) == 0 {
		return out, nil
	}

	contributions, err := s.repository.ListActiveContributions(ctx, bizLine)
	if err != nil {
		return out, err
	}
	live := make([]*repository.GalaxyContribution, 0, len(contributions))
	for _, row := range contributions {
		if online[row.NodeID] {
			live = append(live, row)
		}
	}
	grants, err := s.loadGrants(ctx, cidsOf(live))
	if err != nil {
		return out, err
	}

	// 当下生效的窗口键只有几个（每种窗口、每个归零时刻各一个），
	// 按它们取快照 —— 按 cid 取的话 IN 列表有几千项。
	keys := map[string]bool{}
	for _, row := range live {
		for _, grant := range grants[row.CID] {
			if isTokenUnit(grant.Unit) && grant.Limit > 0 {
				keys[grant.WindowKey(now)] = true
			}
		}
	}
	snapshots, err := s.repository.ListQuotaWindowsByKeys(ctx, bizLine, sortedKeys(keys))
	if err != nil {
		return out, err
	}
	type counter struct{ used, reserved int64 }
	counters := map[string]counter{}
	for _, row := range snapshots {
		counters[row.CID+"\x00"+row.Unit+"\x00"+row.WindowKey] = counter{used: row.Used, reserved: row.Reserved}
		if row.SnapshotAt.After(out.SnapshotAt) {
			out.SnapshotAt = row.SnapshotAt
		}
	}

	buckets := map[string]*capacityBucket{}
	granted := map[string]bool{} // 设过 token 额度的机器
	withLeft := map[string]bool{}
	for _, row := range live {
		for _, grant := range grants[row.CID] {
			if !isTokenUnit(grant.Unit) || grant.Limit <= 0 {
				continue
			}
			granted[row.NodeID] = true
			window := grant.normalizedWindow()
			bucket, ok := buckets[window]
			if !ok {
				bucket = newCapacityBucket(window)
				buckets[window] = bucket
			}
			counted := counters[row.CID+"\x00"+grant.Unit+"\x00"+grant.WindowKey(now)]
			// 预留的那部分算「已用」：它是在途请求占着的量，此刻放不出来。
			left := grant.Limit - counted.used - counted.reserved
			if left < 0 {
				left = 0
			}
			bucket.add(grant.Unit, grant.Limit, counted.used+counted.reserved, left)
			bucket.cids[row.CID] = true
			if left > 0 {
				bucket.machines[row.NodeID] = true
				withLeft[row.NodeID] = true
			}
		}
	}

	for _, bucket := range buckets {
		out.Windows = append(out.Windows, bucket.view())
	}
	sort.Slice(out.Windows, func(i, j int) bool {
		return windowOrder(out.Windows[i].Window) < windowOrder(out.Windows[j].Window)
	})
	out.Machines = int64(len(withLeft))
	for nodeID := range online {
		if !granted[nodeID] {
			out.Unlimited++
		}
	}
	// 有在线机器设了额度，却一条快照都没有（或者快照停在几分钟前）：
	// 巡检或 Redis 出事了。此时「已用」是旧数，剩余会偏多。
	if len(granted) > 0 && (out.SnapshotAt.IsZero() || now.Sub(out.SnapshotAt) > quotaSnapshotStaleAfter) {
		out.Stale = true
	}
	return out, nil
}

type capacityBucket struct {
	window        string
	limit         int64
	used          int64
	left          int64
	units         map[string]*dto.DashboardCapacityUnit
	machines      map[string]bool
	cids          map[string]bool
	unitOrderSeen []string
}

func newCapacityBucket(window string) *capacityBucket {
	return &capacityBucket{
		window:   window,
		units:    map[string]*dto.DashboardCapacityUnit{},
		machines: map[string]bool{},
		cids:     map[string]bool{},
	}
}

func (b *capacityBucket) add(unit string, limit, used, left int64) {
	b.limit += limit
	b.used += used
	b.left += left
	row, ok := b.units[unit]
	if !ok {
		row = &dto.DashboardCapacityUnit{Unit: unit}
		b.units[unit] = row
		b.unitOrderSeen = append(b.unitOrderSeen, unit)
	}
	row.Limit += limit
	row.Used += used
	row.Left += left
}

func (b *capacityBucket) view() dto.DashboardCapacityWindow {
	view := dto.DashboardCapacityWindow{
		Window: b.window, Limit: b.limit, Used: b.used, Left: b.left,
		Machines: int64(len(b.machines)), Contributions: int64(len(b.cids)),
		Units: make([]dto.DashboardCapacityUnit, 0, len(b.units)),
	}
	sort.Strings(b.unitOrderSeen)
	for _, unit := range b.unitOrderSeen {
		view.Units = append(view.Units, *b.units[unit])
	}
	return view
}

// isTokenUnit 是不是一个「多少 token」的计量单位。
//
// 只有它们进算力剩余：llm.calls 与 time.seconds 也能设上限，但那是「还能跑几次」
// 「还能跑多久」，和「还剩多少 token」不是一个量纲，加在一起没有意义。
func isTokenUnit(unit string) bool { return strings.HasSuffix(unit, "_tokens") }

// windowOrder 档位按窗口从短到长排，不按字母序 —— 5h 排在 day 前面才读得顺。
func windowOrder(window string) int {
	switch window {
	case Window5H:
		return 0
	case WindowDay:
		return 1
	case WindowWeek:
		return 2
	case WindowMonth:
		return 3
	default:
		return 4
	}
}
