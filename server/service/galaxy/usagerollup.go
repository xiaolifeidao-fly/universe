package galaxy

import (
	"context"
	"sort"
	"strings"
	"time"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 仪表盘的用量汇总：按小时算一次、存下来，之后就读它。
//
// 为什么要垫这一层：「今天消耗了多少 token、收了多少、结出去多少，按 Claude / Codex
// 分开」这一个问题，原始出处是三张表 —— 量在计量流水上、钱在消费与供给两本账上，
// 而「是 Claude 还是 Codex」只有工单行上的模型说得清。也就是说每问一次，都要把当天
// 最大的三张表各扫一遍、每行再回工单表查一次模型。而仪表盘是会挂在大屏上自动刷新的页面。
//
// 汇总表的形状与约束见 zt_galaxy_usage_rollup 的建表注释。

// rollupGrace 小时桶封口之后再等这么久才认定它「不会再变」。
//
// 行归到哪一桶按它自己的写入时刻算，所以正常情况下封口即定稿。这一分钟是留给
// 机器之间的时钟差的：几台 Hub 的表差几秒，就可能有一行落在刚封口的那一桶里。
const rollupGrace = time.Minute

// rollupBackfillHours 巡检往回看多少个小时，rollupPerRunHours 一轮最多真的算几个。
//
// 两个数分开，是因为「要补的有多少」和「一轮能补多少」是两件事。巡检一轮有 30 秒
// 超时，而补一个小时要把那个小时的计量流水和两本账各扫一遍 —— 冷启动时缺 48 个桶，
// 一口气补完会把整轮堵死。每轮补 6 个，几分钟内自己追平。
//
// 追不上也不会漏：没补上的桶在仪表盘读到它的时候会被现算一次并落库（usageRange），
// 两条路补的是同一张表、同一份数。
const (
	rollupBackfillHours = 48
	rollupPerRunHours   = 6
)

// usageRange 取 [from, to) 的用量，按小时桶走汇总表。
//
// 封口的整点小时读汇总表，表里没有就现算一次并写回去；当前这个还没走完的小时
// （以及头尾那些不满一个整点的零头）每次都现算，不落库 —— 一个还在长的桶写进去，
// 下次读到的就是一个定格在半途的数。
//
// 第二个返回值是「汇总表已经封口到哪一刻」，界面上要显示它：数字对不上时，
// 先看是不是有一段还在现算。
func (s *service) usageRange(ctx context.Context, from, to time.Time) (dto.DashboardUsage, time.Time, error) {
	usage := dto.DashboardUsage{}
	if !to.After(from) {
		return usage, from, nil
	}
	segments := usageSegments(from, to, time.Now())
	rolled, err := s.repository.ListUsageRollup(ctx, bizLine, from.UTC().Truncate(time.Hour), to)
	if err != nil {
		return usage, from, err
	}
	// 标记行（类别与单位都是空串）说明这个小时算过了，哪怕它一条流水都没有。
	done := map[time.Time]bool{}
	byHour := map[time.Time][]*repository.GalaxyUsageRollup{}
	for _, row := range rolled {
		hour := row.StatHour.UTC()
		if row.Category == "" && row.Unit == "" {
			done[hour] = true
			continue
		}
		byHour[hour] = append(byHour[hour], row)
	}

	totals := map[usageKey]*usageCell{}
	rolledUntil := from
	for _, segment := range segments {
		if segment.whole {
			if done[segment.hour] {
				mergeUsage(totals, byHour[segment.hour])
				rolledUntil = segment.end
				continue
			}
			rows, err := s.rollHour(ctx, segment.hour)
			if err != nil {
				return usage, rolledUntil, err
			}
			mergeUsage(totals, rows)
			rolledUntil = segment.end
			continue
		}
		rows, err := s.computeUsage(ctx, segment.hour, segment.start, segment.end)
		if err != nil {
			return usage, rolledUntil, err
		}
		mergeUsage(totals, rows)
	}
	return buildUsage(totals), rolledUntil, nil
}

// usageSegment 一段要算的范围，以及它属于哪个小时桶。
type usageSegment struct {
	hour       time.Time
	start, end time.Time
	// whole 这一段正好铺满整个小时桶，而且那个桶已经封口 —— 只有这种段能落库。
	whole bool
}

// usageSegments 把 [from, to) 切成按整点对齐的段。
//
// 为什么要允许「不满一个小时的段」：一天的起点按服务端本地时区算，而桶按整点切。
// 绝大多数时区这两者是对齐的，但 +05:30 这种半小时时区不是 —— 那时一天的头尾
// 各会多出半个小时的零头。让它现算，比让整块数悄悄错半小时强。
func usageSegments(from, to, now time.Time) []usageSegment {
	closed := now.Add(-rollupGrace)
	var segments []usageSegment
	for cursor := from; cursor.Before(to); {
		hour := cursor.UTC().Truncate(time.Hour)
		next := hour.Add(time.Hour)
		end := next
		if end.After(to) {
			end = to
		}
		segments = append(segments, usageSegment{
			hour:  hour,
			start: cursor,
			end:   end,
			whole: !cursor.After(hour) && !end.Before(next) && !next.After(closed),
		})
		cursor = end
	}
	return segments
}

// usageKey 汇总的分组键：一类算力下的一个计量单位。
type usageKey struct {
	category string
	unit     string
}

type usageCell struct {
	amount         int64
	consumerAmount int64
	providerAmount int64
}

// rollHour 算一个小时桶并落库，返回算出来的行。
//
// 先删后插：上一次算出来有、这一次没有的那些格子（比如争议追回之后某个模型当小时
// 归零）不会自己消失，光靠覆盖写会把它们留成一份永远不再更新的旧账。
//
// 两步**不套事务**，因为不需要：删是一条语句，读的人要么看见删之前的整份、
// 要么看见删之后的空 —— 而看见空的那个人读不到标记行，于是把这个小时当成
// 「还没算过」自己现算一遍，拿到的数一样对，只是多算了一次。反过来，套上事务
// 就要多一次 SAVEPOINT 往返，换来的只是让那个人少算一次。
//
// 几个进程同时算同一个小时也是安全的：算出来的是同一份**绝对值**，按唯一键覆盖。
func (s *service) rollHour(ctx context.Context, hour time.Time) ([]*repository.GalaxyUsageRollup, error) {
	rows, err := s.computeUsage(ctx, hour, hour, hour.Add(time.Hour))
	if err != nil {
		return nil, err
	}
	now := time.Now()
	// 标记行：没有它就分不出「这个小时没有量」和「这个小时还没算过」，
	// 空闲时段会被每次读都重算一遍。
	stored := append([]*repository.GalaxyUsageRollup{{
		BizLine: bizLine, StatHour: hour, Category: "", Unit: "",
	}}, rows...)
	for _, row := range stored {
		row.RolledAt = now
	}
	if err := s.repository.DeleteUsageRollupHour(ctx, bizLine, hour); err != nil {
		return nil, err
	}
	return rows, s.repository.SaveUsageRollup(ctx, stored)
}

// computeUsage 从原始的三张表算一段范围的用量与金额。
//
// 计量流水给量、两本账给钱：钱不能由量乘单价倒推出来（计费是逐笔向下取整的，
// 倒推出来的数比真收的多一点点，而且随笔数增长）。类别由工单行上的模型推，
// 所以三条查询都要回工单表补一次模型。
func (s *service) computeUsage(ctx context.Context, hour, from, to time.Time) ([]*repository.GalaxyUsageRollup, error) {
	cells := map[usageKey]*usageCell{}
	meters, err := s.repository.SumMeterSlice(ctx, bizLine, from, to)
	if err != nil {
		return nil, err
	}
	for _, row := range meters {
		cellOf(cells, row).amount += row.Amount
	}
	consumer, err := s.repository.SumConsumerSettleSlice(ctx, bizLine, from, to)
	if err != nil {
		return nil, err
	}
	for _, row := range consumer {
		cellOf(cells, row).consumerAmount += row.Cost
	}
	provider, err := s.repository.SumProviderSettleSlice(ctx, bizLine, from, to)
	if err != nil {
		return nil, err
	}
	for _, row := range provider {
		cellOf(cells, row).providerAmount += row.Cost
	}

	rows := make([]*repository.GalaxyUsageRollup, 0, len(cells))
	for key, cell := range cells {
		rows = append(rows, &repository.GalaxyUsageRollup{
			BizLine: bizLine, StatHour: hour, Category: key.category, Unit: key.unit,
			Amount: cell.amount, ConsumerAmount: cell.consumerAmount, ProviderAmount: cell.providerAmount,
		})
	}
	// 排序只为让落库与调试时的行序稳定。
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Category != rows[j].Category {
			return rows[i].Category < rows[j].Category
		}
		return rows[i].Unit < rows[j].Unit
	})
	return rows, nil
}

