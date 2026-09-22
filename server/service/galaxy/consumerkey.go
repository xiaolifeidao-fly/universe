package galaxy

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 算力密钥：使用者自助签发，绑定有效期、允许范围与**模型分组**（C-01）。
//
// 分组是 2026-09-22 加的，也是自助签发唯一的新硬前置：中转按分组走，
// 一把没选分组的密钥回答不了「这次请求按哪份价收、共享者该不该接」。
//
// 密钥**不带额度**。额度是账户里的积分余额，名下几把密钥花的是同一份钱 ——
// 所以新建一把不会多出任何额度，吊销一把也不会损失额度，换一把只是换一串凭证。
// 这正是它们能随手新建、随手作废的前提。
const (
	keyStatusActive  = "active"
	keyStatusExpired = "expired"
	keyStatusFrozen  = "frozen"
	keyStatusRevoked = "revoked"

	// maxConsumerKeys 一个人最多几把**有效**密钥。
	//
	// 有上限不是怕表大，是怕丢：明文只在本机保险箱里留一份，人手上的密钥越多，
	// 越说不清哪把接在哪台机器上、哪把早就该废了。吊销或到期的不算在内 ——
	// 那些已经用不了了，占着名额只会逼人去先清理历史。
	maxConsumerKeys = 5
)

// usableKey 这把密钥此刻还能不能用。巡检把到期的改成 expired 有延迟，
// 所以到期时间要再判一次 —— 否则一把刚过期的还占着名额。
func usableKey(row *repository.GalaxyConsumerKey, now time.Time) bool {
	if row.Status != keyStatusActive {
		return false
	}
	return row.ExpiresAt.IsZero() || now.Before(row.ExpiresAt)
}

// CreateConsumerKey 使用者自己新建一把密钥。
//
// 和运营手签走同一条签发路径（IssueKey），只多一道名额判定：
// 两条路各写一遍签发逻辑的话，数据告知这类硬前置迟早只剩一边还在做。
func (s *service) CreateConsumerKey(ctx context.Context, req dto.CreateConsumerKeyRequest) (dto.IssuedKeyView, error) {
	userID := strings.TrimSpace(req.UserID)
	if userID == "" {
		return dto.IssuedKeyView{}, contract.ErrNotFound
	}
	rows, err := s.repository.ListConsumerKeys(ctx, bizLine, userID)
	if err != nil {
		return dto.IssuedKeyView{}, err
	}
	now := time.Now()
	live := 0
	for _, row := range rows {
		if usableKey(row, now) {
			live++
		}
	}
	if live >= maxConsumerKeys {
		return dto.IssuedKeyView{}, fmt.Errorf("最多只能有 %d 把有效密钥，先让一把失效再新建", maxConsumerKeys)
	}
	// 分组必选。中转按分组走：没选分组的密钥调任何模型都答不上「按哪份价收」，
	// 只能落到默认分组 —— 而那是迁移期给存量密钥留的退路，不该继续签出新的来。
	//
	// 拦在这里而不是只在界面上拦：签发有三条路（自助、运营代签、注册即送），
	// 界面拦一道，另外两条照样能发出没有分组的密钥。
	if len(req.Groups) == 0 {
		return dto.IssuedKeyView{}, errors.New("先选好要用的模型分组再创建密钥")
	}
	groups, err := s.validateKeyGroups(ctx, req.Groups)
	if err != nil {
		return dto.IssuedKeyView{}, err
	}
	return s.IssueKey(ctx, dto.IssueKeyRequest{
		OwnerUserID: userID, Alias: req.Alias, NoticeVersion: req.NoticeVersion, Groups: groups,
	})
}

// IssueKey 签发密钥。数据告知的确认是硬前置（C-13）：
// 请求数据会经第三方提供者机器处理，消费者必须先确认。
func (s *service) IssueKey(ctx context.Context, req dto.IssueKeyRequest) (dto.IssuedKeyView, error) {
	if req.NoticeVersion != s.cfg().ConsumerNoticeVersion {
		return dto.IssuedKeyView{}, fmt.Errorf("数据告知版本已更新，请重新确认")
	}
	agreed, err := s.HasConsent(ctx, subjectConsumer, req.OwnerUserID, req.NoticeVersion)
	if err != nil {
		return dto.IssuedKeyView{}, err
	}
	if !agreed {
		return dto.IssuedKeyView{}, contract.ErrConsentRequired
	}
	// 运营代签可以不选分组（那时每个模型走默认分组），但选了就必须是真的分组：
	// 一个拼错的 mg_… 会让这把密钥调不动任何模型，而报出来的只有「模型不允许」。
	groups, err := s.validateKeyGroups(ctx, req.Groups)
	if err != nil {
		return dto.IssuedKeyView{}, err
	}
	req.Groups = groups
	return s.signKey(ctx, req)
}

