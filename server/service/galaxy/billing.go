package galaxy

import (
	"context"
	"fmt"
	"sort"
	"time"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 计量与结算（设计文档第 6 节）。双账本可对平：
// 消费侧（购买 / 消费 / 退款）、供给侧积分、平台抽成与坏账各记各的。

// priceScale 定价按「每百万单位」表示，避免 token 这种大基数上的浮点误差。
const priceScale = 1_000_000

// record 写计量流水与三本账。幂等键是 rid + attempt + unit，重放不会记两遍。
func (s *service) record(ctx context.Context, runtime UnitRuntime, spec contract.KindSpec, actual contract.Metering, billable bool) error {
	if len(actual) == 0 {
		return nil
	}
	prices, err := s.priceTable(ctx, runtime.Kind, time.Now())
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
	var platformFee int64

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
		price, ok := prices[unit]
		if !ok || price.Price <= 0 {
			// 未定价的单位只作供给侧额度与统计，不进账本（D-03：calls 与 time 不计价）。
			continue
		}
		cost, share := splitCost(amount, price)
		if cost <= 0 {
			continue
		}
		txn := fmt.Sprintf("%s:%d:%s", runtime.RID, runtime.Attempt, unit)
		// 消费侧记的是**用量**：额度按计量单位发，余额也按单位扣。
		consumer = append(consumer, &repository.GalaxyConsumerLedger{
			BizLine: bizLine, TxnID: txn, KeyID: runtime.ConsumerKey, Type: "settle",
			Unit: unit, Amount: amount, Price: price.Price, UnitID: runtime.RID,
		})
		platformFee += cost - share
		// 供给侧记的是**积分**，和信用账户余额同一量纲。
		//
		// 这里原先记的是计量数（token 数），于是收益页上「今天赚了多少」加的是 token、
		// 「可提现」用的是余额里的钱，两个口径根本不是一个东西。原始计量数在
		// zt_galaxy_meter_record 里（对账以它为准），这一行只回答「这笔挣了多少」；
		// 是哪种计量单位挣来的写在 Unit 上。
		provider = append(provider, &repository.GalaxyProviderLedger{
			BizLine: bizLine, TxnID: txn, CID: runtime.CID, OwnerUserID: owner, Type: ledgerSettle,
			Unit: unit, Amount: share, Price: price.Price, UnitID: runtime.RID,
		})
	}

	if err := s.repository.SaveMeterRecords(ctx, meters); err != nil {
		return err
	}
	// 账本一行一行地写，**只对真的插进去的那些动余额**。
	//
	// 账本按 (biz_line, txn_id) 幂等，而余额是加减：批量写完再按总额加一次的话，
	// 一次重放就是白发一笔钱。settle 那边已经有一道重放闸门（见 unit.go 的 settle），
	// 这里是第二道 —— 钱的事不该只有一层保险，而且这条路还有别的调用方。
	for _, row := range consumer {
		inserted, err := s.repository.SaveConsumerLedgerRow(ctx, row)
		if err != nil {
			return err
		}
		if !inserted {
			continue
		}
		// 余额扣减：P0 内测密钥可能没有该单位的余额行，扣不动就只记账不阻断。
		_, _ = s.repository.ConsumeBalance(ctx, bizLine, runtime.ConsumerKey, row.Unit, row.Amount)
	}
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
	if platformFee > 0 {
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

// splitCost 把一笔用量折成钱，并按分成比例切给提供者。
//
// 收钱和退钱必须用同一个算式：两处各写一遍的话，只要取整方式差一点，
// 退给消费者的和从提供者那儿追回的就对不上，坏账会悄悄堆在平台账上。
// 所以这里是唯一的出处，record 与争议追回都从这里拿。
func splitCost(amount int64, price priceRow) (cost, providerShare int64) {
	cost = amount * price.Price / priceScale
	if cost <= 0 {
		return 0, 0
	}
	return cost, int64(float64(cost) * price.ProviderShare)
}

type priceRow struct {
	Price         int64
	Currency      string
	ProviderShare float64
}

// priceTable 取某个 kind 当前生效的单价。同一 (kind, unit) 取 effective_from 最新的那条。
func (s *service) priceTable(ctx context.Context, kind string, at time.Time) (map[contract.MeterUnit]priceRow, error) {
	rows, err := s.repository.ListEffectivePrices(ctx, bizLine, at)
	if err != nil {
		return nil, err
	}
	out := map[contract.MeterUnit]priceRow{}
	for _, row := range rows {
		if row.Kind != kind {
			continue
		}
		if _, exists := out[row.Unit]; exists {
			continue // 已排序，第一条就是最新生效的
		}
		out[row.Unit] = priceRow{Price: row.Price, Currency: row.Currency, ProviderShare: row.ProviderShare}
	}
	return out, nil
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
	tables := map[string]map[contract.MeterUnit]priceRow{}
	for _, row := range rows {
		table, ok := tables[row.Kind]
		if !ok {
			table, err = s.priceTable(ctx, row.Kind, now)
			if err != nil {
				return dto.UsageReport{}, err
			}
			tables[row.Kind] = table
		}
		line := dto.UsageLine{Kind: row.Kind, Provider: row.Provider, Unit: row.Unit, Amount: row.Amount, Calls: row.Calls}
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
		return left.Unit < right.Unit
	})
	return report, nil
}

// SeedPrices 写入中转站的默认定价（D-02 / D-03）：token 分单位定价，
// calls 与 time.seconds 不计价，只作供给侧额度与统计。装配层在初始化时调用一次。
func (s *service) SeedPrices(ctx context.Context, kind string, prices map[contract.MeterUnit]int64, providerShare float64) error {
	effective := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, unit := range contract.Metering(prices).Units() {
		if err := s.repository.SavePrice(ctx, &repository.GalaxyPrice{
			BizLine: bizLine, Kind: kind, Unit: unit, EffectiveFrom: effective,
			Price: prices[unit], Currency: "CNY", ProviderShare: providerShare,
		}); err != nil {
			return err
		}
	}
	return nil
}
