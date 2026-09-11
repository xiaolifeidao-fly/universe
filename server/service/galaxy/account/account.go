// Package account 是 Galaxy 自己的账号体系。
//
// 它和任务宇宙的 service/identity 完全分开：不同的表（zt_galaxy_user）、不同的令牌、
// 不读也不写对方的任何东西。任务宇宙的令牌打到 galaxy-api 上是 not login，
// Galaxy 的令牌打到 web-api 上也一样 —— 就算两边配了同一个签名密钥，
// 令牌的形状（iss / aud / 字符串 sub）也对不上。
//
// 账号分两端，是两批人：
//
//	共享端 provider  出算力，用 Nova。身份分散户 / 工作室（zt_galaxy_provider，只由运营改）
//	使用端 consumer  花钱买额度，用 Orbit
//
// 同一个人两边都用，就在两边各注册一个；同一个用户名在两端可以各有一个账号。
// 令牌里签着端，一端的令牌调不了另一端的接口。
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
	// Register 自助注册，注册完直接登录。共享端注册出来一律是散户。
	Register(ctx context.Context, req dto.RegisterAccountRequest) (dto.AccountLoginResult, error)
	Login(ctx context.Context, req dto.LoginAccountRequest) (dto.AccountLoginResult, error)
	// Authenticate 校验一张令牌是不是这一端的、账号是否还有效。
	Authenticate(ctx context.Context, side, token string) (Principal, error)
	Current(ctx context.Context, userID string) (dto.AccountView, error)
	// ChangeOwnPassword 本人改密码。旧令牌全部作废，回一张新的。
	ChangeOwnPassword(ctx context.Context, userID string, req dto.ChangeAccountPasswordRequest) (dto.AccountLoginResult, error)

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

// Options 令牌参数。只做运营的装配方（manager-api）不签发也不校验令牌，可以留空。
type Options struct {
	TokenSecret string
	TokenTTL    time.Duration
}

type service struct {
	repository  *repository.GalaxyRepository
	tokenSecret string
	tokenTTL    time.Duration
}

func New(database *gorm.DB, options Options) Service {
	repo := &repository.GalaxyRepository{}
	repo.SetDb(database)
	ttl := options.TokenTTL
	if ttl <= 0 {
		ttl = 7 * 24 * time.Hour
	}
	return &service{repository: repo, tokenSecret: strings.TrimSpace(options.TokenSecret), tokenTTL: ttl}
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
