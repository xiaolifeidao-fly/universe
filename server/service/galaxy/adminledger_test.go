package galaxy

import (
	"testing"

	"service/galaxy/dto"
)

// 三本账最容易错的一件事：把三张表的 amount 当成同一个东西。
// 消费侧扣的是计量数、供给侧记的是微积分、平台侧记的是微分 ——
// 界面拿同一套「÷1,000,000 显示成元」去画，消费侧那一列会变成一个荒唐的小数，
// 而看的人不会意识到自己在读一个错的数。量纲必须由服务端一路带到界面上。

func TestLedgerAmountUnitIsDeclaredForEverySide(t *testing.T) {
	want := map[string]string{
		dto.LedgerSideConsumer: "metering",
		dto.LedgerSideProvider: "credit",
		dto.LedgerSidePlatform: "money",
	}
	for side, unit := range want {
		if ledgerAmountUnit[side] != unit {
			t.Errorf("%s 的量纲应当是 %s，实际 %s", side, unit, ledgerAmountUnit[side])
		}
	}
	if len(ledgerAmountUnit) != len(want) {
		t.Fatalf("每一侧都要声明量纲，缺一侧界面就会拿默认规则去画：%v", ledgerAmountUnit)
	}
}

// TestLedgerTypesCoverEverySide 类型下拉也是按侧定义的。
// 少一侧，那一侧的筛选框会是空的 —— 运营只能把类型背下来手填，而它根本没有输入框。
func TestLedgerTypesCoverEverySide(t *testing.T) {
	for _, side := range []string{dto.LedgerSideConsumer, dto.LedgerSideProvider, dto.LedgerSidePlatform} {
		if len(ledgerTypesBySide[side]) == 0 {
			t.Errorf("%s 没有声明流水类型", side)
		}
	}
	// 平台侧只有这两类，它们就是「毛利」和「亏掉的」。
	if len(ledgerTypesBySide[dto.LedgerSidePlatform]) != 2 {
		t.Errorf("平台侧应当只有 fee 与 baddebt，实际 %v", ledgerTypesBySide[dto.LedgerSidePlatform])
	}
}
