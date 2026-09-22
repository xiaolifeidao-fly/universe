package account

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// fakeGuard 一个记在内存里的计数面，用来钉住闸的**判定**。
// 计数本身的语义（窗口不顺延、到期归零）在 redisctl 那边对着真 Redis 测。
type fakeGuard struct {
	counts    map[string]int
	remaining time.Duration
	err       error
	resets    []string
}

func newFakeGuard() *fakeGuard {
	return &fakeGuard{counts: map[string]int{}, remaining: 9 * time.Minute}
}

func (g *fakeGuard) LoginFailures(_ context.Context, key string) (int, time.Duration, error) {
	if g.err != nil {
		return 0, 0, g.err
	}
	return g.counts[key], g.remaining, nil
}

func (g *fakeGuard) LoginFailed(_ context.Context, key string, _ time.Duration) (int, error) {
	if g.err != nil {
		return 0, g.err
	}
	g.counts[key]++
	return g.counts[key], nil
}

func (g *fakeGuard) LoginReset(_ context.Context, key string) error {
	g.resets = append(g.resets, key)
	delete(g.counts, key)
	return nil
}

func guarded(guard LoginGuard) *service {
	return &service{guard: guard, maxLoginFail: 5, maxLoginFailPerIP: 30, loginFailWindow: 15 * time.Minute}
}

// TestLoginKeysSeparateSides 两端是两批人，同名的账号在一端被锁不该连累另一端。
func TestLoginKeysSeparateSides(t *testing.T) {
	provider, _ := loginKeys("provider", "fly", "1.2.3.4")
	consumer, _ := loginKeys("consumer", "fly", "1.2.3.4")
	if provider == consumer {
		t.Fatalf("两端共用了一个计数键（%s）—— 一端被锁会把另一端一起锁上", provider)
	}
	// 来源为空时不该凭空造一个 "…:ip:" 的键：那会把所有取不到地址的请求算成同一台机器。
	if _, ipKey := loginKeys("consumer", "fly", ""); ipKey != "" {
		t.Fatalf("来源为空却生成了键 %q", ipKey)
	}
}

// TestLoginBlockedPerDimension 两维各用各的阈值。
func TestLoginBlockedPerDimension(t *testing.T) {
	ctx := context.Background()
	userKey, ipKey := loginKeys("consumer", "fly", "1.2.3.4")

	guard := newFakeGuard()
	service := guarded(guard)
	guard.counts[userKey] = 4
	if _, blocked := service.loginBlocked(ctx, userKey, ipKey); blocked {
		t.Fatal("差一次到上限就被拦了")
	}
	guard.counts[userKey] = 5
	if _, blocked := service.loginBlocked(ctx, userKey, ipKey); !blocked {
		t.Fatal("到了上限还放行")
	}

	// 来源那一维阈值高得多：一个出口后面可能坐着一屋子人，按账号的阈值去卡
	// 会把整个办公室一起挡在外面。
	guard = newFakeGuard()
	service = guarded(guard)
	guard.counts[ipKey] = 29
	if _, blocked := service.loginBlocked(ctx, userKey, ipKey); blocked {
		t.Fatal("来源那一维用错了阈值 —— 拿账号那一维的 5 去卡了")
	}
	guard.counts[ipKey] = 30
	if _, blocked := service.loginBlocked(ctx, userKey, ipKey); !blocked {
		t.Fatal("来源到了上限还放行")
	}
}

// TestLoginBlockedFailsOpen 判定是单向的：算不出来就放行。
//
// 反过来（读不到就当超限）的话，Redis 抖一下就能把所有人挡在登录页外面 ——
// 而爆破要持续很久才有结果，何况失败照样在往留痕表里落行。
func TestLoginBlockedFailsOpen(t *testing.T) {
	guard := newFakeGuard()
	guard.err = errors.New("redis 不可用")
	service := guarded(guard)
	userKey, ipKey := loginKeys("consumer", "fly", "1.2.3.4")
	if _, blocked := service.loginBlocked(context.Background(), userKey, ipKey); blocked {
		t.Fatal("计数面读不到时把人挡住了")
	}
}

