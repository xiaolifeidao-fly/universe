package core

import (
	"context"
	"errors"
	"sync"
	"time"

	"contract"
)

// Exchange 是消费者连接与节点上行的交汇点。
//
// 响应字节不进 Redis（架构 5.3）：消费者的连接落在这个进程，节点的 chunked 上行
// 也打到这个进程，两者在同一个 Session 里直接对拷，背压天然顶回上游 fetch。
// 多实例部署时节点按 next 返回的 streamURL 找到持有连接的那台，交汇点仍在进程内。
type Exchange struct {
	mu       sync.Mutex
	sessions map[string]*Session
}

func NewExchange() *Exchange {
	return &Exchange{sessions: map[string]*Session{}}
}

// ErrConsumerGone 消费者已经走了。节点收到它就该 abort 上游。
var ErrConsumerGone = errors.New("消费者连接已断开")

// ErrNotAttached 没有这个单元的交汇点：单元已经结束，或者落在别的实例上。
var ErrNotAttached = errors.New("单元没有等待中的消费者连接")

// 下面三个是 Hub 自己判定的失败。它们的共同点是「节点那边不会有人来收尾」：
// 节点被 kill、机器断网、Nova 重启，都不会有 stream 的 EOF，也不会有 complete。
// 少了它们，Session.Wait 就只剩「节点写完」和「消费者自己走」两个出口，
// 一条领走了活又消失的节点能让消费者的 SDK 永远转下去。
var (
	// ErrNodeNotAttached 派单之后没有节点在时限内认领上行。
	// 单元还躺在队列里没人领、节点领走之后在打上游的路上挂了，都落在这一条。
	// 首字节还没发出去，所以可改派。
	ErrNodeNotAttached = contract.NewUnitError(contract.ErrorClassNode, contract.CodeNodeOffline, true,
		"节点未在时限内开始回传")
	// ErrNodeVanished 节点心跳断了。
	//
	// retryable 说的是首字节之前那种情形。首字节之后同样会判到这里，
	// 但那时改派由 Session.Started() 挡住 —— 已经流出去的字节收不回来，
	// 换台机器重跑只会让消费者收到两段拼在一起的回答。
	ErrNodeVanished = contract.NewUnitError(contract.ErrorClassNode, contract.CodeNodeOffline, true,
		"节点已失联")
	// ErrUnitDeadline 超过单元的总时限。它是最后一道兜底，不再改派 ——
	// 消费者已经等了一整个 maxRunSec，换台机器重跑只会让他再等一遍。
	ErrUnitDeadline = contract.NewUnitError(contract.ErrorClassNode, contract.CodeLeaseExpired, false,
		"单元已超过最长执行时限")
)

// HubJudged 区分「Hub 自己判定的失败」与「节点报上来的失败」。
// 前者要由通道层补一次 FailUnit：节点侧不会再有终态上报，
// 预留的额度与并发得有人还回去，否则那台机器每失联一次就永久少一个并发位。
func HubJudged(err error) bool {
	return errors.Is(err, ErrNodeNotAttached) || errors.Is(err, ErrNodeVanished) || errors.Is(err, ErrUnitDeadline)
}

type Session struct {
	unitID string
	writer EventWriter

	mu       sync.Mutex
	headSent bool
	closed   bool
	attached bool
	err      error

	done chan struct{}
	// onFirstByte 在首字节写给消费者的那一刻回调，用来把 firstByteAt 落到控制面。
	// 它是失败语义的分水岭，必须在字节真正流出去之后才算数。
	onFirstByte func()
}

// Open 在提交单元之前登记交汇点：节点可能在 Submit 返回之前就把活领走了。
func (e *Exchange) Open(unitID string, writer EventWriter, onFirstByte func()) *Session {
	session := &Session{unitID: unitID, writer: writer, done: make(chan struct{}), onFirstByte: onFirstByte}
	e.mu.Lock()
	e.sessions[unitID] = session
	e.mu.Unlock()
	return session
}

