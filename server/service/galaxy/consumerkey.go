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

// 算力密钥：购买后由平台签发，绑定额度余额、有效期、允许范围（C-01）。
// P0 由后台为内测用户签发；P1 接支付后自动签发。

const (
	keyStatusActive  = "active"
	keyStatusExpired = "expired"
	keyStatusFrozen  = "frozen"
	keyStatusRevoked = "revoked"
)

// IssueKey 签发密钥。数据告知的确认是硬前置（C-13）：
// 请求数据会经第三方提供者机器处理，消费者必须先确认。
func (s *service) IssueKey(ctx context.Context, req dto.IssueKeyRequest) (dto.IssuedKeyView, error) {
	if req.NoticeVersion != s.config.ConsumerNoticeVersion {
		return dto.IssuedKeyView{}, fmt.Errorf("数据告知版本已更新，请重新确认")
	}
	agreed, err := s.HasConsent(ctx, subjectConsumer, req.OwnerUserID, req.NoticeVersion)
	if err != nil {
		return dto.IssuedKeyView{}, err
	}
	if !agreed {
		return dto.IssuedKeyView{}, contract.ErrConsentRequired
	}

	now := time.Now()
	ttl := s.config.KeyTTL
	if req.TTLDays > 0 {
		ttl = time.Duration(req.TTLDays) * 24 * time.Hour
	}
	secret := "sk-galaxy-" + randomToken(32)
	keyID := "ck_" + NewULID(now)
	row := &repository.GalaxyConsumerKey{
		BizLine: bizLine, KeyID: keyID, KeyHash: HashSecret(secret), SecretCipher: s.sealSecret(secret),
		Alias:                truncate(defaultString(req.Alias, keyID), 64),
		OwnerUserID:          req.OwnerUserID,
		ModelID:              truncate(req.ModelID, 96),
		AllowedKindsJSON:     encodeJSON(req.AllowedKinds),
		AllowedProvidersJSON: encodeJSON(req.AllowedProviders),
		ModelTierJSON:        encodeJSON(req.ModelTier),
		Concurrency:          defaultInt(req.Concurrency, s.config.KeyConcurrency),
		RPM:                  defaultInt(req.RPM, s.config.KeyRPM),
		Status:               keyStatusActive,
		IssuedAt:             now,
		ExpiresAt:            now.Add(ttl),
		NoticeVersion:        req.NoticeVersion,
		NoticeAckAt:          now,
	}
	if err := s.repository.CreateConsumerKey(ctx, row); err != nil {
		return dto.IssuedKeyView{}, err
	}
	if len(req.Grants) > 0 {
		balances := make([]*repository.GalaxyConsumerBalance, 0, len(req.Grants))
		ledgers := make([]*repository.GalaxyConsumerLedger, 0, len(req.Grants))
		for _, unit := range req.Grants.Units() {
			amount := req.Grants[unit]
			balances = append(balances, &repository.GalaxyConsumerBalance{BizLine: bizLine, KeyID: keyID, Unit: unit, Balance: amount})
			ledgers = append(ledgers, &repository.GalaxyConsumerLedger{
				BizLine: bizLine, TxnID: keyID + ":topup:" + unit, KeyID: keyID,
				Type: "topup", Unit: unit, Amount: amount, BalanceAfter: amount,
			})
		}
		if err := s.repository.UpsertBalance(ctx, balances); err != nil {
			return dto.IssuedKeyView{}, err
		}
		if err := s.repository.SaveConsumerLedger(ctx, ledgers); err != nil {
			return dto.IssuedKeyView{}, err
		}
	}
	return dto.IssuedKeyView{KeyID: keyID, Secret: secret, Alias: row.Alias, ExpiresAt: row.ExpiresAt}, nil
}