// registrationKeyAlias 注册送的那把密钥叫什么。名字是给人看的，
// 它要自己说清楚「这把不是你建的，是注册时就在那儿的」。
const registrationKeyAlias = "默认密钥"

// IssueRegistrationKey 新注册的使用端账号默认带的那一把。
//
// 这是**唯一**不过数据告知那道闸的签发路径，绕过是有意的：注册那一刻人还没看过
// 告知，而口径是新账号一进控制台就该有一把能用的密钥，不必先读一段话、再点一次
// 「新建」。告知本身没有被取消 —— 密钥页上那条横幅照常挂着直到本人确认，
// 自助新建（CreateConsumerKey）和运营代签（IssueKey）也照常要先确认。
//
// 代价记在库里：这把密钥的 notice_version 是空的、notice_ack_at 是 NULL，
// 所以「哪些密钥是没经确认就发出去的」随时查得出来，不用靠猜。
func (s *service) IssueRegistrationKey(ctx context.Context, ownerUserID string) (dto.IssuedKeyView, error) {
	owner := strings.TrimSpace(ownerUserID)
	if owner == "" {
		return dto.IssuedKeyView{}, contract.ErrNotFound
	}
	// 范围留空 = 不限：注册送的这把要能直接接 Claude Code 或 Codex，
	// 挑一边写死，另一边的人第一次用就撞墙。
	//
	// 分组同样留空 —— 注册那一刻没人选得了分组，而每个模型都有默认分组兜着。
	// 这是**第二条**不选分组的路径，和数据告知那道闸一样是有意绕过的：
	// 新账号一进控制台就该有一把能用的密钥。想换档次就自己新建一把（那条路必选分组）。
	return s.signKey(ctx, dto.IssueKeyRequest{OwnerUserID: owner, Alias: registrationKeyAlias})
}

// signKey 真正写出一行密钥。三条签发路径（自助、运营代签、注册即送）都收口在这里：
// 有效期、并发、RPM 这些默认值各写一遍的话，迟早只剩一边是对的。
//
// 告知那两列一起写：有版本才有确认时间，没版本就是那把注册送的，两列都空着。
func (s *service) signKey(ctx context.Context, req dto.IssueKeyRequest) (dto.IssuedKeyView, error) {
	now := time.Now()
	ttl := s.cfg().KeyTTL
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
		GroupsJSON:           encodeJSON(req.Groups),
		Concurrency:          defaultInt(req.Concurrency, s.cfg().KeyConcurrency),
		RPM:                  defaultInt(req.RPM, s.cfg().KeyRPM),
		Status:               keyStatusActive,
		IssuedAt:             now,
		ExpiresAt:            now.Add(ttl),
		NoticeVersion:        req.NoticeVersion,
	}
	if req.NoticeVersion != "" {
		row.NoticeAckAt = &now
	}
	if err := s.repository.CreateConsumerKey(ctx, row); err != nil {
		return dto.IssuedKeyView{}, err
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
			"status": keyStatusExpired, "frozen_until": time.Now().Add(s.cfg().KeyFreeze),
		})
		return dto.Caller{}, contract.NewUnitError(contract.ErrorClassBilling, contract.CodeKeyExpired, false, "密钥已过期，请续期或换发")
	}
	if err := s.requireBalance(ctx, row.OwnerUserID); err != nil {
		return dto.Caller{}, err
	}
	return dto.Caller{
		KeyID: row.KeyID, OwnerUserID: row.OwnerUserID, Alias: row.Alias,
		AllowedKinds: decodeStrings(row.AllowedKindsJSON), AllowedProviders: decodeStrings(row.AllowedProvidersJSON),
		ModelTier:   decodeStrings(row.ModelTierJSON),
		Groups:      decodeStrings(row.GroupsJSON),
		Concurrency: row.Concurrency, RPM: row.RPM, ExpiresAt: row.ExpiresAt,
	}, nil
}