// Attach 节点上行时认领交汇点。一个单元同时只允许一条上行连接。
func (e *Exchange) Attach(unitID string) (*Session, error) {
	e.mu.Lock()
	session, ok := e.sessions[unitID]
	e.mu.Unlock()
	if !ok {
		return nil, ErrNotAttached
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.closed {
		return nil, ErrConsumerGone
	}
	if session.attached {
		return nil, errors.New("该单元已有上行连接")
	}
	session.attached = true
	return session, nil
}

// Has 报告这个单元的交汇点在不在本实例上。
//
// export 派单器靠它判断「节点回流的字节交不交得出去」：交汇点只存在于持有
// 消费者连接的那个进程里。多实例部署下消费者可能连在别的实例上，那种单元
// 这里接不住（见 exportdispatch.push 的说明）。
func (e *Exchange) Has(unitID string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	_, ok := e.sessions[unitID]
	return ok
}

// Release 摘掉交汇点但不判它失败。session / job 的单元跑完之后用它收尾：
// 那时候本来就没有等待中的消费者，Close 的「消费者已断开」语义会把终态写歪。
func (e *Exchange) Release(unitID string) {
	e.mu.Lock()
	delete(e.sessions, unitID)
	e.mu.Unlock()
}

func (e *Exchange) Close(unitID string) {
	e.mu.Lock()
	session, ok := e.sessions[unitID]
	delete(e.sessions, unitID)
	e.mu.Unlock()
	if ok {
		session.Finish(ErrConsumerGone)
	}
}

// Head 把上游状态码与白名单头写给消费者。只有第一次生效。
func (s *Session) Head(status int, headers map[string]string) {
	s.mu.Lock()
	if s.headSent || s.closed {
		s.mu.Unlock()
		return
	}
	s.headSent = true
	callback := s.onFirstByte
	s.mu.Unlock()
	s.writer.Head(status, headers)
	if callback != nil {
		callback()
	}
}

// Write 把一段上游字节对拷给消费者。消费者已经走了就返回 ErrConsumerGone，
// 节点据此立即 abort 上游 fetch，不再烧提供者的额度。
func (s *Session) Write(chunk []byte) error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return ErrConsumerGone
	}
	s.mu.Unlock()
	if err := s.writer.Write(chunk); err != nil {
		s.Finish(err)
		return ErrConsumerGone
	}
	return nil
}

// Finish 结束这次交汇。err 为 nil 表示节点正常写完。
func (s *Session) Finish(err error) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	s.err = err
	s.mu.Unlock()
	if err != nil {
		s.writer.Abort(err)
	} else {
		s.writer.End()
	}
	close(s.done)
}

// WaitOptions 是消费者侧等待的时限。零值一律表示「不设这道限」，
// session / job 的交汇点不跟着消费者连接走，用的就是零值。
type WaitOptions struct {
	// AttachTimeout 节点认领上行的最长等待，从放置之后算起。
	// 到点还没人认领就判 ErrNodeNotAttached —— 那说明单元要么还在队列里没人领，
	// 要么领它的节点已经不在了。认领之后这道限就作废，接力给上行的空闲看门狗。
	AttachTimeout time.Duration
	// Deadline 单元的总时限（contract.WorkUnit.Deadline，即 kind 的 maxRunSec）。
	Deadline time.Time
	// Alive 探测承接这次请求的贡献还在不在线。整个等待期间都有效。
	//
	// 它和上行连接上的读是两条独立的证据，谁先发现算谁：进程被 kill 时
	// TCP 立刻报错，比心跳快得多；而断电、拔网线、休眠这类走法根本不产生
	// FIN，连接就那么半开着 —— 那时候上行的读是最慢的一条，反倒要靠心跳。
	// 早先这道探测在首字节之后就停了，等于在最需要它的场景里把它关掉。
	Alive func() bool
	// AliveInterval 探测间隔。Alive 为空时无意义。
	AliveInterval time.Duration
}

// Wait 消费者侧在这里等节点把响应写完。ctx 结束表示消费者自己断开了。
//
// 除此之外还有三个出口，都是为了同一件事：节点消失时不要让消费者干等。
// 它们只负责把这个交汇点收掉并交出原因，改派与结算的决定留给通道层。
func (s *Session) Wait(ctx context.Context, options WaitOptions) error {
	var attach, expire, probe <-chan time.Time
	if options.AttachTimeout > 0 {
		timer := time.NewTimer(options.AttachTimeout)
		defer timer.Stop()
		attach = timer.C
	}
	if !options.Deadline.IsZero() {
		timer := time.NewTimer(time.Until(options.Deadline))
		defer timer.Stop()
		expire = timer.C
	}
	if options.Alive != nil && options.AliveInterval > 0 {
		ticker := time.NewTicker(options.AliveInterval)
		defer ticker.Stop()
		probe = ticker.C
	}
	for {
		select {
		case <-s.done:
			s.mu.Lock()
			defer s.mu.Unlock()
			return s.err
		case <-ctx.Done():
			return ctx.Err()
		case <-attach:
			// 只判这一次：认领了就交给上行的看门狗，没认领就到此为止。
			attach = nil
			if !s.Attached() {
				s.Finish(ErrNodeNotAttached)
			}
		case <-expire:
			expire = nil
			s.Finish(ErrUnitDeadline)
		case <-probe:
			// 首字节之后也照探。上行的空闲看门狗要等满一个静默窗口才动手，
			// 而心跳这边在机器失联的那一刻就知道了。
			if !options.Alive() {
				s.Finish(ErrNodeVanished)
			}
		}
	}
}

// Attached 报告节点是否已经认领上行。
func (s *Session) Attached() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.attached
}

// Started 报告首字节是否已经发出。它决定失败时能不能改派。
func (s *Session) Started() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.headSent
}

func (s *Session) Usage() contract.Metering { return s.writer.Usage() }

// Signature 交出写回器算出的结构签名，供抽检比对。
func (s *Session) Signature() string {
	if signing, ok := s.writer.(Signing); ok {
		return signing.Signature()
	}
	return ""
}
