package galaxy

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 价目表的运营入口。
//
// 计费整条链路是通的，唯独**价目表可以是空的** —— 没有价可查时 Usage 把 Cost 留成 0，
// 不报错也不告警，账单和分成于是永远是 0。这个故障只能从「钱一直对不上」反推，
// 而在此之前，唯一的填表方式是 SeedPrices（初始化命令里写死的默认价）或者手工 INSERT。
//
// 所以这一页要做的不只是「能改价」，还要把「哪些单位正在产生用量却没有价」直接列出来。

// unpricedWindowDays 往回看几天的用量来判断「有量无价」。
const unpricedWindowDays = 30

// AdminPrices 整张价目表，含还没生效的和已经被覆盖的历史价。
func (s *service) AdminPrices(ctx context.Context) (dto.PriceTableView, error) {
	rows, err := s.repository.ListAllPrices(ctx, bizLine)
	if err != nil {
		return dto.PriceTableView{}, err
	}
	now := time.Now()
	prices, priced := markLivePrices(rows, now)
	view := dto.PriceTableView{Prices: prices}

	usage, err := s.repository.SumUsage(ctx, repository.UnitQuery{
		BizLine: bizLine, From: now.AddDate(0, 0, -unpricedWindowDays), To: now,
	})
	if err != nil {
		return dto.PriceTableView{}, err
	}
	view.Unpriced = unpricedFrom(usage, priced)

	// 候选值给界面用：运营不该去背 "llm.input_tokens" 这种字符串 —— 拼错一个字母
	// 的后果不是报错，是这行价永远匹配不上任何用量，而账单只会安静地少算一笔。
	//
	// 候选来自**数据本身**（已有的价 + 真实跑过的用量），不是能力注册表：
	// manager-api 装配 galaxy 服务时不传注册表（那是派单侧的东西），
	// 靠它取候选在管理端永远是空的。
	kinds, units := map[string]bool{}, map[string]bool{}
	for _, row := range rows {
		kinds[row.Kind], units[row.Unit] = true, true
	}
	for _, row := range usage {
		kinds[row.Kind], units[row.Unit] = true, true
	}
	for _, unit := range knownMeterUnits {
		units[unit] = true
	}
	for _, spec := range s.kinds.List() {
		kinds[spec.Kind] = true
		for _, unit := range spec.Metering.Units {
			units[unit] = true
		}
	}
	view.Kinds, view.Units = sortedKeys(kinds), sortedKeys(units)
	return view, nil
}

// markLivePrices 标出每个 (kind, unit) 此刻生效的那一行，并回一张「已定价」的集合。
//
// 生效的定义只有一条：effective_from 已经到点、且是同组里最新的那个到点时刻。
// 行按 kind, unit, effective_from desc 取回来，所以每组第一条到点的就是它 ——
// 排在它前面的是还没到点的未来价，后面的是被它取代的历史价，两者都不是当前价。
func markLivePrices(rows []*repository.GalaxyPrice, now time.Time) ([]dto.PriceView, map[string]bool) {
	priced := map[string]bool{}
	views := make([]dto.PriceView, 0, len(rows))
	for _, row := range rows {
		key := priceKey(row.Kind, row.Unit)
		live := false
		if !row.EffectiveFrom.After(now) && !priced[key] {
			priced[key] = true
			live = true
		}
		views = append(views, dto.PriceView{
			Kind: row.Kind, Unit: row.Unit, Price: row.Price, Currency: row.Currency,
			ProviderShare: row.ProviderShare, EffectiveFrom: row.EffectiveFrom, Effective: live,
		})
	}
	return views, priced
}