// AuthenticateKey 校验密钥。四种拒绝各有自己的错误码，客户端据此决定重试还是续期。
func (s *service) AuthenticateKey(ctx context.Context, secret string) (dto.Caller, error) {
	secret = strings.TrimSpace(strings.TrimPrefix(secret, "Bearer "))
	if secret == "" {
		return dto.Caller{}, contract.NewUnitError(contract.ErrorClassBilling, contract.CodeKeyInvalid, false, "缺少算力密钥")
	}
	row, err := s.repository.FindConsumerKeyByHash(ctx, bizLine, HashSecret(secret))
	if notFound(err) {
		return dto.Caller{}, contract.NewUnitError(contract.ErrorClassBilling, contract.CodeKeyInvalid, false, "密钥不存在或已吊销")
	}
	if err != nil {
		return dto.Caller{}, err
	}
	switch row.Status {
	case keyStatusRevoked:
		return dto.Caller{}, contract.NewUnitError(contract.ErrorClassBilling, contract.CodeKeyInvalid, false, "密钥已吊销")
	case keyStatusExpired, keyStatusFrozen:
		return dto.Caller{}, contract.NewUnitError(contract.ErrorClassBilling, contract.CodeKeyExpired, false, "密钥已过期，请续期或换发")
	}
	if !row.ExpiresAt.IsZero() && !time.Now().Before(row.ExpiresAt) {
		// 到期还没被巡检扫到：请求路径上顺手把状态改过来，语义与巡检一致。
		_ = s.repository.UpdateConsumerKey(ctx, bizLine, row.KeyID, map[string]any{
			"status": keyStatusExpired, "frozen_until": time.Now().Add(s.config.KeyFreeze),
		})
		return dto.Caller{}, contract.NewUnitError(contract.ErrorClassBilling, contract.CodeKeyExpired, false, "密钥已过期，请续期或换发")
	}
	return dto.Caller{
		KeyID: row.KeyID, OwnerUserID: row.OwnerUserID, Alias: row.Alias,
		AllowedKinds: decodeStrings(row.AllowedKindsJSON), AllowedProviders: decodeStrings(row.AllowedProvidersJSON),
		ModelTier:   decodeStrings(row.ModelTierJSON),
		Concurrency: row.Concurrency, RPM: row.RPM, ExpiresAt: row.ExpiresAt,
	}, nil
}

// AuthorizeRoute 校验一次请求是否落在密钥的允许范围内（kind / provider / 模型档）。
// 范围为空表示不限，方便内测密钥直接放行。
func AuthorizeRoute(caller dto.Caller, route contract.RouteKey) error {
	if len(caller.AllowedKinds) > 0 && !containsString(caller.AllowedKinds, route.Kind) {
		return contract.NewUnitError(contract.ErrorClassBilling, contract.CodeScopeDenied, false,
			fmt.Sprintf("密钥不允许访问能力 %s", route.Kind))
	}
	if len(caller.AllowedProviders) > 0 && !containsString(caller.AllowedProviders, route.Provider) {
		return contract.NewUnitError(contract.ErrorClassBilling, contract.CodeScopeDenied, false,
			fmt.Sprintf("密钥不允许访问 %s", route.Provider))
	}
	if route.Model != "" && len(caller.ModelTier) > 0 && !contract.ModelMatch(route.Model, caller.ModelTier, nil) {
		return contract.NewUnitError(contract.ErrorClassInput, contract.CodeModelNotAllowed, false,
			fmt.Sprintf("密钥不允许使用模型 %s", route.Model))
	}
	return nil
}

func (s *service) DescribeKey(ctx context.Context, keyID string) (dto.ConsumerKeyView, error) {
	row, err := s.repository.FindConsumerKey(ctx, bizLine, keyID)
	if notFound(err) {
		return dto.ConsumerKeyView{}, contract.ErrNotFound
	}
	if err != nil {
		return dto.ConsumerKeyView{}, err
	}
	return s.keyView(ctx, row)
}

func (s *service) ListKeys(ctx context.Context, ownerUserID string) ([]dto.ConsumerKeyView, error) {
	rows, err := s.repository.ListConsumerKeys(ctx, bizLine, ownerUserID)
	if err != nil {
		return nil, err
	}
	views := make([]dto.ConsumerKeyView, 0, len(rows))
	for _, row := range rows {
		view, err := s.keyView(ctx, row)
		if err != nil {
			return nil, err
		}
		views = append(views, view)
	}
	return views, nil
}

func (s *service) keyView(ctx context.Context, row *repository.GalaxyConsumerKey) (dto.ConsumerKeyView, error) {
	balances, err := s.repository.ListBalances(ctx, bizLine, row.KeyID)
	if err != nil {
		return dto.ConsumerKeyView{}, err
	}
	balance := contract.Metering{}
	for _, item := range balances {
		balance[item.Unit] = item.Balance
	}
	kinds, tiers := decodeStrings(row.AllowedKindsJSON), decodeStrings(row.ModelTierJSON)
	return dto.ConsumerKeyView{
		KeyID: row.KeyID, Alias: row.Alias, Status: row.Status,
		Category: scopeCategory(kinds, tiers, row.ModelID), ModelID: row.ModelID,
		Revealable:   row.SecretCipher != "" && s.cipher != nil,
		AllowedKinds: kinds, AllowedProviders: decodeStrings(row.AllowedProvidersJSON),
		ModelTier: tiers, Concurrency: row.Concurrency, RPM: row.RPM,
		IssuedAt: row.IssuedAt, ExpiresAt: row.ExpiresAt, FrozenUntil: row.FrozenUntil, Balance: balance,
	}, nil
}

