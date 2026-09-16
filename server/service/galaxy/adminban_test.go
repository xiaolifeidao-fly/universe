package galaxy

import (
	"context"
	"database/sql/driver"
	"strings"
	"testing"

	"service/galaxy/dto"
)

// 封禁名单的解封是按**指纹**走的，机器在不在册都办得了 —— 这正是它存在的理由。
// 但同一个「不认 node_id」也意味着它少了一道天然的保护：BanNode 至少要先找到一台机器，
// 而这里只要一个字符串。空串是最危险的那个字符串。

// TestBanMachineRefusesAnEmptyFingerprint 空指纹会匹配上所有没报过指纹的老节点，
// 一次封禁就成了全池封禁。
func TestBanMachineRefusesAnEmptyFingerprint(t *testing.T) {
	svc, db, plane := banHarness(t, nil)
	for _, fingerprint := range []string{"", "   "} {
		if err := svc.BanMachine(context.Background(), dto.BanMachineRequest{
			Fingerprint: fingerprint, Banned: true, Reason: "误操作",
		}); err == nil {
			t.Fatalf("指纹 %q 应当被拒", fingerprint)
		}
	}
	if len(db.writes) > 0 {
		t.Fatalf("被拒的请求不该写任何一行，实际写了 %v", db.writes)
	}
	if len(plane.dropped) > 0 {
		t.Fatal("被拒的请求不该碰控制面")
	}
}

// TestBanMachineDropsEveryNodeOnThatDevice 封禁要把这台设备名下还活着的节点
// 逐台从控制面摘掉。
//
// 少了这一步，被封的机器当下还在接单，而且 Hub 下次重启会把它连人带贡献装回池子 ——
// 管理端上写着「已封禁」，池水位里它照常在。
func TestBanMachineDropsEveryNodeOnThatDevice(t *testing.T) {
	svc, db, plane := banHarness(t, map[string]scriptedTable{
		"zt_galaxy_node": {columns: []string{"node_id"}, rows: [][]driver.Value{{"n_one"}, {"n_two"}}},
	})
	if err := svc.BanMachine(context.Background(), dto.BanMachineRequest{
		Fingerprint: "fp_abc", Banned: true, Reason: "抽检判定伪造", UpdatedBy: "mu_admin",
	}); err != nil {
		t.Fatalf("封禁应当成功：%v", err)
	}
	if db.writeIndex("zt_galaxy_machine_ban") < 0 {
		t.Error("要先在封禁表上记下这个指纹")
	}
	if len(plane.dropped) != 2 {
		t.Fatalf("这台设备上的两条节点记录都要摘掉，实际摘了 %v", plane.dropped)
	}
}

// TestBanMachineLiftDoesNotTouchTheControlPlane 解封只改库，不碰控制面。
//
// 被封的机器早就被摘干净了，此刻控制面里没有它 —— 解封要做的只是「下次它连上来
// 别再被拦」。在这里去 DropNode 一台本来就不在的机器，是一次没有意义的调用，
// 而且会把「解封」写进摘除日志里，之后查起来像是解封反而把它踢了。
func TestBanMachineLiftDoesNotTouchTheControlPlane(t *testing.T) {
	svc, db, plane := banHarness(t, map[string]scriptedTable{
		"zt_galaxy_node": {columns: []string{"node_id"}, rows: [][]driver.Value{{"n_one"}}},
	})
	if err := svc.BanMachine(context.Background(), dto.BanMachineRequest{
		Fingerprint: "fp_abc", Banned: false, Reason: "核实为探针误判", UpdatedBy: "mu_admin",
	}); err != nil {
		t.Fatalf("解封应当成功：%v", err)
	}
	if index := db.writeIndex("zt_galaxy_machine_ban"); index < 0 {
		t.Fatal("解封要把封禁表上那一行改回 false，而不是删掉它")
	}
	if len(plane.dropped) > 0 {
		t.Fatalf("解封不该摘节点，实际摘了 %v", plane.dropped)
	}
}

// TestBanMachineRecordsWhoAndWhy 封禁与解封都要留痕：名单上那一行只记最近一次操作，
// 而下一个来查「这台机器为什么连不上」的人，看的就是它。
func TestBanMachineRecordsWhoAndWhy(t *testing.T) {
	svc, db, _ := banHarness(t, nil)
	if err := svc.BanMachine(context.Background(), dto.BanMachineRequest{
		Fingerprint: "fp_abc", Banned: true, Reason: "抽检判定伪造响应", UpdatedBy: "mu_admin",
	}); err != nil {
		t.Fatalf("封禁应当成功：%v", err)
	}
	index := db.writeIndex("zt_galaxy_machine_ban")
	if index < 0 {
		t.Fatal("没有写封禁表")
	}
	written := db.writes[index]
	if !strings.Contains(written, "抽检判定伪造响应") || !strings.Contains(written, "mu_admin") {
		t.Fatalf("原因与操作人都要落库，实际写的是 %s", written)
	}
}
