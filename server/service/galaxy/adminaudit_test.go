package galaxy

import (
	"context"
	"database/sql/driver"
	"testing"

	"service/galaxy/dto"
)

// TestAdminCancelUnitRefusesAFinishedOne 已经到终态的工单取消不了。
//
// 放过去的不是报错，是在事件流上留下一条「cancel_requested」——
// 之后查这条工单的人会看成「它是被运营取消的」，而它其实是自己跑完的。
func TestAdminCancelUnitRefusesAFinishedOne(t *testing.T) {
	for _, state := range []string{"completed", "failed", "cancelled", "expired"} {
		svc, db, plane := banHarness(t, map[string]scriptedTable{
			"zt_galaxy_unit": unitRows(state),
		})
		err := svc.AdminCancelUnit(context.Background(), dto.CancelUnitRequest{
			UnitID: "u_1", Reason: "卡住了", CancelledBy: "mu_admin",
		})
		if err == nil {
			t.Fatalf("状态为 %s 的工单不该还能取消", state)
		}
		if db.writeIndex("zt_galaxy_unit_event") >= 0 {
			t.Fatalf("状态为 %s 时不该往事件流里写取消记录", state)
		}
		if len(plane.cancelled) > 0 {
			t.Fatalf("状态为 %s 时不该碰控制面", state)
		}
	}
}

// TestAdminCancelUnitRefusesAnEmptyID 空单号会一路走到控制面，
// 在那里写一个谁也对不上的取消键。
func TestAdminCancelUnitRefusesAnEmptyID(t *testing.T) {
	svc, _, plane := banHarness(t, nil)
	if err := svc.AdminCancelUnit(context.Background(), dto.CancelUnitRequest{UnitID: "  "}); err == nil {
		t.Fatal("空单号应当被拒")
	}
	if len(plane.cancelled) > 0 {
		t.Fatal("被拒的请求不该碰控制面")
	}
}

// TestAdminCancelUnitLeavesATrailBeforeItActs 留痕先于动作。
//
// 反过来的话，控制面写成功而事件没记上，之后没人说得清这条是被谁取消的 ——
// 而「运营手动中止」和「节点自己断了」在事后是两件完全不同的事。
func TestAdminCancelUnitLeavesATrailBeforeItActs(t *testing.T) {
	svc, db, plane := banHarness(t, map[string]scriptedTable{
		"zt_galaxy_unit": unitRows("running"),
	})
	if err := svc.AdminCancelUnit(context.Background(), dto.CancelUnitRequest{
		UnitID: "u_1", Reason: "卡住超过十分钟", CancelledBy: "mu_admin",
	}); err != nil {
		t.Fatalf("取消应当成功：%v", err)
	}
	index := db.writeIndex("zt_galaxy_unit_event", "cancel_requested")
	if index < 0 {
		t.Fatal("要在事件流上留一笔谁取消的、为什么")
	}
	if len(plane.cancelled) != 1 || plane.cancelled[0] != "u_1" {
		t.Fatalf("取消标记要写进控制面，实际 %v", plane.cancelled)
	}
}

// unitRows 工单表的一行，列依次是 unitId、状态。
func unitRows(state string) scriptedTable {
	return scriptedTable{
		columns: []string{"unit_id", "state"},
		rows:    [][]driver.Value{{"u_1", state}},
	}
}
