package core

import (
	"context"
	"testing"
	"time"
)

// 这道闸守的是一个真实事故：export 接入的机器跑了一周，每一笔 token 都记成 0。
// 字节、解析、Redis 全是对的，错的只是先后 —— 节点的 complete 跑赢了 Hub 写用量。

func TestWaitReturnsAtOnceWhenNobodyWillHandInUsage(t *testing.T) {
	gate := NewUsageGate()
	started := time.Now()
	if !gate.Wait(context.Background(), "u_1", time.Second) {
		t.Fatal("没登记过的单元不该等")
	}
	if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
		t.Fatalf("没登记过的单元等了 %v", elapsed)
	}
}

func TestWaitBlocksUntilUsageIsHandedIn(t *testing.T) {
	gate := NewUsageGate()
	release := gate.Arm("u_1")

	handed := make(chan struct{})
	go func() {
		time.Sleep(50 * time.Millisecond)
		close(handed)
		release()
	}()

	if !gate.Wait(context.Background(), "u_1", time.Second) {
		t.Fatal("开闸之后该等到")
	}
	select {
	case <-handed:
	default:
		t.Fatal("Wait 在用量交出之前就放行了 —— 结算会读到一份空的 hubUsage")
	}
	// 开过的闸不再拦人：迟到的重复终态不该白等一个超时。
	if !gate.Wait(context.Background(), "u_1", 50*time.Millisecond) {
		t.Fatal("开过闸的单元不该再等")
	}
}

// 等不到也必须放行。卡住一条 complete 的代价是那台机器的并发位一直不还，
// 比漏记一次用量严重得多。
func TestWaitGivesUpSoTheNodeIsNeverStuck(t *testing.T) {
	gate := NewUsageGate()
	defer gate.Arm("u_1")()

	started := time.Now()
	if gate.Wait(context.Background(), "u_1", 60*time.Millisecond) {
		t.Fatal("没人开闸时该报「没等到」，让调用方记一笔指标")
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("超时没生效，等了 %v", elapsed)
	}
}

func TestWaitGivesUpWhenTheNodeHangsUp(t *testing.T) {
	gate := NewUsageGate()
	defer gate.Arm("u_1")()

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(30 * time.Millisecond)
		cancel()
	}()
	if gate.Wait(ctx, "u_1", time.Minute) {
		t.Fatal("请求都没了还等下去，等于把一条 goroutine 挂满一分钟")
	}
}

// 交出用量的那条路径要 defer 住 release，中途 return 的分支一个都不能漏。
// 重复调用是空操作，这样 defer 和显式调用并存也不会 panic。
func TestReleaseIsIdempotent(t *testing.T) {
	gate := NewUsageGate()
	release := gate.Arm("u_1")
	release()
	release()
}

// 一个单元同时两条上行是协议错误，交汇点那边挡着。真漏进来了也不能让旧闸
// 永远关着 —— 那会把一条 complete 吊到超时。
func TestRearmingReleasesTheStaleGate(t *testing.T) {
	gate := NewUsageGate()
	first := gate.Arm("u_1")
	second := gate.Arm("u_1")

	if gate.Wait(context.Background(), "u_1", 60*time.Millisecond) {
		t.Fatal("新闸还关着，不该放行")
	}
	second()
	if !gate.Wait(context.Background(), "u_1", time.Second) {
		t.Fatal("新闸开了就该放行")
	}
	// 旧的那个 release 迟到了也不能把新登记的闸删掉。
	first()
	if !gate.Wait(context.Background(), "u_1", 60*time.Millisecond) {
		t.Fatal("迟到的旧 release 不该影响已经开过的闸")
	}
}