// AuthorizeRoute 校验一次请求是否落在密钥的允许范围内（kind / provider / 模型档）。
// 范围为空表示不限，方便内测密钥直接放行。
func AuthorizeRoute(caller dto.Caller, route contract.RouteKey) error {
	if !kindAllowed(caller.AllowedKinds, route.Kind) {
		return contract.NewUnitError(contract.ErrorClassBilling, contract.CodeScopeDenied, false,
			fmt.Sprintf("密钥不允许访问能力 %s", route.Kind))
	}
	if len(caller.AllowedProviders) > 0 && !containsString(caller.AllowedProviders, route.Provider) {
		return contract.NewUnitError(contract.ErrorClassBilling, contract.CodeScopeDenied, false,
			fmt.Sprintf("密钥不允许访问 %s", route.Provider))
	}
	if !modelAllowed(caller.ModelTier, route.Model) {
		return contract.NewUnitError(contract.ErrorClassInput, contract.CodeModelNotAllowed, false,
			fmt.Sprintf("密钥不允许使用模型 %s", route.Model))
	}
	return nil
}

// kindAllowed / modelAllowed 是上面那两道判定，单拎出来给**下单时**复用。
//
// 额度按模型分账之后，「这把密钥调不调得动这个模型」不再只是请求路径上的事：
// 买一份 Opus 的额度充进一把只允许 Haiku 的密钥，额度**到手即死** ——
// 余额写进去了，请求却被这两道挡下来，钱花了一点东西都换不到。
// 所以下单时要先问一遍，而问的必须是同一套规则：各写一份的话，
// 迟早有一天买得进去、用不出来，而那时没有任何报错指向这里。
//
// 上游（provider）那一道没有抽出来：下单时还不知道这一单将来会落到哪台机器上。
func kindAllowed(allowed []string, kind string) bool {
	return len(allowed) == 0 || kind == "" || containsString(allowed, kind)
}

func modelAllowed(tiers []string, model string) bool {
	return model == "" || len(tiers) == 0 || contract.ModelMatch(model, tiers, nil)
}

func (s *service) DescribeKey(ctx context.Context, keyID string) (dto.ConsumerKeyView, error) {
	row, err := s.repository.FindConsumerKey(ctx, bizLine, keyID)
	if notFound(err) {
		return dto.ConsumerKeyView{}, contract.ErrNotFound
	}
	if err != nil {
		return dto.ConsumerKeyView{}, err
	}
	return s.keyView(ctx, row), nil
}

func (s *service) ListKeys(ctx context.Context, ownerUserID string) ([]dto.ConsumerKeyView, error) {
	rows, err := s.repository.ListConsumerKeys(ctx, bizLine, ownerUserID)
	if err != nil {
		return nil, err
	}
	views := make([]dto.ConsumerKeyView, 0, len(rows))
	for _, row := range rows {
		views = append(views, s.keyView(ctx, row))
	}
	return views, nil
}

func (s *service) keyView(ctx context.Context, row *repository.GalaxyConsumerKey) dto.ConsumerKeyView {
	kinds, tiers := decodeStrings(row.AllowedKindsJSON), decodeStrings(row.ModelTierJSON)
	return dto.ConsumerKeyView{
		KeyID: row.KeyID, Alias: row.Alias, Status: row.Status,
		Category: scopeCategory(kinds, tiers, row.ModelID), ModelID: row.ModelID,
		Revealable:   row.SecretCipher != "" && s.cipher != nil,
		AllowedKinds: kinds, AllowedProviders: decodeStrings(row.AllowedProvidersJSON),
		ModelTier: tiers, Groups: s.keyGroupViews(ctx, decodeStrings(row.GroupsJSON)),
		Concurrency: row.Concurrency, RPM: row.RPM,
		IssuedAt: row.IssuedAt, ExpiresAt: row.ExpiresAt, FrozenUntil: row.FrozenUntil,
	}
}

