package galaxy

import (
	"testing"

	"service/galaxy/internal/repository"
)

// TestMissingFromControlPlane 盯的是心跳里那道自愈检查的判据。
//
// 它要同时挡住两种错法，而两种都是静默的：
//
//   - 漏报：贡献的哈希只有 45 秒 TTL，Hub 停久一点它就没了，而心跳按设计
//     不会把它 HSET 回来。漏报的表现是机器一直在线、控制台一直显示共享中，
//     消费者那边却一路 no_capacity —— 没人会想到去看 Redis。
//   - 多报：把根本不该下发的行（主人停掉的、本机不可用的）算成「缺了」，
//     每个心跳都会触发一次全量重建，而重建完它们照样不在，下一拍接着来。
//     15 秒一次的空转，功能上看不出任何异常。
func TestMissingFromControlPlane(t *testing.T) {
	row := func(cid, status string, available bool) *repository.GalaxyContribution {
		return &repository.GalaxyContribution{CID: cid, Status: status, Available: available}
	}
	snapshot := func(cid string) ContributionSnapshot { return ContributionSnapshot{CID: cid} }
	cases := []struct {
		name      string
		rows      []*repository.GalaxyContribution
		snapshots []ContributionSnapshot
		want      []string
	}{
		{
			name:      "都在就不重建",
			rows:      []*repository.GalaxyContribution{row("n_1:relay_codex", statusActive, true)},
			snapshots: []ContributionSnapshot{snapshot("n_1:relay_codex")},
		},
		{
			name: "哈希过期了要报出来",
			rows: []*repository.GalaxyContribution{row("n_1:relay_codex", statusActive, true)},
			want: []string{"n_1:relay_codex"},
		},
		// 同一台机器上的贡献不一定同生同死：主人新开的那条是单独推进控制面的，
		// 和别的不在同一个 TTL 节拍上。所以比的是集合，不是条数。
		{
			name: "只缺一条也要报，且只报缺的那条",
			rows: []*repository.GalaxyContribution{
				row("n_1:relay_claude", statusActive, true),
				row("n_1:relay_codex", statusActive, true),
			},
			snapshots: []ContributionSnapshot{snapshot("n_1:relay_claude")},
			want:      []string{"n_1:relay_codex"},
		},
		// 主人暂停的照样得在控制面里：放置端是靠 draining 标记把它挡掉的，
		// 不是靠它不存在。少了它，「暂停」和「掉线」在池子里就分不开了。
		{
			name: "主人暂停的也算缺",
			rows: []*repository.GalaxyContribution{row("n_1:relay_codex", statusPaused, true)},
			want: []string{"n_1:relay_codex"},
		},
		// 下面两条是「本来就不该在控制面里」，报了就是每 15 秒空转一次重建。
		{
			name: "主人停掉的不算缺",
			rows: []*repository.GalaxyContribution{row("n_1:relay_codex", statusDisabled, true)},
		},
		{
			name: "本机不可用的不算缺",
			rows: []*repository.GalaxyContribution{row("n_1:relay_claude", statusActive, false)},
		},
		// 撤销之后库里的行没了、控制面的快照还没过期：多出来的那条不归这里管，
		// 它自己会在 45 秒内消失。
		{
			name:      "控制面里多出来的不管",
			snapshots: []ContributionSnapshot{snapshot("n_1:relay_codex")},
		},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			got := missingFromControlPlane(item.rows, item.snapshots)
			if len(got) != len(item.want) {
				t.Fatalf("想要 %v，实际 %v", item.want, got)
			}
			for index, cid := range item.want {
				if got[index] != cid {
					t.Fatalf("想要 %v，实际 %v", item.want, got)
				}
			}
		})
	}
}
