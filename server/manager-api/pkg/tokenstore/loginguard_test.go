package tokenstore

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
)

func newTestStore(t *testing.T) (*Store, *miniredis.Miniredis) {
	t.Helper()
	server := miniredis.RunT(t)
	store := New(Options{Addresses: server.Addr(), Namespace: "mgr"})
	if store == nil {
		t.Fatal("令牌存储未初始化")
	}
	t.Cleanup(func() { _ = store.Close() })
	return store, server
}

// TestLoginWindowDoesNotSlide 窗口从第一次失败起算，此后不顺延 ——
// 顺延的话，被锁住的人每按一次「登录」就把自己的解锁时间往后推。
func TestLoginWindowDoesNotSlide(t *testing.T) {
	store, server := newTestStore(t)
	ctx := context.Background()

	if _, err := store.LoginFailed(ctx, "u:admin", 15*time.Minute); err != nil {
		t.Fatal(err)
	}
	server.FastForward(10 * time.Minute)
	count, err := store.LoginFailed(ctx, "u:admin", 15*time.Minute)
	if err != nil || count != 2 {
		t.Fatalf("累计次数 = %d, %v；want 2", count, err)
	}
	if _, remaining, _ := store.LoginFailures(ctx, "u:admin"); remaining > 5*time.Minute {
		t.Fatalf("窗口被顺延了：还剩 %s，最多只该剩 5 分钟", remaining)
	}

	// 窗口一过干净归零，而不是留一个没有过期时间的键把人永久挡在外面。
	server.FastForward(6 * time.Minute)
	count, remaining, err := store.LoginFailures(ctx, "u:admin")
	if err != nil || count != 0 || remaining != 0 {
		t.Fatalf("窗口过后 = (%d, %s, %v)；want (0, 0, nil)", count, remaining, err)
	}
}

// TestLoginFailuresOnMissingKey 没失败过和「读不出来」是两回事。
func TestLoginFailuresOnMissingKey(t *testing.T) {
	store, _ := newTestStore(t)
	count, remaining, err := store.LoginFailures(context.Background(), "u:nobody")
	if err != nil || count != 0 || remaining != 0 {
		t.Fatalf("= (%d, %s, %v)；want (0, 0, nil)", count, remaining, err)
	}
}

// TestLoginKeysDoNotCollideWithTokens 计数键和令牌键必须分得开：撞在一起的话，
// 一次失败计数会覆盖掉某个人的会话。
func TestLoginKeysDoNotCollideWithTokens(t *testing.T) {
	store, server := newTestStore(t)
	if _, err := store.LoginFailed(context.Background(), "u:admin", time.Minute); err != nil {
		t.Fatal(err)
	}
	if got, err := server.Get("mgr:login:u:admin"); err != nil || got != "1" {
		t.Fatalf("键不在 mgr:login: 下面：%q, %v", got, err)
	}
	if store.loginKey("u:admin") == store.tokenKey("u:admin") {
		t.Fatal("计数键和令牌键撞了")
	}
}

// TestLoginResetIsPerKey 清零只动传进来的那一个键。
func TestLoginResetIsPerKey(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()
	for _, key := range []string{"u:admin", "ip:1.2.3.4"} {
		if _, err := store.LoginFailed(ctx, key, time.Minute); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.LoginReset(ctx, "u:admin"); err != nil {
		t.Fatal(err)
	}
	if count, _, _ := store.LoginFailures(ctx, "u:admin"); count != 0 {
		t.Fatalf("账号那一维没清掉：%d", count)
	}
	if count, _, _ := store.LoginFailures(ctx, "ip:1.2.3.4"); count != 1 {
		t.Fatalf("来源那一维被顺手清掉了：%d", count)
	}
}
