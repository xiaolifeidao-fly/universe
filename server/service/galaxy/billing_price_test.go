package galaxy

import (
	"context"
	"database/sql/driver"
	"testing"
	"time"

	"contract"
)

// 上游价与下游价各自独立。
//
// 原先一行价只有「对外单价 + 分成比例」，于是给共享者的钱是对外价的一个函数：
// 想给使用者降价就必须同时砍掉所有共享者的收入，而共享者拿自己的积分流水
// 除一除就反推出平台抽了几成。下面几条钉的就是「这两件事已经拆开了」。

const (
	// 对外 ¥15 / 百万，结算 ¥9 / 百万 —— 故意不是七成，七成会和回落算出来的数撞上，
	// 撞上的话这几条用例就分不清走的是哪条路。
	twoPriceRetail  int64 = 15_000_000
	twoPriceSettle  int64 = 9_000_000
	twoPriceCredit  int64 = 9_000  // 1000 token × 9,000,000 ÷ 1,000,000
	twoPriceCharged int64 = 15_000 // 1000 token × 15,000,000 ÷ 1,000,000
)

func TestSplitCostPaysProviderItsOwnPrice(t *testing.T) {
	cost, share := splitCost(replayTokens, priceRow{
		Price: twoPriceRetail, ProviderPrice: twoPriceSettle, ProviderShare: 0.7,
	})
	if cost != twoPriceCharged {
		t.Fatalf("使用者应当被收 %d，实际 %d", twoPriceCharged, cost)
	}
	if share != twoPriceCredit {
		t.Fatalf("共享者应当拿到 %d，实际 %d —— 结算价填了就不该再走分成比例", twoPriceCredit, share)
	}
}

// 调对外价不该动共享者的收入。这是拆开两个价的**全部意义**，
// 所以它值一条独立的用例，而不是靠上面那条顺带覆盖。
func TestRetailPriceChangeLeavesProviderPayoutAlone(t *testing.T) {
	before := priceRow{Price: twoPriceRetail, ProviderPrice: twoPriceSettle}
	// 对外价腰斩（促销），结算价一个字没改。
	after := priceRow{Price: twoPriceRetail / 2, ProviderPrice: twoPriceSettle}

	_, shareBefore := splitCost(replayTokens, before)
	costAfter, shareAfter := splitCost(replayTokens, after)

	if shareBefore != shareAfter {
		t.Fatalf("对外价变了共享者的收入不该变，改前 %d 改后 %d", shareBefore, shareAfter)
	}
	if costAfter != twoPriceCharged/2 {
		t.Fatalf("使用者这边应当跟着降到 %d，实际 %d", twoPriceCharged/2, costAfter)
	}
}

// 存量行：结算价还没填，回落到老口径，金额和改动之前一模一样。
// 迁移脚本没跑就发版的那半小时里，靠的就是这条路。
func TestSplitCostFallsBackToLegacyShare(t *testing.T) {
	cost, share := splitCost(replayTokens, priceRow{Price: replayPrice, ProviderShare: replayProviderShare})
	if cost != replayTokens*replayPrice/priceScale {
		t.Fatalf("对外金额算错了：%d", cost)
	}
	if share != replayCredit {
		t.Fatalf("没填结算价时应当回落到分成比例、给出 %d，实际 %d", replayCredit, share)
	}
}

// 结算价高过对外价 = 平台倒贴。这是个合法的运营选择（拉新期的定向补贴），
// 所以它必须真的算得出来：卡在 cost <= 0 上把整行跳过，等于共享者白跑。
func TestSplitCostAllowsSubsidy(t *testing.T) {
	cost, share := splitCost(replayTokens, priceRow{Price: 1_000_000, ProviderPrice: twoPriceSettle})
	if cost != 1_000 {
		t.Fatalf("对外金额应为 1000，实际 %d", cost)
	}
	if share != twoPriceCredit {
		t.Fatalf("补贴期共享者照拿 %d，实际 %d", twoPriceCredit, share)
	}
	if fee := cost - share; fee >= 0 {
		t.Fatalf("平台这一笔应当是负的（倒贴），实际 %d", fee)
	}
}