// RevealKey 取回密钥明文。
//
// 使用端（ownerUserID 非空）只认本人名下的，别人的一律回 ErrNotFound —— 回「无权查看」
// 等于告诉对方这个 keyId 真实存在。吊销了的也不给：拿到一把用不了的明文没有任何用处，
// 只会让它多出现在一个地方。运营（ownerUserID 为空）哪把都能取，吊销的也能，查问题要用。
func (s *service) RevealKey(ctx context.Context, ownerUserID, keyID string) (dto.KeySecretView, error) {
	row, err := s.repository.FindConsumerKey(ctx, bizLine, strings.TrimSpace(keyID))
	if notFound(err) {
		return dto.KeySecretView{}, contract.ErrNotFound
	}
	if err != nil {
		return dto.KeySecretView{}, err
	}
	if ownerUserID != "" {
		if row.OwnerUserID != ownerUserID {
			return dto.KeySecretView{}, contract.ErrNotFound
		}
		if row.Status == keyStatusRevoked {
			return dto.KeySecretView{}, fmt.Errorf("密钥已吊销")
		}
	}
	if row.SecretCipher == "" {
		return dto.KeySecretView{}, fmt.Errorf("这把密钥签发时平台还不保存明文，取不回来；换发一次，新密钥就能查看和一键使用")
	}
	secret, err := s.cipher.open(row.SecretCipher)
	if err != nil {
		return dto.KeySecretView{}, err
	}
	// 解出来的东西再和哈希对一次：密文被人改过、或者配错了一个恰好也能解的密钥，
	// 都不能把一串对不上号的明文当成这把密钥交出去。
	if HashSecret(secret) != row.KeyHash {
		return dto.KeySecretView{}, errKeyCipherMismatch
	}
	return dto.KeySecretView{KeyID: row.KeyID, Secret: secret, BaseURL: s.config.ConsumerBaseURL}, nil
}

// AdminKeys 运营翻全站密钥。主人一页查一次，不按行查。
func (s *service) AdminKeys(ctx context.Context, query dto.AdminKeyQuery) (dto.AdminKeyPage, error) {
	limit := query.Limit
	if limit <= 0 || limit > 200 {
		limit = 20
	}
	offset := query.Offset
	if offset < 0 {
		offset = 0
	}
	rows, total, err := s.repository.ListConsumerKeyPage(ctx, repository.ConsumerKeyPageQuery{
		BizLine: bizLine, OwnerUserID: strings.TrimSpace(query.OwnerUserID),
		Keyword: query.Keyword, Status: strings.TrimSpace(query.Status),
		Offset: offset, Limit: limit,
	})
	if err != nil {
		return dto.AdminKeyPage{}, err
	}
	owners := make([]string, 0, len(rows))
	for _, row := range rows {
		owners = append(owners, row.OwnerUserID)
	}
	names, err := s.userNames(ctx, dto.SideConsumer, owners)
	if err != nil {
		return dto.AdminKeyPage{}, err
	}
	page := dto.AdminKeyPage{Total: total, Keys: make([]dto.AdminKeyView, 0, len(rows))}
	for _, row := range rows {
		view, err := s.keyView(ctx, row)
		if err != nil {
			return dto.AdminKeyPage{}, err
		}
		page.Keys = append(page.Keys, dto.AdminKeyView{
			ConsumerKeyView: view, OwnerUserID: row.OwnerUserID, OwnerName: names[row.OwnerUserID], OrderID: row.OrderID,
		})
	}
	return page, nil
}

func (s *service) RevokeKey(ctx context.Context, ownerUserID, keyID string) error {
	row, err := s.repository.FindConsumerKey(ctx, bizLine, keyID)
	if notFound(err) {
		return contract.ErrNotFound
	}
	if err != nil {
		return err
	}
	if ownerUserID != "" && row.OwnerUserID != ownerUserID {
		return fmt.Errorf("无权操作该密钥")
	}
	return s.repository.UpdateConsumerKey(ctx, bizLine, keyID, map[string]any{"status": keyStatusRevoked})
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func defaultString(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}
