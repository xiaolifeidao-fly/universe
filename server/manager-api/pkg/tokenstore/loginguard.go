package tokenstore

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"

	"service/manager"
)

// 连续登录失败的计数，和令牌共用同一个 Redis 客户端 —— 进程里已经有这一个连接池，
// 再开一个只为了每次登录敲两条命令纯属浪费。前缀 `login:` 把它和令牌的键分开。
//
// 计数是**可以丢的**：Redis 掉了一段，最坏的结果是那段时间里的失败没算上 ——
// 判定是单向的（算不出来就放行，见 manager.overLoginLimit），证据在
// zt_manager_login_record 里。所以这里既不持久化，也不做主从确认。

func (s *Store) loginKey(key string) string { return s.namespace + ":login:" + key }

// loginFailScript INCR 一次，并在**第一次**失败时把窗口钉死。
//
// 不用 `EXPIRE ... NX`（Redis 7.0 才有）也不用「先 TTL 再 EXPIRE」（那两条之间
// 能插进别的请求，于是窗口被反复重置）。一段脚本最省事：n == 1 就是这个窗口的
// 第一次失败。窗口不顺延，理由见 manager.LoginGuard 的注释。
var loginFailScript = redis.NewScript(`
local n = redis.call('INCR', KEYS[1])
if n == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return n
`)

// LoginFailures 读当前窗口的失败次数与剩余时间。键不存在返回 (0, 0, nil)。
func (s *Store) LoginFailures(ctx context.Context, key string) (int, time.Duration, error) {
	redisKey := s.loginKey(key)
	pipe := s.client.Pipeline()
	count := pipe.Get(ctx, redisKey)
	ttl := pipe.PTTL(ctx, redisKey)
	if _, err := pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return 0, 0, err
	}
	value, err := count.Int()
	if errors.Is(err, redis.Nil) {
		return 0, 0, nil
	}
	if err != nil {
		return 0, 0, err
	}
	// PTTL 对没有过期时间的键返回 -1，对不存在的键返回 -2。两种都当作
	// 「说不出还要等多久」—— 上层据此换一句不说死的提示，而不是报错。
	remaining, err := ttl.Result()
	if err != nil || remaining < 0 {
		remaining = 0
	}
	return value, remaining, nil
}

// LoginFailed 记一次失败，返回窗口内累计次数。
func (s *Store) LoginFailed(ctx context.Context, key string, window time.Duration) (int, error) {
	if window <= 0 {
		return 0, errors.New("登录失败计数窗口必须为正")
	}
	return loginFailScript.Run(ctx, s.client, []string{s.loginKey(key)}, window.Milliseconds()).Int()
}

// LoginReset 清零。本人登录成功时清掉账号那一维。
func (s *Store) LoginReset(ctx context.Context, key string) error {
	return s.client.Del(ctx, s.loginKey(key)).Err()
}

var _ manager.LoginGuard = (*Store)(nil)
