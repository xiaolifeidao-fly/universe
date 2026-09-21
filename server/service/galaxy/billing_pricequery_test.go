package galaxy

import (
	"context"
	"strings"
	"testing"
	"time"

	"contract"
)

// 取价这条查询长什么样，钉死。
//
// 它每笔计费都走一遍（record → priceTable），而价目表只会越长越大：
// 调价是插新行，旧行留作历史、永远不删。走不走得上索引全看 WHERE 和 ORDER BY，
// 而写错了不会报错、不会慢到超时，只是每笔请求多扫几千行 —— 这种退化没人会发现。
//
//	uk_gx_price = (biz_line, kind, model_id, effort, unit, effective_from)
func TestPriceLookupStaysOnTheUniqueKey(t *testing.T) {
	service, database := billingHarness(t, &replayPlane{settled: true})
	if _, err := service.priceTable(context.Background(), "llm.chat", "claude-opus-5", contract.EffortHigh, time.Now()); err != nil {
		t.Fatalf("取价失败：%v", err)
	}
	query := database.queryOf(t, "zt_galaxy_price")

	// biz_line 恒等于 'galaxy'：不带 kind 就等于没有过滤条件，索引只能整段扫。
	if !strings.Contains(query, "kind = ?") {
		t.Fatalf("计费路径必须按 kind 收窄，实际语句：%s", query)
	}
	// ORDER BY 要和索引同向。末尾一个 desc 就够让 MySQL 放弃索引顺序、改走 filesort ——
	// 而那正是把 resolvePrices 写成「后来的盖掉先来的」换回来的东西。
	if strings.Contains(strings.ToLower(query), "desc") {
		t.Fatalf("ORDER BY 必须全升序，实际语句：%s", query)
	}
	if !strings.Contains(query, "ORDER BY kind, model_id, effort, unit, effective_from") {
		t.Fatalf("ORDER BY 要按唯一键的列序，实际语句：%s", query)
	}
}

// 门户、运营台、共享端模型页要跨 kind 看，那几处不带 kind 是**有意的**。
// 这条用例只是让「不带 kind」显式地是一个选择，而不是漏了。
func TestPriceLookupWithoutKindListsEveryKind(t *testing.T) {
	service, database := billingHarness(t, &replayPlane{settled: true})
	if _, err := service.repository.ListEffectivePrices(context.Background(), bizLine, "", time.Now()); err != nil {
		t.Fatalf("取价失败：%v", err)
	}
	query := database.queryOf(t, "zt_galaxy_price")
	if strings.Contains(query, "kind = ?") {
		t.Fatalf("kind 为空时不该有这个条件，实际语句：%s", query)
	}
}
