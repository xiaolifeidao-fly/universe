package account

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"time"

	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// ErrTooManyAttempts 连续失败太多次，闸门还没到期。
//
// 它和 ErrLoginFailed 是两句不同的话，这一点是刻意的：分不开的话，被锁住的人
// 会一直以为是自己记错了密码，一次又一次地试 —— 而每一次都不会走到 bcrypt，
// 也就永远不会成功。
//
// 它不泄露「这个用户名存在」：计数按**输进来的用户名**记，账号在不在都一样记、
// 一样锁，所以拿这句话去枚举用户名，得到的结果处处相同。
var ErrTooManyAttempts = errors.New("密码错误次数过多，登录已被暂时锁定")

// LoginGuard 连续登录失败的计数闸。
//
// 实现在 Redis 上（service/galaxy/redisctl），由装配层注入 —— 账号这一层不认识
// Redis，也不关心计数存在哪儿。
//
// 为什么计数不跟留痕一起放在 MySQL 里：判定要的是「读一下、加一次」的原子性。
// 按表里的行数来算的话，一次并发打过来的几百个请求会**同时**读到「才失败 0 次」，
// 于是一起放行 —— 那正是爆破的形状。Redis 的 INCR 没有这个缺口。
//
// 两者各司其职，不是重复：Redis 那份是实时判定，会自己过期；MySQL 那份是证据，
// 留着给事后查。
type LoginGuard interface {
	// LoginFailures 读一个键当前窗口内的失败次数，以及这个窗口还有多久到期。
	// 键不存在返回 (0, 0, nil)。
	LoginFailures(ctx context.Context, key string) (int, time.Duration, error)
	// LoginFailed 记一次失败并返回累计次数。
	//
	// 窗口从**第一次**失败起算，此后不再顺延：顺延的话，被锁住的人每按一次
	// 「登录」都会把自己的解锁时间往后推，界面上的提示语从此永远不会变短。
	LoginFailed(ctx context.Context, key string, window time.Duration) (int, error)
	// LoginReset 清零。本人登录成功时清掉账号那一维。
	LoginReset(ctx context.Context, key string) error
}

// loginKeys 一次登录尝试要过的两道闸。
//
//	账号维度  side + 用户名。**主力**，挡的是「盯着一个账号猜密码」。
//	来源维度  side + IP。辅助，挡的是「拿一份账号表在一台机器上挨个扫」。
//
// 来源维度的阈值高得多，而且它**不构成安全边界**：IP 来自 X-Forwarded-For，
// 是访问者自己填的（见 httpx.ClientIP），换一个头就绕过去了。它拦的是老实的
// 批量扫号；真要按来源封，得在 nginx 上按 remote_addr 做，那个值伪造不了。
//
// 用户名为空时不该走到这里 —— 调用方先挡掉了。
func loginKeys(side, username, ip string) (userKey, ipKey string) {
	userKey = side + ":u:" + username
	if ip != "" {
		ipKey = side + ":ip:" + ip
	}
	return userKey, ipKey
}

// loginBlocked 这次尝试要不要当场拒绝，以及还要等多久。
//
// 它排在查库和 bcrypt **之前**：被锁住之后每一次尝试还去算一遍 bcrypt 的话，
// 这道闸自己就成了一条放大 CPU 消耗的路。
func (s *service) loginBlocked(ctx context.Context, userKey, ipKey string) (time.Duration, bool) {
	if s.guard == nil {
		return 0, false
	}
	if wait, blocked := s.overLoginLimit(ctx, userKey, s.maxLoginFail); blocked {
		return wait, true
	}
	if ipKey == "" {
		return 0, false
	}
	return s.overLoginLimit(ctx, ipKey, s.maxLoginFailPerIP)
}

// overLoginLimit 单独一维的判定。**单向**：只有在明确算出超限时才拦，
// 算不出来一律放行。
//
// 这条和上游余量那道闸（service/galaxy/upstreamfloor.go）是同一个取舍：
// 把「不知道」当成「超了」的话，Redis 抖一下就能让所有人登不进来，而爆破
// 要持续很久才有结果 —— 何况计数读不到的时候，失败照样在往留痕表里落行。
func (s *service) overLoginLimit(ctx context.Context, key string, max int) (time.Duration, bool) {
	if max <= 0 {
		return 0, false
	}
	count, retryAfter, err := s.guard.LoginFailures(ctx, key)
	if err != nil {
		log.Printf("galaxy: 登录失败计数读不到（%s），这次放行: %v", key, err)
		return 0, false
	}
	if count < max {
		return 0, false
	}
	return retryAfter, true
}

// penalizeLogin 两维各记一次失败。
//
// 失败的是这次尝试，不是这个账号 —— 用户名不存在、账号停用、密码不对，三种
// 都要记。只记密码不对的话，拿一串用户名扫过去的那种打法一次都不会被计上。
func (s *service) penalizeLogin(ctx context.Context, userKey, ipKey string) {
	if s.guard == nil {
		return
	}
	if s.maxLoginFail > 0 {
		if _, err := s.guard.LoginFailed(ctx, userKey, s.loginFailWindow); err != nil {
			log.Printf("galaxy: 登录失败计数写不进去（%s）: %v", userKey, err)
		}
	}
	if ipKey != "" && s.maxLoginFailPerIP > 0 {
		if _, err := s.guard.LoginFailed(ctx, ipKey, s.loginFailWindow); err != nil {
			log.Printf("galaxy: 登录失败计数写不进去（%s）: %v", ipKey, err)
		}
	}
}

// clearLoginFailures 登录成功，清掉账号那一维。
//
// **来源那一维不清**：清了的话，一个攻击者只要用自己的账号成功登一次，就能把
// 自己在这台机器上累积的失败次数抹掉，来源维度的闸等于不存在。代价是同一个出口
// 后面的人会互相影响一点 —— 所以那一维的阈值才留得高。
func (s *service) clearLoginFailures(ctx context.Context, userKey string) {
	if s.guard == nil {
		return
	}
	if err := s.guard.LoginReset(ctx, userKey); err != nil {
		log.Printf("galaxy: 登录失败计数清不掉（%s）: %v", userKey, err)
	}
}

// recordLogin 落一行留痕。成功与失败都记。
//
// reason 只进库，不回给客户端 —— 客户端看到的永远是 ErrLoginFailed 那一句，
// 「用户不存在」和「密码不对」分开说等于把用户名枚举的能力送出去。
func (s *service) recordLogin(ctx context.Context, req dto.LoginAccountRequest, userID, username string, success bool, reason string) {
	// 留痕失败不该挡住登录本身。
	_ = s.repository.CreateLoginRecord(ctx, &repository.GalaxyLoginRecord{
		BizLine: bizLine, Side: req.Side, UserID: userID, Username: truncate(username, 64),
		IP: truncate(req.IP, 64), UserAgent: truncate(req.UserAgent, 256),
		Success: success, Reason: reason,
	})
}

// tooManyAttempts 带上还要等多久的那句话。
//
// 分钟数向上取整：说「还有 1 分钟」而实际还差 90 秒的话，用户会在一分钟后
// 再撞一次同样的墙。算不出剩余时间（计数面只答得出次数）时就不说死。
func tooManyAttempts(retryAfter time.Duration) error {
	if retryAfter <= 0 {
		return fmt.Errorf("%w，请稍后再试", ErrTooManyAttempts)
	}
	return fmt.Errorf("%w，请 %d 分钟后再试", ErrTooManyAttempts, int(math.Ceil(retryAfter.Minutes())))
}