func cellOf(cells map[usageKey]*usageCell, row repository.UsageSlice) *usageCell {
	key := usageKey{category: usageCategory(row.Model, row.Provider, row.Kind), unit: row.Unit}
	cell, ok := cells[key]
	if !ok {
		cell = &usageCell{}
		cells[key] = cell
	}
	return cell
}

func mergeUsage(totals map[usageKey]*usageCell, rows []*repository.GalaxyUsageRollup) {
	for _, row := range rows {
		if row.Category == "" && row.Unit == "" {
			continue // 标记行不是数据
		}
		key := usageKey{category: row.Category, unit: row.Unit}
		cell, ok := totals[key]
		if !ok {
			cell = &usageCell{}
			totals[key] = cell
		}
		cell.amount += row.Amount
		cell.consumerAmount += row.ConsumerAmount
		cell.providerAmount += row.ProviderAmount
	}
}

// usageCategory 这一笔算哪一类算力：claude / codex / video / other。
//
// 按模型推，因为 llm.chat 下面同时跑着 Claude 和 Codex，光看 kind 分不开。
// 工单行上没有模型时（非中转类能力、老数据）退回路由键 —— claude_oauth /
// codex_chatgpt 这种名字还认得出来。两样都说不清的归 other，不猜：
// 猜错会把一整类的量记到另一类头上，比记在「其它」里更难发现。
func usageCategory(model, provider, kind string) string {
	if strings.HasPrefix(kind, "video.") {
		return dto.UsageCategoryVideo
	}
	if strings.TrimSpace(model) != "" {
		family, _ := inferFamily(model)
		if category := familyCategory(family); category != "other" {
			return category
		}
	}
	switch key := strings.ToLower(strings.TrimSpace(provider)); {
	case key == "":
		return dto.UsageCategoryOther
	case strings.Contains(key, "claude"), strings.Contains(key, "anthropic"):
		return dto.UsageCategoryClaude
	case strings.Contains(key, "codex"), strings.Contains(key, "openai"), strings.Contains(key, "gpt"):
		return dto.UsageCategoryCodex
	}
	return dto.UsageCategoryOther
}

