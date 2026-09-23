package repository

import (
	"context"
	"strings"
	"testing"
	"time"
)

// 仪表盘那几条读语句：错了不会报错，只会给出一串看着合理的数字。
// 所以把下发出去的 SQL 抄下来，盯住几条「少了就静默算错」的东西。

func dashboardWindow() (time.Time, time.Time) {
	from := time.Date(2026, 9, 20, 0, 0, 0, 0, time.UTC)
	return from, from.Add(24 * time.Hour)
}

// TestUsageSlicesAlwaysBoundTime 三条用量查询都必须带上下界。
//
// 这三张是池子里最大的表（一次请求写若干行）。少一个边界不会报错 ——
// 它只是把「今天」悄悄变成「开天辟地以来」，然后在某个数据量足够大的日子里
// 把库拖垮，而在开发环境上永远看不出来。
func TestUsageSlicesAlwaysBoundTime(t *testing.T) {
	from, to := dashboardWindow()
	cases := []struct {
		name string
		call func(*GalaxyRepository) error
	}{
		{"计量流水", func(r *GalaxyRepository) error {
			_, err := r.SumMeterSlice(context.Background(), "galaxy", from, to)
			return err
		}},
		{"消费侧账本", func(r *GalaxyRepository) error {
			_, err := r.SumConsumerSettleSlice(context.Background(), "galaxy", from, to)
			return err
		}},
		{"供给侧账本", func(r *GalaxyRepository) error {
			_, err := r.SumProviderSettleSlice(context.Background(), "galaxy", from, to)
			return err
		}},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			repository, pool := recordingRepository(t)
			_ = item.call(repository)
			statement := lastStatement(t, pool)
			if strings.Count(statement, ">= ?") < 1 || strings.Count(statement, "< ?") < 1 {
				t.Fatalf("缺少时间上下界，实际下发：%s", statement)
			}
			if !strings.Contains(statement, "biz_line = ?") {
				t.Fatalf("缺少 biz_line，实际下发：%s", statement)
			}
			if !strings.Contains(statement, "GROUP BY") {
				t.Fatalf("没有分组就不是汇总，实际下发：%s", statement)
			}
		})
	}
}

// TestLedgerSlicesOnlyCountSettle 两本账只算结算流水。
//
// 账本上还有充值、退款、追回、过期。退款记的是反向的一笔（账只前进不回退），
// 不挑类型的话，一笔退款会被当成一笔新的消费加进「今天消耗了多少」里 ——
// 争议裁决当天，那一格会凭空涨一截。
func TestLedgerSlicesOnlyCountSettle(t *testing.T) {
	from, to := dashboardWindow()
	for _, item := range []struct {
		name string
		call func(*GalaxyRepository) error
	}{
		{"消费侧", func(r *GalaxyRepository) error {
			_, err := r.SumConsumerSettleSlice(context.Background(), "galaxy", from, to)
			return err
		}},
		{"供给侧", func(r *GalaxyRepository) error {
			_, err := r.SumProviderSettleSlice(context.Background(), "galaxy", from, to)
			return err
		}},
	} {
		t.Run(item.name, func(t *testing.T) {
			repository, pool := recordingRepository(t)
			_ = item.call(repository)
			statement := lastStatement(t, pool)
			if !strings.Contains(statement, "type = ?") || !strings.Contains(statement, "settle") {
				t.Fatalf("必须只算 type = settle，实际下发：%s", statement)
			}
		})
	}
}

// TestConsumerCostIsComputedPerRow 使用端金额逐笔算，不是先加总再乘单价。
//
// 计费本身就是每一笔向下取整的（见 billing.go 的 splitCost）。先 SUM 再乘的话，
// 算出来的数比真收的多一点点，而且随笔数增长 —— 对账时那个差额没人解释得清。
func TestConsumerCostIsComputedPerRow(t *testing.T) {
	from, to := dashboardWindow()
	repository, pool := recordingRepository(t)
	_, _ = repository.SumConsumerSettleSlice(context.Background(), "galaxy", from, to)
	statement := lastStatement(t, pool)
	if !strings.Contains(statement, "SUM((l.amount * l.price) DIV 1000000)") {
		t.Fatalf("金额必须逐笔向下取整再求和，实际下发：%s", statement)
	}
}

// TestNodePresenceFoldsMissingProviderType 没有 provider 行的机器算散户。
//
// 注册默认就是散户，只有管理端能设成工作室 —— 所以「没有那一行」不是未知，
// 是散户。折不掉的话界面上会多出一个第三类，而散户 + 工作室加不出在线总数。
func TestNodePresenceFoldsMissingProviderType(t *testing.T) {
	repository, pool := recordingRepository(t)
	_, _ = repository.ListNodePresence(context.Background(), "galaxy", time.Now().Add(-45*time.Second))
	statement := lastStatement(t, pool)
	if !strings.Contains(statement, "'individual'") {
		t.Fatalf("空身份要折成散户，实际下发：%s", statement)
	}
	if !strings.Contains(statement, "LEFT JOIN") {
		t.Fatalf("必须是 LEFT JOIN：INNER 会把没有 provider 行的机器整台漏掉，实际下发：%s", statement)
	}
	// 别名不能叫 provider_type：和 p.provider_type 同名时 MySQL 判成歧义列。
	if !strings.Contains(statement, "AS provider_kind") {
		t.Fatalf("别名要避开同名列，实际下发：%s", statement)
	}
	if !strings.Contains(statement, "status <> ?") || !strings.Contains(statement, "revoked") {
		t.Fatalf("解绑掉的机器不该进在线统计，实际下发：%s", statement)
	}
}

