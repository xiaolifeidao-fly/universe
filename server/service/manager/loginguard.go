package manager

import (
	"context"
	"fmt"
	"log"
	"math"
	"time"
)

// 连续登录失败的闸。计数在 Redis（Ports.Guard），证据在 zt_manager_login_record。
//
// 形状和共享算力池那边（service/galaxy/account）是同一套，两处各写一份而不是抽公共
// 包：这两套身份体系是刻意分开的，共用一个工具会让人以为它们还有别的牵连 ——
// 和 hashPassword 各写一遍是同一个理由。

// loginKeys 一次登录尝试要过的两道闸。
//
//	账号维度  用户名。**主力**，挡的是「盯着一个账号猜密码」。
//	来源维度  IP。辅助，挡的是「拿一份账号表在一台机器上挨个扫」。
//
// 来源维度的阈值高得多，而且它**不构成安全边界**：IP 取自 X-Forwarded-For，
// 是访问者自己填的（见 httpx.ClientIP），换一个头就绕过去了。真要按来源封，
// 得在 nginx 上按 remote_addr 做，那个值伪造不了。
//
// 计数按**输进来的用户名**记，账号在不在都一样 —— 所以「已锁定」这句话不会
// 泄露某个用户名是否存在。
func loginKeys(username, ip string) (userKey, ipKey string) {
	userKey = "u:" + username
	if ip != "" {
		ipKey = "ip:" + ip
	}
	return userKey, ipKey
}

func (s *service) loginBlocked(ctx context.Context, userKey, ipKey string) (time.Duration, bool) {
	if s.guard == nil {
		return 0, false
	}
	if wait, blocked := s.overLoginLimit(ctx, userKey, s.config.MaxLoginFail); blocked {
		return wait, true
	}
	if ipKey == "" {
		return 0, false
	}
	return s.overLoginLimit(ctx, ipKey, s.config.MaxLoginFailPerIP)
}

// overLoginLimit 单独一维的判定。**单向**：只有明确算出超限才拦，算不出来放行。
//
// 这一条和 Authorize 里「存储不可用就拒绝」不是一回事，别照着那条改：那边拒绝的是
// 一张**已经签发**的令牌，宁可让人重登一次；这边拒绝的是所有人的登录入口，而且
// Redis 真的挂了的话，后面那句 tokens.Save 本来就会失败，这次登录照样成不了。
// 把「不知道」当成「超了」只会多一种更难看的失败方式。
func (s *service) overLoginLimit(ctx context.Context, key string, max int) (time.Duration, bool) {
	if max <= 0 {
		return 0, false
	}
	count, retryAfter, err := s.guard.LoginFailures(ctx, key)
	if err != nil {
		log.Printf("manager: 登录失败计数读不到（%s），这次放行: %v", key, err)
		return 0, false
	}
	if count < max {
		return 0, false
	}
	return retryAfter, true
}

// penalizeLogin 两维各记一次失败。
func (s *service) penalizeLogin(ctx context.Context, userKey, ipKey string) {
	if s.guard == nil {
		return
	}
	if s.config.MaxLoginFail > 0 {
		if _, err := s.guard.LoginFailed(ctx, userKey, s.config.LoginFailWindow); err != nil {
			log.Printf("manager: 登录失败计数写不进去（%s）: %v", userKey, err)
		}
	}
	if ipKey != "" && s.config.MaxLoginFailPerIP > 0 {
		if _, err := s.guard.LoginFailed(ctx, ipKey, s.config.LoginFailWindow); err != nil {
			log.Printf("manager: 登录失败计数写不进去（%s）: %v", ipKey, err)
		}
	}
}

// clearLoginFailures 登录成功，清掉账号那一维。
//
// **来源那一维不清**：清了的话，一个攻击者只要用自己的账号成功登一次，就能把
// 自己在这台机器上累积的失败次数抹掉，来源维度的闸等于不存在。
func (s *service) clearLoginFailures(ctx context.Context, userKey string) {
	if s.guard == nil {
		return
	}
	if err := s.guard.LoginReset(ctx, userKey); err != nil {
		log.Printf("manager: 登录失败计数清不掉（%s）: %v", userKey, err)
	}
}

// lockedUntil 带上还要等多久的那句话。
//
// 分钟数向上取整：说「还有 1 分钟」而实际还差 90 秒的话，用户会在一分钟后
// 再撞一次同样的墙。算不出剩余时间时就不说死。
func lockedUntil(retryAfter time.Duration) error {
	if retryAfter <= 0 {
		return fmt.Errorf("%w，请稍后再试", ErrLoginLocked)
	}
	return fmt.Errorf("%w，请 %d 分钟后再试", ErrLoginLocked, int(math.Ceil(retryAfter.Minutes())))
}
