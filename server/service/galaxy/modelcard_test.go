package galaxy

import (
	"testing"

	"contract"
	"service/galaxy/dto"
)

// 「省 X%」是写在卡片上给人看的一句承诺，算错一位就是对外报错价。
// 这一组定住三件事：没填官方价不出现折扣、官方价不高于自家价不出现折扣、
// 以及截图里那几个数真能算出 85% / 70% / 75%。
func TestDiscountBps(t *testing.T) {
	cases := []struct {
		name  string
		price int64
		list  int64
		want  int
	}{
		{"官方价没填", 4_500_000, 0, 0},
		{"自家价没填（回落前）", 0, 50_000_000, 0},
		{"官方价和自家价一样", 4_500_000, 4_500_000, 0},
		{"官方价反而更低，当没填", 4_500_000, 3_000_000, 0},
		{"7.5 比 50：省 85%", 7_500_000, 50_000_000, 8500},
		{"15 比 50：省 70%", 15_000_000, 50_000_000, 7000},
		{"6.25 比 25：省 75%", 6_250_000, 25_000_000, 7500},
	}
	for _, item := range cases {
		if got := discountBps(item.price, item.list); got != item.want {
			t.Fatalf("%s：discountBps(%d, %d) = %d，想要 %d", item.name, item.price, item.list, got, item.want)
		}
	}
}

// 折扣要按**卡片上最终显示的那个价**算。模型自己没定价时价格回落到 kind 统一价，
// 这时还拿库里那个 0 去比，「省 X%」就消失了 —— 而访问者眼前明明有一个要付的数。
func TestApplyKindPriceRecomputesDiscount(t *testing.T) {
	model := dto.PortalModelView{ListInputPrice: 10_000_000, ListOutputPrice: 50_000_000}
	table := map[contract.MeterUnit]priceRow{
		contract.UnitInputTokens:  {Price: 1_500_000, Currency: "CNY"},
		contract.UnitOutputTokens: {Price: 7_500_000},
	}
	applyKindPrice(&model, table, nil)
	if model.DiscountBps != 8500 {
		t.Fatalf("回落到统一价之后 DiscountBps = %d，想要 8500", model.DiscountBps)
	}
	if model.Priced {
		t.Fatalf("价格是回落来的，Priced 应该是 false")
	}
}

// 角标的文案和配色要一起生灭：只剩配色的话，前端得再判一次「有色但没字」。
func TestBadgeTone(t *testing.T) {
	cases := map[[2]string]string{
		{"首发", badgeToneNew}:      badgeToneNew,
		{"性价比旗舰", badgeToneValue}: badgeToneValue,
		{"均衡", ""}:                badgeToneNeutral,
		{"主力", "chartreuse"}:      badgeToneNeutral,
		{"", badgeToneHot}:        "",
		{"   ", badgeToneHot}:     "",
	}
	for input, want := range cases {
		if got := badgeTone(input[0], input[1]); got != want {
			t.Fatalf("badgeTone(%q, %q) = %q，想要 %q", input[0], input[1], got, want)
		}
	}
}