// buildUsage 把分组结果摊成界面要的形状。
func buildUsage(totals map[usageKey]*usageCell) dto.DashboardUsage {
	byCategory := map[string]*dto.DashboardUsageCategory{}
	// claude 与 codex 两格永远在：今天没跑是「0」，不是「这一栏消失了」。
	for _, category := range []string{dto.UsageCategoryClaude, dto.UsageCategoryCodex} {
		byCategory[category] = &dto.DashboardUsageCategory{Category: category, Units: []dto.DashboardUsageUnit{}}
	}
	for key, cell := range totals {
		group, ok := byCategory[key.category]
		if !ok {
			group = &dto.DashboardUsageCategory{Category: key.category, Units: []dto.DashboardUsageUnit{}}
			byCategory[key.category] = group
		}
		group.Units = append(group.Units, dto.DashboardUsageUnit{
			Unit: key.unit, Amount: cell.amount,
			ConsumerAmount: cell.consumerAmount, ProviderAmount: cell.providerAmount,
		})
	}

	usage := dto.DashboardUsage{Categories: make([]dto.DashboardUsageCategory, 0, len(byCategory))}
	total := dto.DashboardUsageCategory{Category: "", Units: []dto.DashboardUsageUnit{}}
	totalUnits := map[string]*dto.DashboardUsageUnit{}
	for _, group := range byCategory {
		sort.Slice(group.Units, func(i, j int) bool { return group.Units[i].Unit < group.Units[j].Unit })
		group.Tokens, group.Calls = tokensAndCalls(group.Units)
		for _, unit := range group.Units {
			group.ConsumerAmount += unit.ConsumerAmount
			group.ProviderAmount += unit.ProviderAmount
			row, ok := totalUnits[unit.Unit]
			if !ok {
				row = &dto.DashboardUsageUnit{Unit: unit.Unit}
				totalUnits[unit.Unit] = row
			}
			row.Amount += unit.Amount
			row.ConsumerAmount += unit.ConsumerAmount
			row.ProviderAmount += unit.ProviderAmount
		}
		group.Margin = group.ConsumerAmount - group.ProviderAmount
		usage.Categories = append(usage.Categories, *group)
	}
	sort.Slice(usage.Categories, func(i, j int) bool {
		return categoryOrder(usage.Categories[i].Category) < categoryOrder(usage.Categories[j].Category)
	})
	for _, row := range totalUnits {
		total.Units = append(total.Units, *row)
	}
	sort.Slice(total.Units, func(i, j int) bool { return total.Units[i].Unit < total.Units[j].Unit })
	total.Tokens, total.Calls = tokensAndCalls(total.Units)
	for _, unit := range total.Units {
		total.ConsumerAmount += unit.ConsumerAmount
		total.ProviderAmount += unit.ProviderAmount
	}
	total.Margin = total.ConsumerAmount - total.ProviderAmount
	usage.Total = total
	return usage
}