// TestNoGuardMeansNoLimit 没装计数面的装配方（manager-api 只做运营那一半）
// 不该在每次调用上炸开。
func TestNoGuardMeansNoLimit(t *testing.T) {
	service := &service{maxLoginFail: 5, maxLoginFailPerIP: 30}
	if _, blocked := service.loginBlocked(context.Background(), "consumer:u:fly", "consumer:ip:1.2.3.4"); blocked {
		t.Fatal("没有计数面却拦了人")
	}
	service.penalizeLogin(context.Background(), "consumer:u:fly", "consumer:ip:1.2.3.4")
	service.clearLoginFailures(context.Background(), "consumer:u:fly")
}

// TestPenalizeCountsBothDimensions 一次失败两维都要记。
func TestPenalizeCountsBothDimensions(t *testing.T) {
	guard := newFakeGuard()
	service := guarded(guard)
	userKey, ipKey := loginKeys("consumer", "fly", "1.2.3.4")
	service.penalizeLogin(context.Background(), userKey, ipKey)
	if guard.counts[userKey] != 1 || guard.counts[ipKey] != 1 {
		t.Fatalf("两维计数 = %d / %d；want 1 / 1", guard.counts[userKey], guard.counts[ipKey])
	}
}

// TestSuccessKeepsSourceCounter 登录成功只清账号那一维。
//
// 连来源那一维一起清的话，攻击者只要用自己的账号成功登一次，就能把自己在这台
// 机器上累积的失败次数抹掉，来源维度的闸等于不存在。
func TestSuccessKeepsSourceCounter(t *testing.T) {
	guard := newFakeGuard()
	service := guarded(guard)
	userKey, ipKey := loginKeys("consumer", "fly", "1.2.3.4")
	guard.counts[userKey] = 3
	guard.counts[ipKey] = 12

	service.clearLoginFailures(context.Background(), userKey)
	if guard.counts[userKey] != 0 {
		t.Fatalf("账号那一维没清掉：%d", guard.counts[userKey])
	}
	if guard.counts[ipKey] != 12 {
		t.Fatalf("来源那一维被一起清了：%d —— 用自己的账号登一次就能抹掉整台机器的失败记录", guard.counts[ipKey])
	}
}

// TestTooManyAttemptsRoundsUp 剩余时间向上取整。说「还有 1 分钟」而实际还差
// 90 秒的话，用户会在一分钟后再撞一次同样的墙。
func TestTooManyAttemptsRoundsUp(t *testing.T) {
	if got := tooManyAttempts(90 * time.Second).Error(); !strings.Contains(got, "2 分钟") {
		t.Errorf("90 秒应当说成 2 分钟，实际 %q", got)
	}
	// 算不出剩余时间时不说死。
	if got := tooManyAttempts(0).Error(); !strings.Contains(got, "稍后") {
		t.Errorf("剩余时间未知时不该给出具体分钟，实际 %q", got)
	}
	if !errors.Is(tooManyAttempts(time.Minute), ErrTooManyAttempts) {
		t.Error("包装之后认不出哨兵错误了")
	}
}

// TestGuardDefaults 漏配退到有闸的那一边，关掉闸必须是明写的负数。
func TestGuardDefaults(t *testing.T) {
	// 传 nil 数据库：这几条只看构造出来的参数，不碰任何查询。
	accounts := New(nil, Options{}).(*service)
	if accounts.maxLoginFail != defaultMaxLoginFail {
		t.Errorf("账号上限 = %d；want %d", accounts.maxLoginFail, defaultMaxLoginFail)
	}
	if accounts.maxLoginFailPerIP != defaultMaxLoginFail*defaultIPFailFactor {
		t.Errorf("来源上限 = %d；want %d", accounts.maxLoginFailPerIP, defaultMaxLoginFail*defaultIPFailFactor)
	}
	if accounts.loginFailWindow != defaultLoginFailWindow {
		t.Errorf("窗口 = %s；want %s", accounts.loginFailWindow, defaultLoginFailWindow)
	}

	off := New(nil, Options{MaxLoginFail: -1}).(*service)
	if off.maxLoginFail != -1 || off.maxLoginFailPerIP != 0 {
		t.Errorf("填负数应当关掉两维，实际 %d / %d", off.maxLoginFail, off.maxLoginFailPerIP)
	}
	if _, blocked := off.loginBlocked(context.Background(), "consumer:u:fly", "consumer:ip:1.2.3.4"); blocked {
		t.Error("已经关掉的闸还在拦人")
	}
}
