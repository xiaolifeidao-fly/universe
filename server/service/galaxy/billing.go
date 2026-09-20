package galaxy

import (
	"context"
	"fmt"
	"log"
	"sort"
	"time"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 计量与结算（设计文档第 6 节）。双账本可对平：
// 消费侧（消费 / 退款）、供给侧积分、平台抽成与坏账各记各的。
//
// 消费侧有两层，粒度不同，缺一不可：
//   - zt_galaxy_consumer_ledger：一次请求一个计量单位一行，记「用了多少、什么单价」。
//     账单、用量页、争议追回都读它。
//   - zt_galaxy_points_ledger：一次请求一行，记「从余额里扣了多少积分」。
//     它才是钱，余额的每一次变动都对着这里的一行。

// priceScale 定价按「每百万单位」表示，避免 token 这种大基数上的浮点误差。
const priceScale = 1_000_000

// legacyProviderShare 老口径的默认分成。只在一行的结算单价是 0 时兜底，
// 让「忘了填结算价」退化成「按七成发」而不是「一分不发」。
const legacyProviderShare = 0.7

// derivedUnits 是从别的单位算出来的合计，只进计量与额度，永远不进账本。
//
// 它们的量已经被分项收过一次了，再乘一次单价就是把每一笔都收两遍。运营能在
// 定价页手填任意单位（那张表是候选提示不是白名单），所以这道闸设在这里，
// 而不是指望没人给合计填价。
var derivedUnits = map[contract.MeterUnit]bool{
	contract.UnitTotalTokens: true,
	// 缓存写入的合计：量已经被 5m / 1h 两个分项各自收过了。
	// 它和 UnitTotalTokens 的区别只在于「合计谁」，进账本会重复收这一点是一样的。
	contract.UnitCacheWriteTokens: true,
	// 推理 token 是 output 的子集，同理：output 已经整笔收过。
	contract.UnitReasoningTokens: true,
}

// record 写计量流水与三本账。幂等键是 rid + attempt + unit，重放不会记两遍。
func (s *service) record(ctx context.Context, runtime UnitRuntime, spec contract.KindSpec, actual contract.Metering, billable bool) error {
	if len(actual) == 0 {
		return nil
	}
	prices, err := s.priceTable(ctx, runtime.Kind, runtime.Model, time.Now())
	if err != nil {
		return err
	}
	// 贡献先查出来：供给侧的每一行都要写上 owner（按人回查账本时不用再绕一圈 cid），
	// 入账也要它。查不到就只记流水、不入账 —— 那是数据不一致，
	// 不该顺手把钱发给一个不知道是谁的人。
	owner := ""
	contribution, err := s.repository.FindContribution(ctx, bizLine, runtime.CID)
	if err == nil {
		owner = contribution.OwnerUserID
	}

	meters := make([]*repository.GalaxyMeterRecord, 0, len(actual))
	consumer := make([]*repository.GalaxyConsumerLedger, 0, len(actual))
	provider := make([]*repository.GalaxyProviderLedger, 0, len(actual))
	var platformFee, charge int64

	for _, unit := range actual.Units() {
		amount := actual[unit]
		if amount <= 0 {
			continue
		}
		source := contract.MeterSourceNode
		if spec.TrustsUnit(unit) {
			source = contract.MeterSourceHub
		}
		meters = append(meters, &repository.GalaxyMeterRecord{
			BizLine: bizLine, UnitID: runtime.RID, Attempt: runtime.Attempt, Unit: unit,
			CID: runtime.CID, ConsumerKey: runtime.ConsumerKey, Kind: runtime.Kind,
			Amount: amount, Source: string(source),
		})
		if !billable {
			continue
		}
		if derivedUnits[unit] {
			// 合计到此为止：上面的 meter_record 照写（额度与对账要它），账本不碰。
			continue
		}
		price, ok := prices[unit]
		if !ok || (price.Price <= 0 && price.ProviderPrice <= 0) {
			// 未定价的单位只作供给侧额度与统计，不进账本（D-03：calls 与 time 不计价）。
			//
			// 两个价都要看：上下游各自定价之后，「对外免费、照付共享者」是一个
			// 合法的运营选择（拉新期的补贴），只看下游价会把这种行整行跳过。
			continue
		}
		cost, share := splitCost(amount, price)
		if cost <= 0 && share <= 0 {
			continue
		}
		txn := fmt.Sprintf("%s:%d:%s", runtime.RID, runtime.Attempt, unit)
		// 消费侧这一行记的是**用量**：哪个单位用了多少、按什么单价算。
		// 钱从哪儿扣是另一回事（见下面的 chargeUsage）—— 余额在账户上，
		// 一次请求只扣一笔总额，而账单要能拆回「输入多少、输出多少」。
		if cost > 0 {
			consumer = append(consumer, &repository.GalaxyConsumerLedger{
				BizLine: bizLine, TxnID: txn, KeyID: runtime.ConsumerKey, Type: "settle",
				Unit: unit, Amount: amount, Price: price.Price, UnitID: runtime.RID,
			})
			charge += cost
		}
		// 差额进平台账。它现在可以是负的 —— 结算单价高过对外单价就是平台在倒贴，
		// 那笔钱确实出去了，不记下来三本账就对不平。
		platformFee += cost - share
		if share <= 0 {
			continue
		}
		// 供给侧记的是**积分**，和信用账户余额同一量纲。
		//
		// 这里原先记的是计量数（token 数），于是收益页上「今天赚了多少」加的是 token、
		// 「可提现」用的是余额里的钱，两个口径根本不是一个东西。原始计量数在
		// zt_galaxy_meter_record 里（对账以它为准），这一行只回答「这笔挣了多少」；
		// 是哪种计量单位挣来的写在 Unit 上。
		provider = append(provider, &repository.GalaxyProviderLedger{
			BizLine: bizLine, TxnID: txn, CID: runtime.CID, OwnerUserID: owner, Type: ledgerSettle,
			Unit: unit, Amount: share, Price: settleUnitPrice(price), UnitID: runtime.RID,
		})
	}

	if err := s.repository.SaveMeterRecords(ctx, meters); err != nil {
		return err
	}
	// 用量流水一行一行地写。按 (biz_line, txn_id) 幂等，重放不会多记一笔。
	for _, row := range consumer {
		if _, err := s.repository.SaveConsumerLedgerRow(ctx, row); err != nil {
			return err
		}
	}
	// 扣钱只有一笔，幂等键是 (请求, 第几次尝试)。
	//
	// 不跟着上面那个循环一行一行扣：那样一次请求会在余额上留下四五笔，
	// 人翻流水时看到的是「输入扣了 3 微、输出扣了 88 微、缓存读扣了 1 微」，
	// 而他想知道的是「刚才那次对话花了多少」。拆开的口径在 consumer_ledger 里，
	// 那才是账单该去的地方。
	s.chargeUsage(ctx, runtime, charge)
	var providerCredit int64
	for _, row := range provider {
		inserted, err := s.repository.SaveProviderLedgerRow(ctx, row)
		if err != nil {
			return err
		}
		if inserted {
			providerCredit += row.Amount
		}
	}
	if platformFee != 0 {
		if err := s.repository.SavePlatformLedger(ctx, []*repository.GalaxyPlatformLedger{{
			BizLine: bizLine, TxnID: fmt.Sprintf("%s:%d:fee", runtime.RID, runtime.Attempt),
			Type: "fee", Amount: platformFee, UnitID: runtime.RID,
		}}); err != nil {
			return err
		}
	}
	if providerCredit > 0 && owner != "" {
		_ = s.repository.AddCredit(ctx, bizLine, owner, providerCredit)
		// 邀请奖励：这笔收益的主人是被谁邀请来的，就额外给那个人记一笔。
		// 钱是平台出的，上面这笔一分不少 —— 顺序也说明了这一点：先有收益，才谈得上奖励。
		s.rewardProviderReferrer(ctx, runtime, contribution, providerCredit)
	}
	return nil
}

// chargeUsage 把这一次请求的花费从主人的积分余额里扣掉，并记一行消费流水。
//
// 允许扣成负数。一次请求要花多少，只有等它跑完、数清 token 才知道 ——
// 放行的时候（AuthenticateKey 的 requireBalance）余额还是正的，跑完发现不够，
// 那也是已经烧掉的算力。拒绝扣款会让这笔钱凭空消失在账上，
// 而余额停在一个假的正数上，下一次照样放行，窟窿越滚越大。
// 扣成负数则是：这一次照实记，下一次在闸门那里被挡住。
//
// 失败只记日志、不阻断收尾：单元的终态、计量流水、供给侧入账都已经落了，
// 为了一行扣款把整条结算路径退回去，换来的是一个跑完了却没有终态的请求。
// 幂等键是 (请求, 第几次尝试)，漏掉的照日志补得回来。
func (s *service) chargeUsage(ctx context.Context, runtime UnitRuntime, cost int64) {
	if cost <= 0 {
		return
	}
	key, err := s.repository.FindConsumerKey(ctx, bizLine, runtime.ConsumerKey)
	if err != nil || key.OwnerUserID == "" {
		log.Printf("galaxy 扣费找不到密钥主人 unit=%s key=%s: %v", runtime.RID, runtime.ConsumerKey, err)
		return
	}
	_, err = s.applyPoints(ctx, &repository.GalaxyPointsLedger{
		BizLine: bizLine, TxnID: fmt.Sprintf("usage:%s:%d", runtime.RID, runtime.Attempt),
		OwnerUserID: key.OwnerUserID, Type: dto.PointsUsage, Amount: -cost, BaseAmount: cost,
		UnitID: runtime.RID, Kind: runtime.Kind, ModelID: runtime.Model,
	}, true, nil)
	if err != nil {
		log.Printf("galaxy 扣费失败 unit=%s owner=%s cost=%d: %v", runtime.RID, key.OwnerUserID, cost, err)
	}
}

// splitCost 把一笔用量折成两笔钱：向使用者收的，和付给共享者的。
//
// 两个价各乘各的 —— 上游不再是下游的一个百分比。这是有意的：调下游价不该自动
// 改掉所有共享者的收入，共享者也不该能拿自己的流水除一除就反推出平台抽了几成。
// ProviderPrice 为 0 的是还没迁移的存量行，回落到老口径（下游金额 × ProviderShare），
// 迁移脚本跑完就不会再走到那条路。
//
// 收钱和退钱必须用同一个算式：两处各写一遍的话，只要取整方式差一点，
// 退给消费者的和从提供者那儿追回的就对不上，坏账会悄悄堆在平台账上。
// 所以这里是唯一的出处，record 与争议追回都从这里拿。
func splitCost(amount int64, price priceRow) (cost, providerShare int64) {
	cost = amount * price.Price / priceScale
	if price.ProviderPrice > 0 {
		return cost, amount * price.ProviderPrice / priceScale
	}
	if cost <= 0 {
		return cost, 0
	}
	return cost, int64(float64(cost) * price.ProviderShare)
}

// settleUnitPrice 这一行实际按哪个单价结给共享者。
//
// 供给侧账本记的是它，不是对外单价 —— 那一列原先抄的是下游价，等于把
// 「平台收了多少」直接写在共享者自己查得到的流水上。
func settleUnitPrice(price priceRow) int64 {
	if price.ProviderPrice > 0 {
		return price.ProviderPrice
	}
	return int64(float64(price.Price) * price.ProviderShare)
}

type priceRow struct {
	Price         int64
	Currency      string
	ProviderPrice int64
	ProviderShare float64
}

// priceTable 取某个 kind + 模型当前生效的单价。
//
// 回落是**按单位**的，不是按行的：模型只给 output 单独定了价，input 仍然走该 kind
// 的兜底价。按行回落（「这个模型有价就整张表用它的」）会让只填了一档的模型
// 把其余几档静默归零 —— 而归零不报错，只是账单少算一笔。
//
// 同一 (kind, model, unit) 取 effective_from 最新的那条。
func (s *service) priceTable(ctx context.Context, kind, model string, at time.Time) (map[contract.MeterUnit]priceRow, error) {
	// 带上 kind：这是每笔计费都走的路径，不收窄就是每次全表扫一遍。
	rows, err := s.repository.ListEffectivePrices(ctx, bizLine, kind, at)
	if err != nil {
		return nil, err
	}
	table, _ := resolvePrices(rows, kind, model)
	return table, nil
}

// resolvePrices 是 priceTable 去掉取数之后剩下的那一半。
//
// 拆出来是因为门户要一次给几十个模型各算一张表：让每个模型自己去查一遍，
// 就是把同一批行查几十遍。拆开之后取一次数、在内存里挑几十回，
// 顺带这段逻辑也能直接拿数据验。
//
// 第二个返回值说的是每个单位的价「是不是这个模型自己的」。计价不关心它，
// 门户关心：回落到 kind 的兜底价时卡片要标「统一价」，而回落到这个模型
// 自己的计价行时标的就是它真会被收的价，两者不能都说成统一价。
func resolvePrices(rows []*repository.GalaxyPrice, kind, model string) (map[contract.MeterUnit]priceRow, map[contract.MeterUnit]bool) {
	out := map[contract.MeterUnit]priceRow{}      // 先装兜底价
	specific := map[contract.MeterUnit]priceRow{} // 再装这个模型自己的价
	for _, row := range rows {
		if row.Kind != kind {
			continue
		}
		// 别的模型的价与本次无关。model 为空（单元行没了 / 不按模型区分的 kind）时
		// 这一条会把所有模型行都滤掉，只剩兜底 —— 正是想要的。
		if row.ModelID != "" && row.ModelID != model {
			continue
		}
		target := out
		if row.ModelID != "" {
			target = specific
		}
		// 行按 effective_from **升序**回来（见 ListEffectivePrices：升序才走得上索引），
		// 所以是后来的盖掉先来的，同组最后落下的那条就是最新生效的。
		target[row.Unit] = priceRow{
			Price: row.Price, Currency: row.Currency,
			ProviderPrice: row.ProviderPrice, ProviderShare: row.ProviderShare,
		}
	}
	own := make(map[contract.MeterUnit]bool, len(specific))
	for unit, row := range specific {
		out[unit] = row
		own[unit] = true
	}
	return out, own
}

// Usage 用量与扣费明细。input 与 output token 分行列出、按各自单价计算（验收标准）。
func (s *service) Usage(ctx context.Context, query dto.UsageQuery) (dto.UsageReport, error) {
	now := time.Now()
	if query.To.IsZero() {
		query.To = now
	}
	if query.From.IsZero() {
		query.From = query.To.AddDate(0, 0, -30)
	}
	rows, err := s.repository.SumUsage(ctx, repository.UnitQuery{
		BizLine: bizLine, ConsumerKey: query.ConsumerKey, ConsumerKeys: query.ConsumerKeys,
		CID: query.CID, Kind: query.Kind, From: query.From, To: query.To,
	})
	if err != nil {
		return dto.UsageReport{}, err
	}
	report := dto.UsageReport{From: query.From, To: query.To, Currency: "CNY"}
	// 按 kind **和模型**缓存取价表：计价已经按模型走了，这里还按 kind 合并的话，
	// 账单上那个 Cost 会拿兜底价去乘一笔其实按模型价收过的量。
	tables := map[string]map[contract.MeterUnit]priceRow{}
	for _, row := range rows {
		cacheKey := row.Kind + "\x00" + row.Model
		table, ok := tables[cacheKey]
		if !ok {
			table, err = s.priceTable(ctx, row.Kind, row.Model, now)
			if err != nil {
				return dto.UsageReport{}, err
			}
			tables[cacheKey] = table
		}
		line := dto.UsageLine{
			Kind: row.Kind, Provider: row.Provider, Model: row.Model,
			Unit: row.Unit, Amount: row.Amount, Calls: row.Calls,
		}
		if price, ok := table[row.Unit]; ok {
			line.UnitPrice = price.Price
			line.Cost = row.Amount * price.Price / priceScale
			report.Currency = defaultString(price.Currency, report.Currency)
		}
		report.TotalFee += line.Cost
		report.Lines = append(report.Lines, line)
	}
	sort.Slice(report.Lines, func(i, j int) bool {
		left, right := report.Lines[i], report.Lines[j]
		if left.Kind != right.Kind {
			return left.Kind < right.Kind
		}
		if left.Provider != right.Provider {
			return left.Provider < right.Provider
		}
		if left.Model != right.Model {
			return left.Model < right.Model
		}
		return left.Unit < right.Unit
	})
	return report, nil
}

// SeedPrices 写入中转站的默认定价（D-02 / D-03）：token 分单位定价，
// calls 与 time.seconds 不计价，只作供给侧额度与统计。装配层在初始化时调用一次。
//
// 两张价一起播：prices 是对外收的，providerPrices 是结算给共享者的。
// 分开传而不是传一个分成比例 —— 默认值也该长成「两个独立的数」的样子，
// 否则第一批种子行一落库就又把上游价钉成了下游价的函数。
// providerPrices 里没有的单位按 0 播，那一行的结算价要运营自己去价目表上填。
//
// 播的是**兜底价**（model_id 留空）：默认值不该替运营决定「哪个模型贵哪个便宜」，
// 但必须保证每个单位都至少有一行可查 —— 查不到价是静默算 0，不是报错。
func (s *service) SeedPrices(ctx context.Context, kind string, prices, providerPrices map[contract.MeterUnit]int64) error {
	effective := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, unit := range contract.Metering(prices).Units() {
		if err := s.repository.SavePrice(ctx, &repository.GalaxyPrice{
			BizLine: bizLine, Kind: kind, Unit: unit, EffectiveFrom: effective,
			Price: prices[unit], Currency: "CNY", ProviderPrice: providerPrices[unit],
			// 老比例留着只为了「结算价忘了填」时不至于一分不发。它不是种子的口径。
			ProviderShare: legacyProviderShare,
		}); err != nil {
			return err
		}
	}
	return nil
}
