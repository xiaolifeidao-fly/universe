package galaxy

import (
	"strings"
	"testing"

	"service/galaxy/dto"
)

// TestNarrowKeysNeverWidens 盯的是越权：三个边界里任何一个写成「返回全部」或者
// 「忽略这个条件」，控制台就会把别人的会话列给当前用户。
func TestNarrowKeysNeverWidens(t *testing.T) {
	owned := []string{"ck_a", "ck_b"}
	cases := []struct {
		name  string
		owned []string
		keyID string
		want  []string
	}{
		{"不指定就是名下全部", owned, "", owned},
		{"指定名下的一把就只看这一把", owned, "ck_b", []string{"ck_b"}},
		{"指定别人的密钥查不到东西", owned, "ck_other", nil},
		{"名下一把都没有时不指定也查不到", nil, "", nil},
		{"名下一把都没有时指定任意密钥都查不到", nil, "ck_a", nil},
		{"空白当成没指定", owned, "   ", owned},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			got := narrowKeys(item.owned, item.keyID)
			if len(got) != len(item.want) {
				t.Fatalf("范围应为 %v，实际 %v", item.want, got)
			}
			for i := range got {
				if got[i] != item.want[i] {
					t.Fatalf("范围应为 %v，实际 %v", item.want, got)
				}
			}
		})
	}
}

// TestNarrowKeysEmptyIsNotUnfiltered 把「空 = 查不到」这条不变量单独钉住：
// 空切片进 `WHERE consumer_key IN ?` 等于没有这个条件，调用方必须在此之前挡掉。
func TestNarrowKeysEmptyIsNotUnfiltered(t *testing.T) {
	if got := narrowKeys([]string{}, "ck_a"); len(got) != 0 {
		t.Fatalf("名下无密钥时不该有任何范围，实际 %v", got)
	}
	if got := narrowKeys([]string{"ck_a"}, "ck_b"); len(got) != 0 {
		t.Fatalf("指定未持有的密钥不该有任何范围，实际 %v", got)
	}
}

func TestDeniedByOwnerIsNotRetryable(t *testing.T) {
	err := deniedByOwner("会话")
	if err == nil || !strings.Contains(err.Error(), "会话") {
		t.Fatalf("拒绝理由应指明是什么东西，实际 %v", err)
	}
}

// TestPricedLinesKeepsRoundedToZero 账单只摆计价行 —— 但「小到取整成 0」的行是计价行。
//
// 摘掉不计价的单位（llm.calls、time.seconds、llm.total_tokens，单价都是 0）是这个函数的
// 本职。危险的是顺手改成按扣费筛：单价乘以量向下取整到微元，几百个 token 的那一笔真的
// 会落成 0，而它是收过钱的。一起摘掉的后果是账单少一行、合计却没少 —— 差额无处可查。
func TestPricedLinesKeepsRoundedToZero(t *testing.T) {
	got := pricedLines([]dto.UsageLine{
		{Unit: "llm.input_tokens", UnitPrice: 3000, Cost: 14},
		{Unit: "llm.total_tokens"},
		{Unit: "time.seconds"},
		{Unit: "llm.calls"},
		{Unit: "llm.output_tokens", UnitPrice: 15000, Cost: 0},
	})
	want := []string{"llm.input_tokens", "llm.output_tokens"}
	if len(got) != len(want) {
		t.Fatalf("应只剩 %v，实际 %v", want, unitsOf(got))
	}
	for index, unit := range want {
		if got[index].Unit != unit {
			t.Fatalf("应只剩 %v，实际 %v", want, unitsOf(got))
		}
	}
}

// TestPricedLinesEmptyIsNotNull 一行计价的都没有时是空账单，不是 null。
// 序列化成 null 的那一路，前端拿到的是「没有这个字段」而不是「这段时间没花钱」。
func TestPricedLinesEmptyIsNotNull(t *testing.T) {
	if got := pricedLines([]dto.UsageLine{{Unit: "llm.calls"}}); got == nil {
		t.Fatal("空账单也要是空切片，不能是 nil")
	}
}

func unitsOf(lines []dto.UsageLine) []string {
	units := make([]string, 0, len(lines))
	for _, line := range lines {
		units = append(units, line.Unit)
	}
	return units
}