// TestQuotaWindowsQueriedByWindowKey 额度快照按窗口键查。
//
// 按 cid 查的话 IN 列表有几千项，语句本身就先长到几十 KB；而当下生效的窗口键
// 只有几个。这条查询走的是 idx_gx_quota_window_key。
func TestQuotaWindowsQueriedByWindowKey(t *testing.T) {
	repository, pool := recordingRepository(t)
	_, _ = repository.ListQuotaWindowsByKeys(context.Background(), "galaxy", []string{"20260920H2", "20260920"})
	statement := lastStatement(t, pool)
	if !strings.Contains(statement, "window_key IN") {
		t.Fatalf("要按窗口键取，实际下发：%s", statement)
	}
	if strings.Contains(statement, "cid IN") {
		t.Fatalf("不该按 cid 取，实际下发：%s", statement)
	}
}

// TestListQuotaWindowsByKeysSkipsEmpty 没有窗口键时一条语句都不发。
// 空 IN 列表在 MySQL 里是语法错误，而这里完全可能是空的（池子里一条额度都没设）。
func TestListQuotaWindowsByKeysSkipsEmpty(t *testing.T) {
	repository, pool := recordingRepository(t)
	rows, err := repository.ListQuotaWindowsByKeys(context.Background(), "galaxy", nil)
	if err != nil || rows != nil {
		t.Fatalf("空键集应该直接返回空：%v / %v", rows, err)
	}
	if len(pool.statements) != 0 {
		t.Fatalf("不该下发语句：%v", pool.statements)
	}
}

// TestRolledHoursOnlyReadsMarkers 巡检每分钟问一次「有没有漏的小时」，
// 只该取标记行。把两天的明细一起拉回来是每分钟一次的无谓搬运。
func TestRolledHoursOnlyReadsMarkers(t *testing.T) {
	from, to := dashboardWindow()
	repository, pool := recordingRepository(t)
	_, _ = repository.ListRolledHours(context.Background(), "galaxy", from, to)
	statement := lastStatement(t, pool)
	if !strings.Contains(statement, "category = ?") || !strings.Contains(statement, "unit = ?") {
		t.Fatalf("要按标记行过滤，实际下发：%s", statement)
	}
	if !strings.Contains(statement, "SELECT `stat_hour`") && !strings.Contains(statement, "SELECT stat_hour") {
		t.Fatalf("只取小时列，实际下发：%s", statement)
	}
}

// TestOrdersPaidUsesPaidAt 今天付掉的昨天那张单，钱是今天进来的。
// 按创建时间筛会把它算到昨天，而昨天那一页早就被人看过了。
func TestOrdersPaidUsesPaidAt(t *testing.T) {
	from, to := dashboardWindow()
	repository, pool := recordingRepository(t)
	_, _ = repository.SumOrdersPaid(context.Background(), "galaxy", from, to)
	statement := lastStatement(t, pool)
	if !strings.Contains(statement, "paid_at >= ?") || !strings.Contains(statement, "paid_at < ?") {
		t.Fatalf("要按到账时间筛，实际下发：%s", statement)
	}
	if strings.Contains(statement, "created_time >= ?") {
		t.Fatalf("不该按创建时间筛，实际下发：%s", statement)
	}
	if !strings.Contains(statement, "status IN") {
		t.Fatalf("没付掉的单不算进账，实际下发：%s", statement)
	}
}

// TestAccountStatCountsInOnePass 三个数一条语句查完，不是把同一张表扫三遍。
func TestAccountStatCountsInOnePass(t *testing.T) {
	from, _ := dashboardWindow()
	repository, pool := recordingRepository(t)
	_, _ = repository.AccountStatSince(context.Background(), "galaxy", SideProvider, from)
	if len(pool.statements) != 1 {
		t.Fatalf("应该只发一条语句，实际 %d 条", len(pool.statements))
	}
	statement := lastStatement(t, pool)
	if !strings.Contains(statement, "zt_galaxy_provider_user") {
		t.Fatalf("共享端要落在共享端那张表上，实际下发：%s", statement)
	}
	if !strings.Contains(statement, "last_login_at >= ?") || !strings.Contains(statement, "created_time >= ?") {
		t.Fatalf("登录与注册两个条件都要在，实际下发：%s", statement)
	}
}

// TestAccountStatNeedsASide 端不认识当场报错，不默默退回某一端 ——
// 退回的话，一个拼错的 side 会安安静静地数错一批人。
func TestAccountStatNeedsASide(t *testing.T) {
	from, _ := dashboardWindow()
	repository, _ := recordingRepository(t)
	if _, err := repository.AccountStatSince(context.Background(), "galaxy", "both", from); err == nil {
		t.Fatal("未知的端应该报错")
	}
}
