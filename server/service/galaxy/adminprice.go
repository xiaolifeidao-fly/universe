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

	// 模型候选：目录里的（含已下架的 —— 下架只是不卖了，已经跑出来的用量还要按它计价）
	// 加上价目表里已经出现过的。查目录失败不拦整页：候选没了运营还能手填，
	// 而为了一个下拉把价目表整页打不开，是更坏的结果。
	models := map[string]bool{}
	for _, row := range rows {
		models[row.ModelID] = true
	}
	if catalog, err := s.repository.ListModels(ctx, bizLine, false); err == nil {
		for _, row := range catalog {
			models[row.ModelID] = true
		}
	}
	view.Models = sortedKeys(models)
	// 强度候选按族给。这份**完全来自 contract 的词表**，不掺库里出现过的值：
	// 词表就是「上游真的有这一档」的唯一出处，而库里可能躺着历史上填错的档位名，
	// 把它回填进候选等于把一个错误变成往后所有人的选项。
	view.Efforts = map[string][]string{
		contract.FamilyAnthropic: contract.FamilyEfforts(contract.FamilyAnthropic),
		contract.FamilyOpenAI:    contract.FamilyEfforts(contract.FamilyOpenAI),
	}
	return view, nil
}

// markLivePrices 标出每个 (kind, model, effort, unit) 此刻生效的那一行，并回一张「已定价」的集合。
//
// 生效的定义只有一条：effective_from 已经到点、且是同组里最新的那个到点时刻。
// 行按 kind, model_id, unit, effective_from desc 取回来，所以每组第一条到点的就是它 ——
// 排在它前面的是还没到点的未来价，后面的是被它取代的历史价，两者都不是当前价。
//
// 「已定价」那张集合只收**兜底行**（model_id 与 effort 都为空）：模型或强度单独定的价
// 只覆盖自己那一格，有它不等于别的模型、别的档有价可查。拿它去消掉「有量无价」的告警，
// 等于替其余组合宣布了一件没发生的事。
func markLivePrices(rows []*repository.GalaxyPrice, now time.Time) ([]dto.PriceView, map[string]bool) {
	priced := map[string]bool{}
	seen := map[string]bool{}
	views := make([]dto.PriceView, 0, len(rows))
	for _, row := range rows {
		key := priceKey(row.Kind, row.ModelID, row.Effort, row.Unit)
		live := false
		if !row.EffectiveFrom.After(now) && !seen[key] {
			seen[key] = true
			live = true
			if row.ModelID == "" && row.Effort == "" {
				priced[priceKey(row.Kind, "", "", row.Unit)] = true
			}
		}
		settle := settleUnitPrice(priceRow{
			Price: row.Price, ProviderPrice: row.ProviderPrice, ProviderShare: row.ProviderShare,
		})
		views = append(views, dto.PriceView{
			Kind: row.Kind, ModelID: row.ModelID, Effort: row.Effort, Unit: row.Unit,
			Price: row.Price, Currency: row.Currency,
			ProviderPrice: row.ProviderPrice, SettlePrice: settle,
			MarginBps:     marginBps(row.Price, settle),
			ProviderShare: row.ProviderShare, EffectiveFrom: row.EffectiveFrom, Effective: live,
		})
	}
	return views, priced
}