// requireBalance 余额闸：账上没钱就不放请求进来。
//
// 拦在认证这一步，而不是等结算时发现扣不动 —— 请求已经跑完了才说「你没钱」，
// 算力已经被别人的机器烧掉了，那笔钱只能记成坏账。
//
// 判的是 **> 0** 而不是「够这一次」：一次请求要花多少，要等它跑完、
// 数清了 token 才知道，认证这一刻没人算得出来。所以最后一次调用允许把余额
// 花成负数（见 billing.go 的 chargeUsage），下一次就在这里被挡住。
// 差额最多是一次请求的钱，代价换来的是「余额=0 仍然能跑完手上这一句」。
func (s *service) requireBalance(ctx context.Context, ownerUserID string) error {
	account, err := s.repository.FindPointsAccount(ctx, bizLine, strings.TrimSpace(ownerUserID))
	if err != nil && !notFound(err) {
		return err
	}
	if account != nil && account.Balance > 0 {
		return nil
	}
	return contract.NewUnitError(contract.ErrorClassBilling, contract.CodeInsufficientBalance, false,
		"账户余额不足，请联系运营充值")
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
	return dto.KeySecretView{KeyID: row.KeyID, Secret: secret, BaseURL: s.cfg().ConsumerBaseURL}, nil
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
	// 余额一页查一次。密钥自己没有额度了，运营排查「这把为什么调不动」
	// 第一眼要看的就是主人账上还有没有钱。
	balances, err := s.repository.SumPointsBalances(ctx, bizLine, owners)
	if err != nil {
		return dto.AdminKeyPage{}, err
	}
	page := dto.AdminKeyPage{Total: total, Keys: make([]dto.AdminKeyView, 0, len(rows))}
	for _, row := range rows {
		page.Keys = append(page.Keys, dto.AdminKeyView{
			ConsumerKeyView: s.keyView(ctx, row), OwnerUserID: row.OwnerUserID,
			OwnerName: names[row.OwnerUserID], Balance: balances[row.OwnerUserID], OrderID: row.OrderID,
		})
	}
	return page, nil
}

// RenewKey 换发：签一把新密钥继承允许范围，旧密钥立刻作废。
//
// 为什么不是「把旧密钥的 expires_at 往后推」：密钥明文可能已经泄露、或者散落在
// 好几台机器的配置里，到期是收回它的唯一时机。换发让旧明文彻底作废。
//
// 额度不跟着走 —— 它本来就不在密钥上。所以过了冻结期也照样能换发：
// 原先拦这一下是怕余额转移得太晚，现在换发只是换一串凭证，没有东西会丢。
func (s *service) RenewKey(ctx context.Context, req dto.RenewKeyRequest) (dto.IssuedKeyView, error) {
	old, err := s.repository.FindConsumerKey(ctx, bizLine, req.KeyID)
	if notFound(err) {
		return dto.IssuedKeyView{}, contract.ErrNotFound
	}
	if err != nil {
		return dto.IssuedKeyView{}, err
	}
	if req.OwnerUserID != "" && old.OwnerUserID != req.OwnerUserID {
		return dto.IssuedKeyView{}, fmt.Errorf("无权操作该密钥")
	}
	if old.Status == keyStatusRevoked {
		return dto.IssuedKeyView{}, fmt.Errorf("密钥已失效，请新建一把")
	}
	now := time.Now()
	ttl := s.cfg().KeyTTL
	if req.TTLDays > 0 {
		ttl = time.Duration(req.TTLDays) * 24 * time.Hour
	}
	secret := "sk-galaxy-" + randomToken(32)
	keyID := "ck_" + NewULID(now)
	fresh := &repository.GalaxyConsumerKey{
		BizLine: bizLine, KeyID: keyID, KeyHash: HashSecret(secret), SecretCipher: s.sealSecret(secret),
		Alias: old.Alias, OwnerUserID: old.OwnerUserID, OrderID: old.OrderID, ModelID: old.ModelID,
		AllowedKindsJSON: old.AllowedKindsJSON, AllowedProvidersJSON: old.AllowedProvidersJSON,
		ModelTierJSON: old.ModelTierJSON, GroupsJSON: old.GroupsJSON,
		Concurrency: old.Concurrency, RPM: old.RPM,
		Status: keyStatusActive, IssuedAt: now, ExpiresAt: now.Add(ttl),
		RenewedFrom: old.KeyID,
		// 告知版本跟着走：同意的是同一个人、同一份告知，不必重新确认。
		NoticeVersion: old.NoticeVersion, NoticeAckAt: old.NoticeAckAt,
	}
	if err := s.repository.CreateConsumerKey(ctx, fresh); err != nil {
		return dto.IssuedKeyView{}, err
	}
	// 旧密钥立刻作废：换发的意义就是让旧明文不再能用。
	if err := s.repository.UpdateConsumerKey(ctx, bizLine, old.KeyID, map[string]any{
		"status": keyStatusFrozen, "frozen_until": now,
	}); err != nil {
		return dto.IssuedKeyView{}, err
	}
	return dto.IssuedKeyView{KeyID: keyID, Secret: secret, Alias: fresh.Alias, ExpiresAt: fresh.ExpiresAt}, nil
}

// RevokeKey 让一把密钥立刻失效。不可逆 —— 要再用就新建一把。
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
