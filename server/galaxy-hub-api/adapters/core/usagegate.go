package core

import (
	"context"
	"sync"
	"time"
)

// DefaultUsageWait 节点报终态时，最多等本进程交出 Hub 侧用量多久。
//
// 要盖住的是「读到 EOF → 解析 → markProbeReady 的一次 MySQL 查询 → 写 Redis」这一段，
// 正常是几十毫秒。给到秒级是为了 RDS 抖一下也不至于漏记，而不是给慢上游留余地 ——
// 等这道闸的时候字节早就写完了，多等的只是节点那条 complete 请求的往返。
const DefaultUsageWait = 3 * time.Second

// UsageGate 让「节点报终态」排在「Hub 交出自己解析到的用量」之后。
//
// 结算只认 Hub 从透传字节里自己解析的用量（service/galaxy 的 reconcileUsage），
// 而那份用量要等对拷收尾才写进控制面。poll 模式下这个先后由 HTTP 天然保证：
// 节点要拿到 /units/:id/stream 的 200 才会去报 complete，而 Hub 在返回 200 之前
// 已经 RecordHubResult 过了。
//
// export 模式没有这层保证 —— 字节走在 Hub 发起的回连的响应体里，节点写完最后一个
// 字节、handler 一返回就直接报 complete，根本不知道 Hub 读没读完。结果是 complete
// 抢先结算，reconcileUsage 读到一份空的 hubUsage，token、积分、额度 used 全部记 0。
// 这个漏法还特别安静：hubUsage 和节点自报同时缺席时走的是「两边都没有」那个分支，
// 连 usage_parse_failed 的留痕都不会写，三层都不报错。
//
// 闸门只在本进程内有效，这正好够用：回流的字节只交给持有消费者连接的那个进程，
// export 本来就只支持单实例（见 exportdispatch 的包注释）。落在别的实例上的单元
// 这里查无此闸，complete 照常直接走 —— 那种单元本来也没有 Hub 侧用量可等。
type UsageGate struct {
	mu    sync.Mutex
	waits map[string]chan struct{}
}

func NewUsageGate() *UsageGate {
	return &UsageGate{waits: map[string]chan struct{}{}}
}

// Arm 宣告「这个单元的用量由本进程解析，马上就会交出去」，返回开闸的函数。
//
// 交出用量的那条路径必须 defer 住返回值：对拷中途断掉、消费者提前走人这些路径
// 一个都不能漏，漏一条的表现是那个单元的 complete 白等满一个 DefaultUsageWait。
// 返回的函数可以重复调用，第二次起是空操作。
func (g *UsageGate) Arm(unitID string) (release func()) {
	if g == nil || unitID == "" {
		return func() {}
	}
	wait := make(chan struct{})
	g.mu.Lock()
	previous, occupied := g.waits[unitID]
	g.waits[unitID] = wait
	g.mu.Unlock()
	if occupied {
		// 一个单元同时两条上行是协议错误，交汇点那边已经挡住了（Attach 只放一条进来）。
		// 真走到这里就把旧的那道闸放掉，不能让它把一个 complete 吊到超时。
		close(previous)
	}
	return func() {
		g.mu.Lock()
		current, found := g.waits[unitID]
		mine := found && current == wait
		if mine {
			delete(g.waits, unitID)
		}
		g.mu.Unlock()
		if mine {
			close(wait)
		}
	}
}

// Wait 等这个单元开闸，最多等 timeout；返回是否等到。
//
// 没登记过就立刻返回 true：「没人会为这个单元交用量」和「已经交完了」在这里
// 是同一件事，两种都不该等。等超时也照常放行 —— 宁可漏记一次用量，
// 也不能把节点的终态卡死在 Hub 里，那会让整台机器的并发位一直不还。
func (g *UsageGate) Wait(ctx context.Context, unitID string, timeout time.Duration) bool {
	if g == nil || unitID == "" {
		return true
	}
	g.mu.Lock()
	wait, armed := g.waits[unitID]
	g.mu.Unlock()
	if !armed {
		return true
	}
	if timeout <= 0 {
		timeout = DefaultUsageWait
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-wait:
		return true
	case <-timer.C:
		return false
	case <-ctx.Done():
		return false
	}
}