// 对外免费、照付共享者：两个价都看，才不会把这种行整行跳过。
func TestSplitCostPaysProviderEvenWhenRetailIsFree(t *testing.T) {
	cost, share := splitCost(replayTokens, priceRow{Price: 0, ProviderPrice: twoPriceSettle})
	if cost != 0 {
		t.Fatalf("对外免费就不该收钱，实际 %d", cost)
	}
	if share != twoPriceCredit {
		t.Fatalf("共享者照拿 %d，实际 %d", twoPriceCredit, share)
	}
}

func TestSettleUnitPricePrefersProviderPrice(t *testing.T) {
	got := settleUnitPrice(priceRow{Price: twoPriceRetail, ProviderPrice: twoPriceSettle, ProviderShare: 0.7})
	if got != twoPriceSettle {
		t.Fatalf("填了结算价就该用它：想要 %d，实际 %d", twoPriceSettle, got)
	}
	// 没填的回落到老比例，好让界面显示「共享者实际按多少结」而不是一个 0。
	if got := settleUnitPrice(priceRow{Price: 10_000_000, ProviderShare: 0.7}); got != 7_000_000 {
		t.Fatalf("没填结算价时应当回落到 7,000,000，实际 %d", got)
	}
}

func TestMarginBps(t *testing.T) {
	if got := marginBps(twoPriceRetail, twoPriceSettle); got != 4000 {
		t.Fatalf("毛利应为 40%%（4000 bps），实际 %d", got)
	}
	if got := marginBps(1_000_000, twoPriceSettle); got >= 0 {
		t.Fatalf("倒贴时毛利应当是负的，实际 %d", got)
	}
	// 对外价为 0 时除不出比例。返 0 而不是崩掉 —— 免费单位是合法配置。
	if got := marginBps(0, twoPriceSettle); got != 0 {
		t.Fatalf("对外价为 0 时应当返 0，实际 %d", got)
	}
}

// 供给侧账本里不能出现对外价。
//
// 那一列原先抄的就是 price（对外单价），于是「平台收了多少」直接写在
// 共享者自己查得到的流水上 —— 拿它和 amount 一除就是抽成比例。
func TestProviderLedgerNeverCarriesTheRetailPrice(t *testing.T) {
	service, database := billingHarness(t, &replayPlane{settled: true})
	// 把假库里那行价换成「两个价都填了」的形态。
	database.columns["zt_galaxy_price"] = []string{"kind", "unit", "price", "currency", "provider_price", "provider_share", "effective_from"}
	database.tables["zt_galaxy_price"] = [][]driver.Value{{
		"llm.chat", string(contract.UnitOutputTokens), twoPriceRetail, "CNY",
		twoPriceSettle, replayProviderShare, time.Now().Add(-time.Hour),
	}}

	usage := contract.Metering{contract.UnitOutputTokens: replayTokens}
	if err := service.record(context.Background(), replayRuntime(), contract.KindSpec{}, usage, true); err != nil {
		t.Fatalf("结算失败：%v", err)
	}

	provider := database.argsOf(t, "zt_galaxy_provider_ledger")
	if !containsValue(provider, twoPriceSettle) {
		t.Fatalf("供给侧账本的单价应当是结算价 %d，实际绑定值：%v", twoPriceSettle, provider)
	}
	if containsValue(provider, twoPriceRetail) {
		t.Fatalf("供给侧账本里不该出现对外价 %d —— 共享者拿它一除就知道平台抽了几成", twoPriceRetail)
	}
	if !containsValue(provider, twoPriceCredit) {
		t.Fatalf("供给侧账本应当记积分 %d，实际绑定值：%v", twoPriceCredit, provider)
	}

	// 消费侧相反：账单本来就是按对外价开给使用者的，那一列该是它。
	consumer := database.argsOf(t, "zt_galaxy_consumer_ledger")
	if !containsValue(consumer, twoPriceRetail) {
		t.Fatalf("消费侧账本的单价应当是对外价 %d，实际绑定值：%v", twoPriceRetail, consumer)
	}
}
