package repository

import (
	"context"
	"strings"
	"testing"
)

// 单元表的读语句：错了不报错，只会给出一页看着合理、其实数不对的记录。

// TestListUnitsExcludeStatesNarrowsCount 排除状态要连**计数**一起收窄。
//
// 消费者的「逐笔扣费」靠它把失败那几行拿掉。列表和计数都从 unitScope 长出来，
// 这一条断言的是那个共用的条件真的拼了出来；挑计数来断言，是因为计数错了最难发现：
// 它不报错，只会让页脚写着「共 11 条」，而翻遍每一页也只数得出 7 行。
//
// （这里的仓储只记不执行，计数拿不到结果就返回了，所以下发出来的只有这一条。）
func TestListUnitsExcludeStatesNarrowsCount(t *testing.T) {
	repository, pool := recordingRepository(t)
	_, _, _ = repository.ListUnits(context.Background(), UnitQuery{
		BizLine: "galaxy", ConsumerKeys: []string{"ck_a"},
		ExcludeStates: []string{"failed"}, Limit: 15,
	})
	statement := lastStatement(t, pool)
	if !strings.Contains(strings.ToLower(statement), "count(") {
		t.Fatalf("第一条就该是计数，实际下发：%s", statement)
	}
	if !strings.Contains(statement, "state NOT IN") || !containsArg(pool.args[len(pool.args)-1], "failed") {
		t.Fatalf("计数没有排除 failed，实际下发：%s", statement)
	}
}

// TestListUnitsWithoutExcludeStatesKeepsEverything 不填就是不筛。
//
// 空切片进 `NOT IN ?` 不是「没有这个条件」：拼出来是 `NOT IN (NULL)`，
// 它对每一行都判不成立 —— 一个没人填的可选条件会把整张表筛空。
func TestListUnitsWithoutExcludeStatesKeepsEverything(t *testing.T) {
	repository, pool := recordingRepository(t)
	_, _, _ = repository.ListUnits(context.Background(), UnitQuery{
		BizLine: "galaxy", ConsumerKeys: []string{"ck_a"}, Limit: 15,
	})
	statement := lastStatement(t, pool)
	if strings.Contains(statement, "NOT IN") {
		t.Fatalf("没填排除状态却筛了：%s", statement)
	}
}