// tokensAndCalls 从分单位的明细里取出「多少 token」和「多少次调用」。
//
// token 数取 Hub 解析时算好的合计（llm.total_tokens = 输入 + 输出 + 缓存读 + 缓存写），
// 也就是共享者额度计数器盯着的那个数。没有合计行的退回四个桶自己相加 ——
// 但两者只取其一，不相加：合计本来就是那四个桶加出来的，一起算就是数两遍。
//
// 缓存写入的 5m / 1h 两个分项，以及推理 token，同样不进这个和：前者是
// 缓存写入的拆分，后者是输出的一部分。
func tokensAndCalls(units []dto.DashboardUsageUnit) (tokens, calls int64) {
	var buckets int64
	for _, unit := range units {
		switch unit.Unit {
		case contract.UnitTotalTokens:
			tokens = unit.Amount
		case contract.UnitInputTokens, contract.UnitOutputTokens,
			contract.UnitCacheReadTokens, contract.UnitCacheWriteTokens:
			buckets += unit.Amount
		case contract.UnitCalls:
			calls = unit.Amount
		}
	}
	if tokens == 0 {
		tokens = buckets
	}
	return tokens, calls
}

func categoryOrder(category string) int {
	switch category {
	case dto.UsageCategoryClaude:
		return 0
	case dto.UsageCategoryCodex:
		return 1
	case dto.UsageCategoryVideo:
		return 2
	default:
		return 3
	}
}

// rollupUsage 把已经封口、还没算过的小时桶补上。巡检每轮调一次。
//
// 仪表盘自己也会补（usageRange），所以这件事不是必须的 —— 它只是让补算发生在
// 后台，而不是发生在「运营点开仪表盘」那一刻：不然每天第一次打开要现算一整天。
//
// 往回只补 rollupBackfillHours 个小时，而且一轮补不完不要紧：没补上的桶会在
// 仪表盘读到它的时候被现算一次并落库，两条路写的是同一张表、同一份数。
func (s *service) rollupUsage(ctx context.Context, now time.Time) error {
	closed := now.Add(-rollupGrace).UTC().Truncate(time.Hour)
	first := closed.Add(-rollupBackfillHours * time.Hour)
	hours, err := s.repository.ListRolledHours(ctx, bizLine, first, closed.Add(time.Hour))
	if err != nil {
		return err
	}
	done := map[time.Time]bool{}
	for _, hour := range hours {
		done[hour.UTC()] = true
	}
	rolled := 0
	for hour := first; !hour.After(closed); hour = hour.Add(time.Hour) {
		if done[hour] {
			continue
		}
		if rolled >= rollupPerRunHours {
			return nil
		}
		if _, err := s.rollHour(ctx, hour); err != nil {
			return err
		}
		rolled++
	}
	return nil
}
