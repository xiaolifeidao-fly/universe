package manager

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// fakeGuard 一个记在内存里的计数面，用来钉住闸的**判定**。计数本身的语义
// （窗口不顺延、到期归零）在 manager-api/pkg/tokenstore 那边对着真 Redis 测。
type fakeGuard struct {
	counts    map[string]int
	remaining time.Duration
	err       error
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
	delete(g.counts, key)
	return nil
}

func guarded(guard LoginGuard) *service {
	return &service{guard: guard, config: Config{}.withDefaults()}
}

// TestLoginFailDefaults 漏配退到**有闸**的那一边。
//
// 这是这次改动里唯一一处改了既有语义的地方：`MaxLoginFail` 从前的注释写着
// 「0 表示不限制」，而这个字段从来没被读过，所以不存在依赖它的存量行为。
// 管理端的每一个写接口都动真数据，一个漏配的部署不该是没有闸的那个。
func TestLoginFailDefaults(t *testing.T) {
	config := Config{}.withDefaults()
	if config.MaxLoginFail != defaultMaxLoginFail {
		t.Errorf("账号上限 = %d；want %d", config.MaxLoginFail, defaultMaxLoginFail)
	}
	if config.MaxLoginFailPerIP != defaultMaxLoginFail*ipFailFactor {
		t.Errorf("来源上限 = %d；want %d", config.MaxLoginFailPerIP, defaultMaxLoginFail*ipFailFactor)
	}
	if config.LoginFailWindow != defaultLoginFailWindow {
		t.Errorf("窗口 = %s；want %s", config.LoginFailWindow, defaultLoginFailWindow)
	}

	// 关掉闸只能靠明写的负数，而且不该被「派生来源上限」那一步又打开。
	off := Config{MaxLoginFail: -1}.withDefaults()
	if off.MaxLoginFail != -1 || off.MaxLoginFailPerIP != 0 {
		t.Errorf("填负数应当关掉两维，实际 %d / %d", off.MaxLoginFail, off.MaxLoginFailPerIP)
	}
}

// TestLoginKeysSplitDimensions 账号与来源是两个键，来源取不到时不造空键 ——
// 那会把所有取不到地址的请求算成同一台机器。
func TestLoginKeysSplitDimensions(t *testing.T) {
	userKey, ipKey := loginKeys("admin", "1.2.3.4")
	if userKey == ipKey || userKey == "" || ipKey == "" {
		t.Fatalf("两维的键不该相同或为空：%q / %q", userKey, ipKey)
	}
	if _, empty := loginKeys("admin", ""); empty != "" {
		t.Fatalf("来源为空却生成了键 %q", empty)
	}
}

// TestLoginBlockedPerDimension 两维各用各的阈值。
func TestLoginBlockedPerDimension(t *testing.T) {
	ctx := context.Background()
	userKey, ipKey := loginKeys("admin", "1.2.3.4")

	guard := newFakeGuard()
	service := guarded(guard)
	guard.counts[userKey] = defaultMaxLoginFail - 1
	if _, blocked := service.loginBlocked(ctx, userKey, ipKey); blocked {
		t.Fatal("差一次到上限就被拦了")
	}
	guard.counts[userKey] = defaultMaxLoginFail
	if _, blocked := service.loginBlocked(ctx, userKey, ipKey); !blocked {
		t.Fatal("到了上限还放行")
	}

	guard = newFakeGuard()
	service = guarded(guard)
	guard.counts[ipKey] = defaultMaxLoginFail
	if _, blocked := service.loginBlocked(ctx, userKey, ipKey); blocked {
		t.Fatal("来源那一维用错了阈值 —— 拿账号那一维的去卡了")
	}
	guard.counts[ipKey] = defaultMaxLoginFail * ipFailFactor
	if _, blocked := service.loginBlocked(ctx, userKey, ipKey); !blocked {
		t.Fatal("来源到了上限还放行")
	}
}

// TestLoginBlockedFailsOpen 判定单向：算不出来就放行。
//
// 注意这和 Authorize 里「存储不可用就拒绝」是两件事：那边拒的是一张已经签发的
// 令牌，宁可让人重登一次；这边拒的是所有人的登录入口，而 Redis 真挂了的话，
// 后面那句 tokens.Save 本来就会失败，这次登录照样成不了。
func TestLoginBlockedFailsOpen(t *testing.T) {
	guard := newFakeGuard()
	guard.err = errors.New("redis 不可用")
	userKey, ipKey := loginKeys("admin", "1.2.3.4")
	if _, blocked := guarded(guard).loginBlocked(context.Background(), userKey, ipKey); blocked {
		t.Fatal("计数面读不到时把人挡住了")
	}
}

// TestSuccessKeepsSourceCounter 登录成功只清账号那一维：连来源一起清的话，
// 攻击者用自己的账号成功登一次就能抹掉整台机器的失败记录。
func TestSuccessKeepsSourceCounter(t *testing.T) {
	guard := newFakeGuard()
	service := guarded(guard)
	userKey, ipKey := loginKeys("admin", "1.2.3.4")
	service.penalizeLogin(context.Background(), userKey, ipKey)
	service.clearLoginFailures(context.Background(), userKey)
	if guard.counts[userKey] != 0 {
		t.Fatalf("账号那一维没清掉：%d", guard.counts[userKey])
	}
	if guard.counts[ipKey] != 1 {
		t.Fatalf("来源那一维被一起清了：%d", guard.counts[ipKey])
	}
}

// TestNoGuardMeansNoLimit 没装计数面时（只出现在不走登录路径的测试里）不该炸。
func TestNoGuardMeansNoLimit(t *testing.T) {
	service := &service{config: Config{}.withDefaults()}
	if _, blocked := service.loginBlocked(context.Background(), "u:admin", "ip:1.2.3.4"); blocked {
		t.Fatal("没有计数面却拦了人")
	}
	service.penalizeLogin(context.Background(), "u:admin", "ip:1.2.3.4")
	service.clearLoginFailures(context.Background(), "u:admin")
}

// TestLockedUntilRoundsUp 剩余时间向上取整，且包装之后仍认得出哨兵错误。
func TestLockedUntilRoundsUp(t *testing.T) {
	if got := lockedUntil(90 * time.Second).Error(); !strings.Contains(got, "2 分钟") {
		t.Errorf("90 秒应当说成 2 分钟，实际 %q", got)
	}
	if got := lockedUntil(0).Error(); !strings.Contains(got, "稍后") {
		t.Errorf("剩余时间未知时不该给出具体分钟，实际 %q", got)
	}
	if !errors.Is(lockedUntil(time.Minute), ErrLoginLocked) {
		t.Error("包装之后认不出哨兵错误了")
	}
}

// TestTruncateKeepsRunesWhole 留痕那一路的字段要截到列宽以内，但截出半个字符
// 会被 utf8mb4 列拒掉 —— 而那一行的写入错误是被刻意忽略的，丢了就再也补不回来。
func TestTruncateKeepsRunesWhole(t *testing.T) {
	got := truncate("管理端浏览器", 8)
	if !strings.HasPrefix("管理端浏览器", got) || len(got) > 8 {
		t.Fatalf("截断结果不合法：%q", got)
	}
	if !utf8Valid(got) {
		t.Fatalf("截出了半个字符：%q", got)
	}
}

func utf8Valid(value string) bool {
	for _, r := range value {
		if r == '�' {
			return false
		}
	}
	return true
}