// marginBps 平台毛利率，万分之一。负数就是结算价高过对外价 —— 平台在倒贴。
//
// 它是算出来的，不入库：入库就会有「价改了、毛利率没跟着改」的那一天，
// 而那种不一致没有任何地方会报错。
func marginBps(price, settle int64) int {
	if price <= 0 {
		return 0
	}
	return int((price - settle) * 10000 / price)
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
		// 合计口径不进这张告警。它们**永远不会计费**（record 里 derivedUnits 那道闸
		// 直接 continue），所以「有量无价」对它们不成立 —— 量是真的，价则是一件
		// 不该发生的事。摆进来的后果是运营照着提示去给合计定一个价，填完发现
		// 账单一分没变，而没有任何地方解释为什么。
		if derivedUnits[row.Unit] {
			continue
		}
		// 只按 kind 查兜底价：这张告警回答的是「有没有一行价兜得住这个单位」，
		// 而兜得住它的只可能是兜底行。用量行本身也不带模型（SumUsage 会按模型分组，
		// 但这里只关心单位有没有价，同一单位的多个模型行去重成一条）。
		key := priceKey(row.Kind, "", "", row.Unit)
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

// priceKey (kind, model, effort, unit) 拼成一个键。用 \x00 分隔而不是冒号：单位名里带冒号的那天，
// 冒号分隔会让两个不同的组撞成一个。
func priceKey(kind, model, effort, unit string) string {
	return kind + "\x00" + model + "\x00" + effort + "\x00" + unit
}

// knownMeterUnits contract 里登记过的计量单位。单位是注册制的，这份只是候选提示，
// 不是白名单 —— 新业务自带的单位照样能在界面上手填。
//
// llm.total_tokens 与 llm.cache_write_tokens 刻意不在这里：前者是四个 token 桶的合计，
// 后者是缓存写入两个 TTL 桶的合计，给合计定价就是把每一笔都收两遍。真正进账本的是
// 5m / 1h 那两个分项，所以候选里给的是它们。这份清单不是白名单（运营照样能手填），
// 真正的闸在 billing.go 的 derivedUnits —— 但候选摆错会直接把人引到那个坑里。
var knownMeterUnits = []contract.MeterUnit{
	contract.UnitInputTokens, contract.UnitOutputTokens,
	contract.UnitCacheReadTokens,
	contract.UnitCacheWrite5mTokens, contract.UnitCacheWrite1hTokens,
	contract.UnitCalls,
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
	// 模型不校验「目录里有没有」：目录是门户的展示清单，计价表是账。
	// 一个模型可以先接进来跑、后补目录，也可以从目录里下架而老账还要按它算。
	modelID := strings.TrimSpace(req.ModelID)
	// 强度反过来**要校验**，而且是这一页上唯一一个硬校验。
	//
	// 理由和模型那一条正相反：模型名是运营和上游共同认识的字符串，填错了很快会有人
	// 反馈「这个模型没按我定的价收」；而强度档位是一个封闭小词表，填成 "High"、"max "、
	// "medium-high" 这类值不会报错、不会匹配上任何一次请求，这行价就永远躺在表里 ——
	// 运营以为自己给 max 档加过价，账上却一直按不分强度价在收。
	effort := strings.ToLower(strings.TrimSpace(req.Effort))
	if effort != "" && !knownEffort(effort) {
		return fmt.Errorf("推理强度 %q 不是上游认识的档位；Claude 是 %s，Codex 是 %s",
			req.Effort,
			strings.Join(contract.FamilyEfforts(contract.FamilyAnthropic), " / "),
			strings.Join(contract.FamilyEfforts(contract.FamilyOpenAI), " / "))
	}
	if req.Price < 0 {
		return errors.New("对外单价不能是负数")
	}
	if req.ProviderPrice < 0 {
		return errors.New("结算单价不能是负数")
	}
	if req.ProviderShare < 0 || req.ProviderShare > 1 {
		return fmt.Errorf("分成比例要在 0 到 1 之间，收到 %v", req.ProviderShare)
	}
	// 结算价高过对外价是平台倒贴。**不拦** —— 拉新期定向补贴某个单位是真实需求，
	// 而这里拦下来，运营就只能回去写 SQL。界面上会标红，账上会记一笔负的 fee。
	effective := time.Now().Truncate(time.Second)
	if req.EffectiveFrom != nil && !req.EffectiveFrom.IsZero() {
		effective = req.EffectiveFrom.Truncate(time.Second)
	}
	return s.repository.SavePrice(ctx, &repository.GalaxyPrice{
		BizLine: bizLine, Kind: kind, ModelID: modelID, Effort: effort, Unit: unit, EffectiveFrom: effective,
		Price: req.Price, Currency: defaultString(strings.TrimSpace(req.Currency), "CNY"),
		ProviderPrice: req.ProviderPrice, ProviderShare: req.ProviderShare,
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
	return s.repository.DeletePrice(ctx, bizLine, kind,
		strings.TrimSpace(req.ModelID), strings.ToLower(strings.TrimSpace(req.Effort)),
		unit, req.EffectiveFrom.Truncate(time.Second))
}

// knownEffort 这个档位名在任意一族里存在。
//
// 不按族查是有意的：价目行上没有族这一列，也不该有 —— 族是模型的属性，
// 而一行价可以是跨模型的兜底行。只要它是某个上游真的会发过来的档位名就收，
// 至于「Claude 模型配了个 minimal 档」这种搭配错误，表现是那行价匹配不上任何用量，
// 和填了一个从没上架过的模型名一样，属于运营自己看得见的错。
func knownEffort(effort string) bool {
	for _, family := range []string{contract.FamilyAnthropic, contract.FamilyOpenAI} {
		if contract.NormalizeEffort(family, effort) != "" {
			return true
		}
	}
	return false
}
