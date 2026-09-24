package galaxy

import (
	"context"
	"database/sql/driver"
	"testing"
	"time"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

func TestSweeperDoesNotStoreCurrentHour(t *testing.T) {
	s, db := billingHarness(t, &replayPlane{})
	now := time.Date(2026, 9, 23, 10, 5, 0, 0, time.UTC)
	closed := now.Add(-rollupGrace).Truncate(time.Hour)
	db.columns["zt_galaxy_usage_rollup"] = []string{"stat_hour", "category", "unit", "rolled_at"}
	for hour := closed.Add(-rollupBackfillHours * time.Hour); hour.Before(closed); hour = hour.Add(time.Hour) {
		db.tables["zt_galaxy_usage_rollup"] = append(db.tables["zt_galaxy_usage_rollup"],
			[]driver.Value{hour, "", "", hour.Add(time.Hour + rollupGrace)})
	}
	if err := s.rollupUsage(context.Background(), now); err != nil {
		t.Fatal(err)
	}
	if db.count("zt_galaxy_usage_rollup") != 0 {
		t.Fatal("sweeper wrote the still-open hour despite all closed hours being complete")
	}
}

func TestDashboardRecomputesPrematureStoredMoneyAndTokens(t *testing.T) {
	s, db := billingHarness(t, &replayPlane{})
	hour := time.Date(2026, 9, 23, 10, 0, 0, 0, time.UTC)
	db.columns["zt_galaxy_usage_rollup"] = []string{"stat_hour", "category", "unit", "amount", "provider_amount", "rolled_at"}
	db.tables["zt_galaxy_usage_rollup"] = [][]driver.Value{
		{hour, "", "", int64(0), int64(0), hour.Add(5 * time.Minute)},
		{hour, "codex", contract.UnitTotalTokens, int64(10), int64(230000), hour.Add(5 * time.Minute)},
	}
	for _, table := range []string{"zt_galaxy_meter_record", "zt_galaxy_consumer_ledger", "zt_galaxy_provider_ledger"} {
		db.columns[table] = []string{"model", "provider", "kind", "unit", "amount", "cost"}
	}
	db.tables["zt_galaxy_meter_record"] = [][]driver.Value{{"gpt-5.6-sol", "codex_chatgpt", "llm.chat", contract.UnitTotalTokens, int64(500), int64(0)}}
	db.tables["zt_galaxy_consumer_ledger"] = [][]driver.Value{{"gpt-5.6-sol", "codex_chatgpt", "llm.chat", contract.UnitOutputTokens, int64(50), int64(15000000)}}
	db.tables["zt_galaxy_provider_ledger"] = [][]driver.Value{{"gpt-5.6-sol", "codex_chatgpt", "llm.chat", contract.UnitOutputTokens, int64(0), int64(10841500)}}
	got, _, err := s.usageRange(context.Background(), hour, hour.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if got.Total.Tokens != 500 || got.Total.ProviderAmount != 10841500 || got.Total.ConsumerAmount != 15000000 {
		t.Fatalf("dashboard reused incomplete rollup: %+v", got.Total)
	}
}

func TestDashboardRejectsPrematureRollup(t *testing.T) {
	hour := time.Date(2026, 9, 23, 10, 0, 0, 0, time.UTC)
	for _, offset := range []time.Duration{0, 5 * time.Minute, time.Hour, time.Hour + 59*time.Second} {
		if validRollup(hour, hour.Add(offset)) {
			t.Fatalf("accepted partial hour frozen at %s", offset)
		}
	}
	if !validRollup(hour, hour.Add(time.Hour+rollupGrace)) {
		t.Fatal("rejected a closed hour after grace period")
	}
}

func TestDashboardMixedLegacyTokenTotals(t *testing.T) {
	units := []dto.DashboardUsageUnit{
		{Unit: contract.UnitTotalTokens, Amount: 100},
		{Unit: contract.UnitInputTokens, Amount: 100},
		{Unit: contract.UnitOutputTokens, Amount: 50},
		{Unit: contract.UnitCacheReadTokens, Amount: 300},
		{Unit: contract.UnitCacheWrite5mTokens, Amount: 20},
		{Unit: contract.UnitCacheWrite1hTokens, Amount: 30},
		{Unit: contract.UnitReasoningTokens, Amount: 40},
	}
	if tokens, _ := tokensAndCalls(units); tokens != 500 {
		t.Fatalf("partial total must not hide legacy buckets: %d", tokens)
	}
	units = append(units, dto.DashboardUsageUnit{Unit: contract.UnitCacheWriteTokens, Amount: 50})
	if tokens, _ := tokensAndCalls(units); tokens != 500 {
		t.Fatalf("cache TTL buckets counted twice: %d", tokens)
	}
}

func TestDashboardRequestStatesAreDisjoint(t *testing.T) {
	got := dashboardRequests([]repository.DashboardRequestState{
		{State: "completed", Count: 433}, {State: "failed", Count: 90},
		{State: "cancelled", Count: 2}, {State: "expired", Count: 3},
		{State: "queued", Count: 4}, {State: "streaming", Count: 5},
	})
	if got.Total != 537 || got.Completed != 433 || got.Failed != 90 || got.Pending != 9 ||
		got.Total != got.Completed+got.Failed+got.Cancelled+got.Expired+got.Pending {
		t.Fatalf("request counts do not reconcile: %+v", got)
	}
}
