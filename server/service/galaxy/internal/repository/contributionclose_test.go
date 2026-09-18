package repository

import (
	"context"
	"strings"
	"testing"
)

// TestSetContributionStatusClearsPending 盯住「落状态时必须把意图一起清掉」。
//
// 清不掉的后果不会当场出现：主人关掉、等排空落地，过一会儿又把共享打开，
// 然后下一次在途归零时，那条陈年意图把刚开的共享又关了一次 —— 而他什么都没点。
//
// 之所以要专门测，是因为这里踩的是 GORM 的一个真实差异：Updates 传结构体时
// 零值（空串）会被整个省掉，只有传 map 才真的写下去。写法一改就静静地失效。
func TestSetContributionStatusClearsPending(t *testing.T) {
	repository, pool := recordingRepository(t)
	if err := repository.SetContributionStatus(context.Background(), "galaxy", "n_1:relay_codex", "paused"); err != nil {
		t.Fatalf("set status: %v", err)
	}
	statement := lastStatement(t, pool)
	for _, want := range []string{"UPDATE `zt_galaxy_contribution`", "`pending_status`", "`status`", "paused"} {
		if !strings.Contains(statement, want) {
			t.Fatalf("落状态要同时清掉意图，缺了 %s：%s", want, statement)
		}
	}
}

// TestSetContributionPendingLeavesStatusAlone 记意图时**不能**顺手改 status。
//
// status 这时候由调用方写成 draining（停止接新单、在跑的正常跑完）。这里再写一次
// 目标状态，就等于跳过排空直接关掉 —— 在跑的请求当场断线，而主人并没有选强制。
func TestSetContributionPendingLeavesStatusAlone(t *testing.T) {
	repository, pool := recordingRepository(t)
	if err := repository.SetContributionPending(context.Background(), "galaxy", "n_1:relay_codex", "disabled"); err != nil {
		t.Fatalf("set pending: %v", err)
	}
	statement := lastStatement(t, pool)
	if !strings.Contains(statement, "`pending_status`") || !strings.Contains(statement, "disabled") {
		t.Fatalf("要写下意图：%s", statement)
	}
	if strings.Contains(statement, "SET `status`") || strings.Contains(statement, "`status`=") {
		t.Fatalf("记意图不该动 status：%s", statement)
	}
}

// TestListLiveUnitsCoversEveryRunningState 强制关闭要取消的是**全部**还没到终态的单元。
//
// 漏掉任何一个状态，那几条就会一直挂在消费者那头直到自己超时 —— 而主人已经看到
// 「已关闭」，还为此扣了信誉分。queued 不在其中：它还没落到任何一条贡献上。
func TestListLiveUnitsCoversEveryRunningState(t *testing.T) {
	// 查询要用会抄下 SELECT 的那个池子：普通录制池只记写语句。
	repository, pool := queryRecordingRepository(t)
	_, _ = repository.ListLiveUnitsByContribution(context.Background(), "galaxy", "n_1:relay_codex", 200)
	statement := lastStatement(t, &pool.recordingPool)
	for _, want := range []string{"placed", "running", "streaming", "n_1:relay_codex", "galaxy"} {
		if !strings.Contains(statement, want) {
			t.Fatalf("在途查询缺了 %s：%s", want, statement)
		}
	}
	if strings.Contains(statement, "queued") {
		t.Fatalf("排队中的单元还没落到这条贡献上，不该被它取消：%s", statement)
	}
}
