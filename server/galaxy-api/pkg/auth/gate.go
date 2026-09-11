package auth

import (
	"context"
	"errors"
	"log"
	"strings"

	"github.com/gin-gonic/gin"

	"common/middleware/httpx"
	"service/galaxy/account"
	"service/galaxy/dto"
)

// Authenticator Gate 唯一要的能力。收窄成一个方法，测试不用去装一整个账号服务。
type Authenticator interface {
	Authenticate(ctx context.Context, side, token string) (account.Principal, error)
}

// Gate 控制台的门。每条控制台路由都要显式挂上本端的门：
// 共享端的接口挂 Provider()，使用端的挂 Consumer()。
type Gate struct {
	accounts Authenticator
}

func NewGate(accounts Authenticator) *Gate {
	return &Gate{accounts: accounts}
}

func (g *Gate) Provider() gin.HandlerFunc { return g.Require(dto.SideProvider) }
func (g *Gate) Consumer() gin.HandlerFunc { return g.Require(dto.SideConsumer) }

// notLogin 客户端的拦截器认的就是这四个字：看到它就清令牌、跳登录页。换别的措辞，
// 令牌失效的人会停在原页面，看着每个请求报一次错。
const notLogin = "not login"

const principalKey = "galaxy.account"

// Require 校验令牌属于这一端、账号仍然有效，并把账号放进请求上下文。
//
// 令牌从 token 头取（控制台的 axios 封装只发这一个），没有再看 Authorization: Bearer。
func (g *Gate) Require(side string) gin.HandlerFunc {
	// 必须改密码的人也走得通的两条：看自己是谁、改密码。其余一律拦下，
	// 否则运营重置出来的临时密码就一直能用。
	selfService := []string{"/" + side + "/auth/me", "/" + side + "/auth/password"}
	return func(ginContext *gin.Context) {
		token := strings.TrimSpace(ginContext.GetHeader("token"))
		if token == "" {
			token = strings.TrimSpace(strings.TrimPrefix(ginContext.GetHeader("Authorization"), "Bearer "))
		}
		if token == "" || g == nil || g.accounts == nil {
			httpx.Fail(ginContext, notLogin)
			ginContext.Abort()
			return
		}
		principal, err := g.accounts.Authenticate(ginContext.Request.Context(), side, token)
		if errors.Is(err, account.ErrNotLogin) {
			httpx.Fail(ginContext, notLogin)
			ginContext.Abort()
			return
		}
		if err != nil {
			// 查库失败、没配签名密钥：不是这个人的凭证有问题，不能让客户端清令牌。
			log.Printf("galaxy 控制台鉴权失败 side=%s path=%s: %v", side, ginContext.FullPath(), err)
			httpx.Fail(ginContext, "认证服务暂不可用，请稍后重试")
			ginContext.Abort()
			return
		}
		if principal.MustChangePassword && !hasSuffix(ginContext.FullPath(), selfService) {
			httpx.Fail(ginContext, "请先修改初始密码")
			ginContext.Abort()
			return
		}
		ginContext.Set(principalKey, principal)
		ginContext.Next()
	}
}

// CurrentAccount 门认定的账号。没挂门的路由上拿不到。
func CurrentAccount(ginContext *gin.Context) (account.Principal, bool) {
	value, ok := ginContext.Get(principalKey)
	if !ok {
		return account.Principal{}, false
	}
	principal, ok := value.(account.Principal)
	return principal, ok
}

// UserID 当前账号的业务键（pu_… / cu_…），控制台接口的 owner 一律取它。
//
// 门没挂上时是空串，而不是像 httpx.CallerID 那样退回请求头里的 X-User-ID 或者
// "local-console" —— 那两个退路在这里等于允许任何人自称任何人。
func UserID(ginContext *gin.Context) string {
	principal, _ := CurrentAccount(ginContext)
	return principal.UserID
}

func hasSuffix(path string, suffixes []string) bool {
	for _, suffix := range suffixes {
		if strings.HasSuffix(path, suffix) {
			return true
		}
	}
	return false
}
