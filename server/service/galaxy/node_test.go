package galaxy

import (
	"testing"

	"service/galaxy/internal/repository"
)

// TestFirstOnlineNodeGuardsPairing 盯的是配对闸的判断本身：放宽了就能在一台机器
// 已经在跑的时候再配一台，收紧了则主人撤销之后再也配不回来 —— 两种都是死路。
func TestFirstOnlineNodeGuardsPairing(t *testing.T) {
	node := func(id, status string, banned bool) *repository.GalaxyNode {
		return &repository.GalaxyNode{NodeID: id, Status: status, Banned: banned}
	}
	cases := []struct {
		name  string
		nodes []*repository.GalaxyNode
		want  string
	}{
		{"一台都没有就是没在线", nil, ""},
		{"在线的挡住配对", []*repository.GalaxyNode{node("n_a", "active", false)}, "n_a"},
		{"离线的挡不住", []*repository.GalaxyNode{node("n_a", "offline", false)}, ""},
		{"撤销的挡不住", []*repository.GalaxyNode{node("n_a", "revoked", false)}, ""},
		// 封禁的机器接不了活，拿它挡住配对等于把主人锁死在一台没用的机器上。
		{"封禁的不算在线", []*repository.GalaxyNode{node("n_a", "active", true)}, ""},
		{"混着的挑出在线那台", []*repository.GalaxyNode{
			node("n_a", "offline", false), node("n_b", "active", true), node("n_c", "active", false),
		}, "n_c"},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			got := firstOnlineNode(item.nodes)
			if item.want == "" {
				if got != nil {
					t.Fatalf("不该判为在线，实际挑出了 %s", got.NodeID)
				}
				return
			}
			if got == nil {
				t.Fatalf("应该挑出 %s，实际一台都没挑出来", item.want)
			}
			if got.NodeID != item.want {
				t.Fatalf("应该挑出 %s，实际是 %s", item.want, got.NodeID)
			}
		})
	}
}