// unpricedFrom 有用量、却查不到价的 (kind, unit)。
//
// **不做「这个单位本来就不计价」的猜测** —— 次数与时长默认不计价，但那是一个决定，
// 不是一条事实。运营给它填一行 0 元，它就从这张告警里消失，于是「0 是有意的」
// 和「忘了填」在库里终于区分得开。
func unpricedFrom(usage []repository.UsageRow, priced map[string]bool) []dto.PriceView {
	seen := map[string]bool{}
	out := make([]dto.PriceView, 0)
	for _, row := range usage {
		key := priceKey(row.Kind, row.Unit)
		if priced[key] || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, dto.PriceView{Kind: row.Kind, Unit: row.Unit, Currency: "CNY"})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Kind != out[j].Kind {
			return out[i].Kind < out[j].Kind
		}
		return out[i].Unit < out[j].Unit
	})
	return out
}

// priceKey (kind, unit) 拼成一个键。用 \x00 分隔而不是冒号：单位名里带冒号的那天，
// 冒号分隔会让两个不同的组撞成一个。
func priceKey(kind, unit string) string { return kind + "\x00" + unit }

// knownMeterUnits contract 里登记过的计量单位。单位是注册制的，这份只是候选提示，
// 不是白名单 —— 新业务自带的单位照样能在界面上手填。
//
// llm.total_tokens 刻意不在这里：它是四个 token 桶的合计，给它定价就是把每一笔
// 都收两遍。但正因为这份清单不是白名单，真正的闸在 billing.go 的 derivedUnits。
var knownMeterUnits = []contract.MeterUnit{
	contract.UnitInputTokens, contract.UnitOutputTokens,
	contract.UnitCacheReadTokens, contract.UnitCacheWriteTokens, contract.UnitCalls,
	contract.UnitTimeSeconds,
	contract.UnitVideoOutputSeconds, contract.UnitVideoInputSeconds, contract.UnitVideoFrames,
	contract.UnitGPUSeconds, contract.UnitCPUSeconds,
	contract.UnitStorageBytes, contract.UnitEgressBytes,
}

func sortedKeys(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for key := range set {
		if key != "" {
			out = append(out, key)
		}
	}
	sort.Strings(out)
	return out
}

// SaveAdminPrice 新增或改一行价目。
//
// EffectiveFrom 不填就是「现在起生效」。它在唯一键里 —— 换一个时刻就是新增一行、
// 旧行留作历史，而不是把已经结过的账追溯改掉。
func (s *service) SaveAdminPrice(ctx context.Context, req dto.SavePriceRequest) error {
	kind := strings.TrimSpace(req.Kind)
	unit := strings.TrimSpace(req.Unit)
	if kind == "" || unit == "" {
		return errors.New("能力与计量单位都要填")
	}
	if req.Price < 0 {
		return errors.New("单价不能是负数")
	}
	if req.ProviderShare < 0 || req.ProviderShare > 1 {
		return fmt.Errorf("分成比例要在 0 到 1 之间，收到 %v", req.ProviderShare)
	}
	effective := time.Now().Truncate(time.Second)
	if req.EffectiveFrom != nil && !req.EffectiveFrom.IsZero() {
		effective = req.EffectiveFrom.Truncate(time.Second)
	}
	return s.repository.SavePrice(ctx, &repository.GalaxyPrice{
		BizLine: bizLine, Kind: kind, Unit: unit, EffectiveFrom: effective,
		Price: req.Price, Currency: defaultString(strings.TrimSpace(req.Currency), "CNY"),
		ProviderShare: req.ProviderShare,
	})
}

// DeleteAdminPrice 删一行价目。删的是历史，或者排错了的未来价 ——
// 把正在生效的那行删掉，这个单位会立刻退回「查不到价」，所以界面上要拦一道。
func (s *service) DeleteAdminPrice(ctx context.Context, req dto.DeletePriceRequest) error {
	kind := strings.TrimSpace(req.Kind)
	unit := strings.TrimSpace(req.Unit)
	if kind == "" || unit == "" {
		return errors.New("能力与计量单位都要填")
	}
	return s.repository.DeletePrice(ctx, bizLine, kind, unit, req.EffectiveFrom.Truncate(time.Second))
}
