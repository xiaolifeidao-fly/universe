package repository

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestIncrementTrackingDailyIsAtomic(t *testing.T) {
	repository, pool := recordingRepository(t)
	now := time.Date(2026, 9, 23, 12, 0, 0, 0, time.Local)
	err := repository.IncrementTrackingDaily(context.Background(), &GalaxyTrackingDaily{
		BizLine: "galaxy", EventDate: now, EventKey: "portal.open", Count: 1,
		CreatedTime: now, UpdatedTime: now,
	})
	if err != nil {
		t.Fatalf("记录埋点：%v", err)
	}
	statement := lastStatement(t, pool)
	if !strings.Contains(statement, "ON DUPLICATE KEY UPDATE") {
		t.Fatalf("并发累加必须由唯一键 upsert 完成，实际下发：%s", statement)
	}
	if !strings.Contains(statement, "count + ?") && !strings.Contains(statement, "`count`+?") {
		t.Fatalf("重复键必须原子加一，实际下发：%s", statement)
	}
}

func TestListTrackingDailyIsBoundedAndGrouped(t *testing.T) {
	repository, pool := recordingRepository(t)
	from := time.Date(2026, 9, 10, 0, 0, 0, 0, time.Local)
	_, _ = repository.ListTrackingDaily(context.Background(), "galaxy", from, from.AddDate(0, 0, 14))
	statement := lastStatement(t, pool)
	for _, fragment := range []string{"biz_line = ?", "event_date >= ?", "event_date < ?", "GROUP BY"} {
		if !strings.Contains(statement, fragment) {
			t.Fatalf("埋点趋势查询缺少 %q，实际下发：%s", fragment, statement)
		}
	}
	if !strings.Contains(statement, "SUM(count)") {
		t.Fatalf("同一事件的不同模型目标要在 SQL 内合计，实际下发：%s", statement)
	}
}
