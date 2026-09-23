package galaxy

import (
	"testing"

	"service/galaxy/internal/repository"
)

// TestDecideClose 钉住关闭动作的三条边界。
//
// 这三条边界就是这个功能的全部：
//
//   - 手上没活时，force 不该扣分 —— 那种「强制」和普通关闭没有任何区别，
//     扣了就是白扣一次信誉，而主人只是点了那个更显眼的按钮。
//   - 有活且没 force 时**不该报错**：报错等于让主人守着反复点，
//     而那正是这次改动要消灭的东西。
//   - 有活且 force 时才掐断并扣分。
func TestDecideClose(t *testing.T) {
	cases := []struct {
		name     string
		inflight int
		force    bool
		want     closeAction
	}{
		{"手上没活，当场关", 0, false, closeNow},
		{"手上没活，强制也只是当场关（不扣分）", 0, true, closeNow},
		// 负数只会来自计数器被回滚穿了。当成「没活」而不是「有活」：
		// 前者最多早关一步，后者会让主人永远关不掉。
		{"计数器穿底按没活算", -1, false, closeNow},
		{"有活，排队等排空", 1, false, closePending},
		{"有活，强制掐断", 1, true, closeForce},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			if got := decideClose(item.inflight, item.force); got != item.want {
				t.Fatalf("inflight=%d force=%v：想要 %v，实际 %v", item.inflight, item.force, item.want, got)
			}
		})
	}
}

// TestOwnerClosedGuardsHeartbeat 盯的是心跳里那道绕行判据。
//
// 少了它，心跳会把主人关掉的共享**打开**：快照里 paused / draining 的 Draining
// 都是 true，而额度没触顶时 shouldDrain 是 false，两者不等就回写 status=active。
// 主人关完，15 秒之后自己开了回来 —— 而且不会有任何报错。
func TestOwnerClosedGuardsHeartbeat(t *testing.T) {
	row := func(status, pending string) *repository.GalaxyContribution {
		return &repository.GalaxyContribution{CID: "n_1:relay_codex", Status: status, PendingStatus: pending}
	}
	cases := []struct {
		name string
		row  *repository.GalaxyContribution
		want bool
	}{
		{"开着的归额度管", row(statusActive, ""), false},
		{"主人暂停的不归额度管", row(statusPaused, ""), true},
		{"主人停掉的不归额度管", row(statusDisabled, ""), true},
		// 排空中的那条状态是 draining，和额度触顶时长得一模一样，
		// 只有 pending 能把「主人要关」和「额度用完了」分开。
		{"等排空的不归额度管", row(statusDraining, statusPaused), true},
		// 额度触顶写的 draining 没有 pending，解除时该由额度那段自己写回 active。
		{"额度触顶的仍归额度管", row(statusDraining, ""), false},
		// 控制面里有、库里已经没有的行（撤销之后快照还没过期）：按「没关」算，
		// 额度那段照旧 —— 它的 UPDATE 落在一个不存在的行上，本来就是空操作。
		{"库里没有的行按没关算", nil, false},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			if got := ownerClosed(item.row); got != item.want {
				t.Fatalf("想要 %v，实际 %v", item.want, got)
			}
		})
	}
}
