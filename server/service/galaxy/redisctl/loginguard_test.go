package redisctl

import (
	"context"
	"testing"
	"time"
)

// 登录失败计数只有三个动作，但每一个都有一条「写错了不会报错、只会悄悄失效」的边：
// 窗口被反复顺延（锁死一个真人）、键没有过期时间（永久锁死）、清零清错了维度。
// 下面几条把它们钉住。

func TestLoginWindowDoesNotSlide(t *testing.T) {
	plane, server := newTestPlane(t)
	ctx := context.Background()

	if _, err := plane.LoginFailed(ctx, "consumer:u:fly", 15*time.Minute); err != nil {
		t.Fatal(err)
	}
	server.FastForward(10 * time.Minute)
	// 第二次失败发生在窗口过了三分之二的时候。窗口要是跟着顺延，被锁住的人
	// 每按一次「登录」就把自己的解锁时间往后推，提示语永远不会变短。
	count, err := plane.LoginFailed(ctx, "consumer:u:fly", 15*time.Minute)
	if err != nil || count != 2 {
		t.Fatalf("累计次数 = %d, %v；want 2", count, err)
	}
	_, remaining, err := plane.LoginFailures(ctx, "consumer:u:fly")
	if err != nil {
		t.Fatal(err)
	}
	if remaining > 5*time.Minute {
		t.Fatalf("窗口被顺延了：还剩 %s，最多只该剩 5 分钟", remaining)
	}

	// 窗口一过就该干净地归零，而不是留一个没有过期时间的键把人永久挡在外面。
	server.FastForward(6 * time.Minute)
	count, remaining, err = plane.LoginFailures(ctx, "consumer:u:fly")
	if err != nil || count != 0 || remaining != 0 {
		t.Fatalf("窗口过后 = (%d, %s, %v)；want (0, 0, nil)", count, remaining, err)
	}
}

// TestLoginFailuresOnMissingKey 没失败过和「读不出来」是两回事：前者必须是
// (0, 0, nil)，落成错误的话上层的单向判定会把每一次登录都记一行日志。
func TestLoginFailuresOnMissingKey(t *testing.T) {
	plane, _ := newTestPlane(t)
	count, remaining, err := plane.LoginFailures(context.Background(), "consumer:u:nobody")
	if err != nil || count != 0 || remaining != 0 {
		t.Fatalf("= (%d, %s, %v)；want (0, 0, nil)", count, remaining, err)
	}
}

// TestLoginResetIsPerKey 清零只该动传进来的那一个键。清成前缀匹配的话，
// 一次成功登录会把同一个来源下所有人的失败计数一起抹掉。
func TestLoginResetIsPerKey(t *testing.T) {
	plane, _ := newTestPlane(t)
	ctx := context.Background()
	for _, key := range []string{"consumer:u:fly", "consumer:ip:1.2.3.4"} {
		if _, err := plane.LoginFailed(ctx, key, time.Minute); err != nil {
			t.Fatal(err)
		}
	}
	if err := plane.LoginReset(ctx, "consumer:u:fly"); err != nil {
		t.Fatal(err)
	}
	if count, _, _ := plane.LoginFailures(ctx, "consumer:u:fly"); count != 0 {
		t.Fatalf("账号那一维没清掉：%d", count)
	}
	if count, _, _ := plane.LoginFailures(ctx, "consumer:ip:1.2.3.4"); count != 1 {
		t.Fatalf("来源那一维被顺手清掉了：%d —— 那样一次成功登录就能抹掉整台机器的失败记录", count)
	}
}

// TestLoginKeysAreNamespaced 计数键必须落在本命名空间下，不然多套环境共用一个
// Redis 时会互相锁。
func TestLoginKeysAreNamespaced(t *testing.T) {
	plane, server := newTestPlane(t)
	if _, err := plane.LoginFailed(context.Background(), "provider:u:fly", time.Minute); err != nil {
		t.Fatal(err)
	}
	if got, err := server.Get("gx:login:provider:u:fly"); err != nil || got != "1" {
		t.Fatalf("键不在 gx:login: 下面：%q, %v", got, err)
	}
}
