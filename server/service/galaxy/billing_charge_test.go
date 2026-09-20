package galaxy

import (
	"context"
	"database/sql/driver"
	"strings"
	"testing"

	"contract"
)

// 扣费落在**账户的积分余额**上，不落在密钥上。
//
// 额度曾经是按密钥、按模型分账的一堆 token 计数。改成余额之后，一次请求只有一笔钱：
// 按单价算出多少微积分，就从主人账上扣多少。这里钉三件事 ——
// 扣的是钱不是 token、一次请求只扣一笔、老的按密钥额度一行都不再碰。

const (
	pointsAccountTable = "zt_galaxy_points_account"
	pointsLedgerTable  = "zt_galaxy_points_ledger"
	balanceTable       = "zt_galaxy_consumer_balance"
)

// replayCost 这一次请求该扣多少：1000 × 15,000,000 ÷ 1,000,000 = 15,000 微积分。
const replayCost int64 = 15_000

func TestChargeDebitsTheOwnersBalanceOnce(t *testing.T) {
	service, database := billingHarness(t, &replayPlane{settled: true})
	runtime := replayRuntime()
	runtime.Model = "claude-opus-5"

	if err := service.record(context.Background(), runtime, contract.KindSpec{},
		contract.Metering{
			contract.UnitInputTokens:  replayTokens,
			contract.UnitOutputTokens: replayTokens,
		}, true); err != nil {
		t.Fatalf("结算失败：%v", err)
	}

	// 两个计量单位，但只有 output 有价（假库的价目表里只摆了它），
	// 而且不管几个单位有价，动余额的都只能是一笔。
	accounts := database.writesTo(pointsAccountTable)
	if len(accounts) != 1 {
		t.Fatalf("一次请求只该动一次余额，实际 %d 次", len(accounts))
	}
	if !containsValue(accounts[0], -replayCost) {
		t.Fatalf("扣的应当是 %d 微积分，实际绑定值：%v", -replayCost, accounts[0])
	}
	if containsValue(accounts[0], replayTokens) {
		t.Fatalf("余额上不该出现计量数 %d —— 那是用量，不是钱", replayTokens)
	}

	ledger := database.argsOf(t, pointsLedgerTable)
	if !containsValueString(ledger, "cu_buyer") {
		t.Fatalf("这笔消费该记在密钥主人名下，实际绑定值：%v", ledger)
	}
	if !containsValueString(ledger, "usage:u_replay:1") {
		t.Fatalf("幂等键该是 (请求, 第几次尝试)，实际绑定值：%v", ledger)
	}
	if !containsValueString(ledger, "u_replay") {
		t.Fatalf("流水要指回那一次请求，实际绑定值：%v", ledger)
	}
}

// 老的按密钥额度不再参与扣费：那些行还在库里（买过的记录），但请求路径不碰它们。
func TestChargeNeverTouchesTheLegacyKeyQuota(t *testing.T) {
	service, database := billingHarness(t, &replayPlane{settled: true})
	runtime := replayRuntime()
	runtime.Model = "claude-opus-5"

	if err := service.record(context.Background(), runtime, contract.KindSpec{},
		contract.Metering{contract.UnitOutputTokens: replayTokens}, true); err != nil {
		t.Fatalf("结算失败：%v", err)
	}
	if got := database.count(balanceTable); got != 0 {
		t.Fatalf("密钥额度表一次都不该写，实际写了 %d 次", got)
	}
}

// 不计费的那些请求（失败、首字节之前断开）照样不扣钱。
func TestNonBillableRequestChargesNothing(t *testing.T) {
	service, database := billingHarness(t, &replayPlane{settled: true})

	if err := service.record(context.Background(), replayRuntime(), contract.KindSpec{},
		contract.Metering{contract.UnitOutputTokens: replayTokens}, false); err != nil {
		t.Fatalf("结算失败：%v", err)
	}
	if got := database.count(pointsAccountTable); got != 0 {
		t.Fatalf("不计费的请求不该动余额，实际动了 %d 次", got)
	}
	// 计量照记：对账、用量统计要它，只是不进账本也不扣钱。
	if got := database.count("zt_galaxy_meter_record"); got == 0 {
		t.Fatal("不计费也要留计量流水")
	}
}

func containsValueString(args []driver.Value, want string) bool {
	for _, arg := range args {
		if value, ok := arg.(string); ok && strings.Contains(value, want) {
			return true
		}
	}
	return false
}
