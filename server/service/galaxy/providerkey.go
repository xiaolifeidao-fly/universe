package galaxy

import (
	"context"
	"fmt"
	"strings"
	"time"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 提供者接入密钥：单独部署的 rust bridge 用它自助注册节点。
//
// 为什么要有第二条接入路径，而不是让所有机器都走配对码：配对码的前提是
// 「有个人同时看着控制台和那台机器」。放在机房里的服务器没有这个人 ——
// 它半夜重启一次，就得有人爬起来生成一个十分钟有效的码。接入密钥写进那台机器的
// 配置里，它自己起来就能重新注册，这才是无人值守部署成立的条件。
//
// 代价是这把密钥比配对码值钱得多：拿到它的人能以你的名义往池子里加机器，
// 于是别人跑在那台机器上产生的积分记在你头上。所以它必须能随时吊销、能看到
// 「最近一次是谁在用」，而且明文只在签发那一刻出现一次。

const providerKeyPrefix = "gpk-"

const (
	providerKeyActive  = "active"
	providerKeyRevoked = "revoked"
)

// IssueProviderKey 签发一把接入密钥。和配对码同一道闸：没有当前条款版本的
// 同意记录就不给 —— 这把密钥能直接把机器加进池子，绕过它等于绕过整个同意流程。
func (s *service) IssueProviderKey(ctx context.Context, req dto.IssueProviderKeyRequest) (dto.IssuedProviderKey, error) {
	if strings.TrimSpace(req.OwnerUserID) == "" {
		return dto.IssuedProviderKey{}, fmt.Errorf("缺少用户")
	}
	terms := s.cfg().ProviderTermsVersion
	agreed, err := s.HasConsent(ctx, subjectProvider, req.OwnerUserID, terms)
	if err != nil {
		return dto.IssuedProviderKey{}, err
	}
	if !agreed {
		return dto.IssuedProviderKey{}, contract.ErrConsentRequired
	}

	now := time.Now()
	secret := providerKeyPrefix + randomToken(24)
	row := &repository.GalaxyProviderKey{
		BizLine:      bizLine,
		KeyID:        "gpk_" + NewULID(now),
		KeyHash:      HashSecret(secret),
		OwnerUserID:  req.OwnerUserID,
		Alias:        truncate(defaultString(req.Alias, "接入密钥"), 64),
		TermsVersion: terms,
		Status:       providerKeyActive,
	}
	if req.ExpiresInDays > 0 {
		expires := now.AddDate(0, 0, req.ExpiresInDays)
		row.ExpiresAt = &expires
	}
	if err := s.repository.CreateProviderKey(ctx, row); err != nil {
		return dto.IssuedProviderKey{}, err
	}
	return dto.IssuedProviderKey{ProviderKeyView: providerKeyView(row), Secret: secret}, nil
}

func (s *service) ListProviderKeys(ctx context.Context, ownerUserID string) ([]dto.ProviderKeyView, error) {
	rows, err := s.repository.ListProviderKeysByOwner(ctx, bizLine, ownerUserID)
	if err != nil {
		return nil, err
	}
	views := make([]dto.ProviderKeyView, 0, len(rows))
	for _, row := range rows {
		views = append(views, providerKeyView(row))
	}
	return views, nil
}

// RevokeProviderKey 吊销一把密钥。
//
// **已经用它注册出来的机器不受影响。** 那些机器手里拿的是各自的 node token，
// 和这把密钥再无关系 —— 吊销它只是「以后不能再用它加新机器了」。要停掉某台机器，
// 去机器列表里撤销那一台。两件事分开是有意的：密钥泄露时该做的是吊销密钥，
// 而不是把还在正常干活的十台机器一起踢下线。
func (s *service) RevokeProviderKey(ctx context.Context, ownerUserID, keyID string) error {
	err := s.repository.RevokeProviderKey(ctx, bizLine, ownerUserID, keyID)
	if notFound(err) {
		return fmt.Errorf("找不到这把密钥，或它不属于你")
	}
	return err
}

// authenticateProviderKey 把一串明文认成某个主人。四种拒绝分开说：
// 拿着一把过期密钥的人和拿着一把打错字的密钥的人，要做的事完全不同。
func (s *service) authenticateProviderKey(ctx context.Context, secret string) (*repository.GalaxyProviderKey, error) {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return nil, fmt.Errorf("缺少接入密钥")
	}
	row, err := s.repository.FindProviderKeyByHash(ctx, bizLine, HashSecret(secret))
	if notFound(err) {
		return nil, fmt.Errorf("接入密钥无效")
	}
	if err != nil {
		return nil, err
	}
	if row.Status != providerKeyActive {
		return nil, fmt.Errorf("接入密钥已吊销，请在控制台重新签发一把")
	}
	if row.ExpiresAt != nil && !row.ExpiresAt.After(time.Now()) {
		return nil, fmt.Errorf("接入密钥已于 %s 过期，请重新签发", row.ExpiresAt.Format("2006-01-02"))
	}
	return row, nil
}

func providerKeyView(row *repository.GalaxyProviderKey) dto.ProviderKeyView {
	return dto.ProviderKeyView{
		KeyID: row.KeyID, Alias: row.Alias, Status: row.Status,
		LastUsedAt: row.LastUsedAt, LastNodeID: row.LastNodeID,
		ExpiresAt: row.ExpiresAt, CreatedTime: row.CreatedTime,
	}
}
