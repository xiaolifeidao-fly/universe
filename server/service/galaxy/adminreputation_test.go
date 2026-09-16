package galaxy

import (
	"context"
	"strings"
	"testing"

	"service/galaxy/dto"
)

// 信誉直接决定一台机器还能不能接到单。人工改它有两处容易错，都在这里钉住。

// TestSetReputationRefusesAScoreOutsideZeroToOne 越界的分数。
//
// 放过去的不是报错：1.5 会让这台机器的分永远比满分还高，扣分扣半天也掉不下来；
// 负数则让它再也回不到能接单的范围。
func TestSetReputationRefusesAScoreOutsideZeroToOne(t *testing.T) {
	svc, db, _ := banHarness(t, nil)
	for _, value := range []float64{-0.1, 1.5} {
		err := svc.SetReputation(context.Background(), dto.SetReputationRequest{
			Subject: "account:pu_1", Value: value, Reason: "复核",
		})
		if err == nil {
			t.Fatalf("分数 %v 应当被拒", value)
		}
	}
	if len(db.writes) > 0 {
		t.Fatalf("被拒的请求不该写任何一行，实际写了 %v", db.writes)
	}
}

// TestSetReputationMakesYouSayWhy 改信誉要写原因。
//
// 这一行只留最近一次处置，而下一个来查「这台机器为什么接不到单」的人看的就是它。
func TestSetReputationMakesYouSayWhy(t *testing.T) {
	svc, _, _ := banHarness(t, nil)
	if err := svc.SetReputation(context.Background(), dto.SetReputationRequest{
		Subject: "account:pu_1", Value: 1, Reason: "   ",
	}); err == nil {
		t.Fatal("没写原因应当被拒")
	}
}

// TestSetReputationWritesTheScoreAndResettlesTheClock 设完要把结算时刻推到此刻。
//
// 不推的话，这个新分数会立刻被「从上次结算到现在」的回升量再加一遍 ——
// 运营设的 0.5 实际落地成 0.5 加上好几天的回升，而界面上显示的是另一个数。
func TestSetReputationWritesTheScoreAndResettlesTheClock(t *testing.T) {
	svc, db, _ := banHarness(t, nil)
	if err := svc.SetReputation(context.Background(), dto.SetReputationRequest{
		Subject: "device:fp_abc", Value: 1, Reason: "探针超时导致的误判，已复核",
	}); err != nil {
		t.Fatalf("设定应当成功：%v", err)
	}
	index := db.writeIndex("zt_galaxy_reputation")
	if index < 0 {
		t.Fatal("没有写信誉表")
	}
	written := db.writes[index]
	if !strings.Contains(written, "reputation_at") {
		t.Fatalf("要把结算时刻一起推到此刻，实际写的是 %s", written)
	}
}

// TestSplitSubjectKeepsUnprefixedOnesAsNodes 老数据没有前缀。
//
// 硬塞进 account 会让界面说「这是个账号」，而那一串其实是 nodeId ——
// 运营照着它去账号页里找，什么也找不到。
func TestSplitSubjectKeepsUnprefixedOnesAsNodes(t *testing.T) {
	for _, item := range []struct{ in, kind, ref string }{
		{"account:pu_1", "account", "pu_1"},
		{"device:fp_abc", "device", "fp_abc"},
		{"n_legacy_01", "node", "n_legacy_01"},
	} {
		kind, ref := splitSubject(item.in)
		if kind != item.kind || ref != item.ref {
			t.Errorf("%s 应当拆成 (%s, %s)，实际 (%s, %s)", item.in, item.kind, item.ref, kind, ref)
		}
	}
}
