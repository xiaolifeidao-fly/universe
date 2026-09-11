package galaxy

import (
	"testing"

	"service/galaxy/internal/repository"
)

// TestPairedOnlineGuardsPairing 盯的是配对闸的判断本身：同一台电脑只能配对一次。
//
// 放宽了，同一台电脑在线时还能再配出一条节点；收紧了，要么撤销之后配不回来，
// 要么名下别的机器在线就挡住这台电脑 —— 后者正是这条闸改写之前的样子。
// 别的机器根本不进这个判断：入参只有这台电脑上一次配出来的那个节点。
func TestPairedOnlineGuardsPairing(t *testing.T) {
	node := func(owner, status string, banned bool) *repository.GalaxyNode {
		return &repository.GalaxyNode{NodeID: "n_prev", OwnerUserID: owner, Status: status, Banned: banned}
	}
	cases := []struct {
		name     string
		previous *repository.GalaxyNode
		blocked  bool
	}{
		{"没配过的电脑放行", nil, false},
		{"上一次的还在线就挡住", node("u1", "active", false), true},
		// 令牌被拒、库重建过的电脑回来重配是最常见的情形，配成之后旧的那条会被退役。
		{"上一次的已离线放行", node("u1", "offline", false), false},
		{"在控制台解绑过的放行", node("u1", "revoked", false), false},
		// 封禁的节点接不了活，拿它挡住配对等于把主人锁死在一条没用的记录上。
		{"封禁的不算在线", node("u1", "active", true), false},
		// previousNodeId 是客户端传的，只认同一个主人。
		{"别的主人名下的不算", node("u2", "active", false), false},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			got := pairedOnline(item.previous, "u1")
			if item.blocked && got == nil {
				t.Fatal("应该挡住配对，实际放行了")
			}
			if !item.blocked && got != nil {
				t.Fatalf("应该放行，实际被 %s 挡住了", got.NodeID)
			}
		})
	}
}
