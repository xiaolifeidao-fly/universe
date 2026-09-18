package galaxy

import (
	"context"
	"database/sql/driver"
	"testing"
	"time"

	"contract"
)

// 合计单位（llm.total_tokens）只进计量与额度，永远不进账本。
//
// 它是四个 token 桶加起来的数，那些量已经被分项各收过一次了。再乘一次单价，
// 消费者被扣两遍、提供者被发两遍钱，而两边的账本各自都是自洽的 —— 对账对不出来。
//
// 这道闸必须设在 billing 里，不能指望「运营别给合计定价」：定价页的单位清单
// 是候选提示不是白名单（见 adminprice.go 的 knownMeterUnits），运营能手填任意单位。
func TestDerivedTotalNeverReachesTheLedgerEvenWhenPriced(t *testing.T) {
	service, database := billingHarness(t, &replayPlane{settled: true})
	// 模拟运营在定价页手滑给合计也填了一档价。
	database.tables["zt_galaxy_price"] = append(database.tables["zt_galaxy_price"], []driver.Value{
		"llm.chat", string(contract.UnitTotalTokens), replayPrice, "CNY", replayProviderShare, time.Now().Add(-time.Hour),
	})

	usage := contract.Metering{
		contract.UnitOutputTokens: replayTokens,
		contract.UnitTotalTokens:  replayTokens,
	}
	if err := service.record(context.Background(), replayRuntime(), contract.KindSpec{}, usage, true); err != nil {
		t.Fatalf("结算失败：%v", err)
	}

	// 计量流水两行都要有：额度按合计记数，对账按分项。少了合计，主人设的总量上限永远不涨。
	meters := database.argsOf(t, "zt_galaxy_meter_record")
	if !bindsUnit(meters, string(contract.UnitTotalTokens)) {
		t.Fatalf("合计要进计量流水，否则总量额度对不上账：%v", meters)
	}
	if !bindsUnit(meters, string(contract.UnitOutputTokens)) {
		t.Fatalf("分项也要进计量流水：%v", meters)
	}

	// 账本只能有分项那一行。
	if got := database.count("zt_galaxy_consumer_ledger"); got != 1 {
		t.Fatalf("消费侧账本应当只有分项那一行，实际 %d 行 —— 合计被当成一个可计价的桶收了第二遍", got)
	}
	if got := database.count("zt_galaxy_provider_ledger"); got != 1 {
		t.Fatalf("供给侧账本应当只有分项那一行，实际 %d 行", got)
	}
}

// bindsUnit 某条写语句的绑定值里有没有这个单位名。
// 不叫 containsString —— 那个名字在 consumerkey.go 里已经有主了。
func bindsUnit(args []driver.Value, want string) bool {
	for _, arg := range args {
		switch value := arg.(type) {
		case string:
			if value == want {
				return true
			}
		case []byte:
			if string(value) == want {
				return true
			}
		}
	}
	return false
}

// 缓存写入的合计与推理 token 是新加的两个派生量，同样一步都不能进账本。
//
// cache_write 的量已经被 5m / 1h 两个分项各自收过了（那两个才是真正计价的，
// 单价差 1.6 倍）；reasoning 是 output 的一部分，output 已经整笔收过。
// 两个都以 _tokens 结尾、都长得像一个独立的桶，运营在定价页顺手填一档价
// 完全可能 —— 所以闸门和合计一样设在 billing 里。
func TestDerivedTokenSubsetsNeverReachTheLedger(t *testing.T) {
	for _, unit := range []contract.MeterUnit{contract.UnitCacheWriteTokens, contract.UnitReasoningTokens} {
		service, database := billingHarness(t, &replayPlane{settled: true})
		database.tables["zt_galaxy_price"] = append(database.tables["zt_galaxy_price"], []driver.Value{
			"llm.chat", string(unit), replayPrice, "CNY", replayProviderShare, time.Now().Add(-time.Hour),
		})

		usage := contract.Metering{contract.UnitOutputTokens: replayTokens, unit: replayTokens}
		if err := service.record(context.Background(), replayRuntime(), contract.KindSpec{}, usage, true); err != nil {
			t.Fatalf("%s 结算失败：%v", unit, err)
		}

		if !bindsUnit(database.argsOf(t, "zt_galaxy_meter_record"), string(unit)) {
			t.Fatalf("%s 要进计量流水：额度与对账都要用它", unit)
		}
		if got := database.count("zt_galaxy_consumer_ledger"); got != 1 {
			t.Fatalf("%s 被当成可计价的桶收了第二遍：消费侧账本 %d 行", unit, got)
		}
		if got := database.count("zt_galaxy_provider_ledger"); got != 1 {
			t.Fatalf("%s 被当成可计价的桶发了第二遍：供给侧账本 %d 行", unit, got)
		}
	}
}

// 拆出来的两个 TTL 桶是真正计价的那一层，必须进账本 ——
// 否则 5 分钟与 1 小时的单价差没有着落，整个拆分白做，而且表现是「缓存写入不要钱」。
func TestCacheWriteTTLBucketsAreBillable(t *testing.T) {
	service, database := billingHarness(t, &replayPlane{settled: true})
	for _, unit := range []contract.MeterUnit{contract.UnitCacheWrite5mTokens, contract.UnitCacheWrite1hTokens} {
		database.tables["zt_galaxy_price"] = append(database.tables["zt_galaxy_price"], []driver.Value{
			"llm.chat", string(unit), replayPrice, "CNY", replayProviderShare, time.Now().Add(-time.Hour),
		})
	}

	// 一笔缓存写入 1000，其中 400 是 1 小时档。合计那一行照写，但只有分项计价。
	usage := contract.Metering{
		contract.UnitCacheWriteTokens:   replayTokens,
		contract.UnitCacheWrite5mTokens: 600,
		contract.UnitCacheWrite1hTokens: 400,
	}
	if err := service.record(context.Background(), replayRuntime(), contract.KindSpec{}, usage, true); err != nil {
		t.Fatalf("结算失败：%v", err)
	}

	if got := database.count("zt_galaxy_consumer_ledger"); got != 2 {
		t.Fatalf("两个 TTL 桶各该入一次账，实际 %d 行", got)
	}
	if got := database.count("zt_galaxy_provider_ledger"); got != 2 {
		t.Fatalf("供给侧同理，实际 %d 行", got)
	}
}
