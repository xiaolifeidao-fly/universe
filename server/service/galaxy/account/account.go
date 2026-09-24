// Package account 是 Galaxy 自己的账号体系。
//
// 它和任务宇宙的 service/identity 完全分开：不同的表、不同的令牌、不读也不写对方的
// 任何东西。任务宇宙的令牌打到 galaxy-api 上是 not login，Galaxy 的令牌打到 web-api 上
// 也一样 —— 就算两边配了同一个签名密钥，令牌的形状（iss / aud / 字符串 sub）也对不上。
//
// 账号分两端，是两批人，各有各的表：
//
//	共享端 provider  出算力，用 Nova。zt_galaxy_provider_user；
//	                 身份分散户 / 工作室（zt_galaxy_provider，只由运营改）
//	使用端 consumer  花钱买额度，用 Orbit。zt_galaxy_consumer_user
//
// 同一个人两边都用，就在两边各注册一个；同一个用户名在两端可以各有一个账号。
// 令牌里签着端，一端的令牌调不了另一端的接口。
//
// 所以这个包里几乎每个方法都要一个 side：拿不出端就找不到账号。这不是啰嗦 ——
// 两端在库里是两张表，「不带端地查一个账号」这件事本身已经不成立了。
package account

import (
	"context"
	"strings"
	"time"

	"gorm.io/gorm"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// Service Galaxy 账号。自助的那半给 galaxy-api，运营的那半给 manager-api。
type Service interface {
	// Register 自助注册，注册完直接登录。共享端注册出来一律是散户；
	// 使用端还会默认送一把算力密钥，明文跟着结果回来一次（AccountLoginResult.Key）。
	Register(ctx context.Context, req dto.RegisterAccountRequest) (dto.AccountLoginResult, error)
	Login(ctx context.Context, req dto.LoginAccountRequest) (dto.AccountLoginResult, error)
	// Authenticate 校验一张令牌是不是这一端的、账号是否还有效。
	Authenticate(ctx context.Context, side, token string) (Principal, error)
	// Current side 与 userID 都从凭证来 —— 接口层给的是 Principal 里的那两个值，
	// 不是请求里报的。
	Current(ctx context.Context, side, userID string) (dto.AccountView, error)
	// ChangeOwnPassword 本人改密码。旧令牌全部作废，回一张新的。
	ChangeOwnPassword(ctx context.Context, side, userID string, req dto.ChangeAccountPasswordRequest) (dto.AccountLoginResult, error)

	// ---------- 运营 ----------
	List(ctx context.Context, query dto.AccountQuery) (dto.AccountPage, error)
	SetStatus(ctx context.Context, req dto.SetAccountStatusRequest) error
	ResetPassword(ctx context.Context, req dto.ResetAccountPasswordRequest) error
}

// Principal 令牌认定的账号。接口层只认它，不认请求体里报的任何身份字段。
type Principal struct {
	UserID             string
	Side               string
	Username           string
	DisplayName        string
	MustChangePassword bool
}

// KeyIssuer 使用端新账号默认送的那把密钥由谁来签。实现是 galaxy.Service，
// 由装配层注入 —— 账号这一层只管「注册成功之后要有一把」，不认识密钥怎么签、
// 多久到期、范围怎么算。
//
// 只做运营那一半的装配方（manager-api）注册不了账号，可以不给。
type KeyIssuer interface {
	IssueRegistrationKey(ctx context.Context, ownerUserID string) (dto.IssuedKeyView, error)
}

// RegistrationGiftIssuer 负责在使用端注册完成后发放活动积分。
// 账号服务只依赖这个最小接口，活动规则仍由 galaxy 账务服务统一判断。
type RegistrationGiftIssuer interface {
	GrantRegistrationGift(ctx context.Context, ownerUserID string) error
}

// Options 令牌参数。只做运营的装配方（manager-api）不签发也不校验令牌，可以留空。
type Options struct {
	TokenSecret string
	TokenTTL    time.Duration
	// Keys 注册即送那把密钥的签发方。留空就只建账号，不送密钥。
	Keys KeyIssuer
	// RegistrationGift 注册赠送积分的账务方。留空表示不启用该活动。
	RegistrationGift RegistrationGiftIssuer

	// Guard 连续登录失败的计数闸。**留空就不限制** —— 只做运营那一半的装配方
	// （manager-api）根本不暴露登录接口，给它一个计数器没有意义。
	//
	// 留痕不受它影响：那一路只要数据库，Guard 在不在都照记。
	Guard LoginGuard
	// MaxLoginFail 同一个用户名在窗口内连续失败多少次就暂时拒绝。
	// 0 取默认值 defaultMaxLoginFail，负数表示这一维不限制。
	MaxLoginFail int
	// MaxLoginFailPerIP 同一来源地址的上限，0 取 MaxLoginFail 的
	// defaultIPFailFactor 倍。这一维阈值高是因为一个出口后面可能坐着一屋子人，
	// 而且它挡不住伪造来源的那种打法（见 loginKeys）。
	MaxLoginFailPerIP int
	// LoginFailWindow 计数窗口，0 取默认 15 分钟。也是被锁之后要等的时间。
	LoginFailWindow time.Duration
}

// 登录失败闸的默认值。
//
// 5 次是给「记混了几个常用密码」留的余量 —— 真是本人的话，第六次多半也想不起来，
// 停 15 分钟的代价远小于把一个账号交出去。两个值都可以在配置里改。
const (
	defaultMaxLoginFail    = 5
	defaultIPFailFactor    = 6
	defaultLoginFailWindow = 15 * time.Minute
)

type service struct {
	repository       *repository.GalaxyRepository
	tokenSecret      string
	tokenTTL         time.Duration
	keys             KeyIssuer
	registrationGift RegistrationGiftIssuer

	guard             LoginGuard
	maxLoginFail      int
	maxLoginFailPerIP int
	loginFailWindow   time.Duration
}

func New(database *gorm.DB, options Options) Service {
	repo := &repository.GalaxyRepository{}
	repo.SetDb(database)
	ttl := options.TokenTTL
	if ttl <= 0 {
		ttl = 7 * 24 * time.Hour
	}
	maxFail := options.MaxLoginFail
	if maxFail == 0 {
		maxFail = defaultMaxLoginFail
	}
	maxFailPerIP := options.MaxLoginFailPerIP
	if maxFailPerIP == 0 && maxFail > 0 {
		maxFailPerIP = maxFail * defaultIPFailFactor
	}
	window := options.LoginFailWindow
	if window <= 0 {
		window = defaultLoginFailWindow
	}
	return &service{
		repository: repo, tokenSecret: strings.TrimSpace(options.TokenSecret),
		tokenTTL: ttl, keys: options.Keys, registrationGift: options.RegistrationGift,
		guard: options.Guard, maxLoginFail: maxFail,
		maxLoginFailPerIP: maxFailPerIP, loginFailWindow: window,
	}
}

const bizLine = string(contract.GalaxyBizLine)

// idPrefix 业务键前缀。看一眼 owner_user_id 就知道是哪一端的人。
func idPrefix(side string) string {
	switch side {
	case dto.SideProvider:
		return "pu_"
	case dto.SideConsumer:
		return "cu_"
	}
	return ""
}

func validSide(side string) bool { return idPrefix(side) != "" }
