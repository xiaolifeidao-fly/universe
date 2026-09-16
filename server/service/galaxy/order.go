package galaxy

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"gorm.io/gorm"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 额度商品、订单与密钥续期换发（P1）。
//
// 支付与履约刻意分成两步：回调只把订单推到 paid，履约（签发密钥 / 充值）由幂等的
// fulfil 负责。支付渠道的回调重放是常态，把两件事揉在一个事务里，重放一次就多发一把密钥。

const (
	orderPending   = "pending"
	orderPaid      = "paid"
	orderFulfilled = "fulfilled"
	orderCancelled = "cancelled"

	// 订单怎么付的。积分那一路不经过任何渠道，扣积分和推到 paid 在同一个事务里。
	payByPoints  = "points"
	payByChannel = "channel"
)

func (s *service) ListPackages(ctx context.Context, listedOnly bool) ([]dto.PackageView, error) {
	rows, err := s.repository.ListPackages(ctx, bizLine, listedOnly)
	if err != nil {
		return nil, err
	}
	views := make([]dto.PackageView, 0, len(rows))
	for _, row := range rows {
		views = append(views, packageView(row))
	}
	return views, nil
}

func packageView(row *repository.GalaxyPackage) dto.PackageView {
	kinds := decodeStrings(row.AllowedKindsJSON)
	tiers := decodeStrings(row.ModelTierJSON)
	return dto.PackageView{
		PackageCode: row.PackageCode, Title: row.Title, Units: decodeMetering(row.UnitsJSON),
		Amount: row.Amount, Currency: row.Currency, TTLDays: row.TTLDays,
		AllowedKinds: kinds, ModelTier: tiers,
		Concurrency: row.Concurrency, RPM: row.RPM, ModelID: row.ModelID,
		Category: scopeCategory(kinds, tiers, row.ModelID),
		Listed:   row.Listed, SortOrder: row.SortOrder,
	}
}

// scopeCategory 一份额度包（或它签发出来的密钥）属于哪一类算力：claude / codex / video / other。
//
// 按模型档而不是按 kind 分：llm.chat 下面同时有 Claude 和 Codex，光看 kind
// 会把两类商品堆进同一栏。模型档没说清楚时再看绑定的模型 —— 运营常常只绑了模型、
// 没去填模型档。两样都没有（范围不限）的归 other：它什么都能用，硬塞进某一栏反而是错的。
//
// 密钥页的「使用」按钮也按它决定写 Claude Code 还是 Codex 的配置，所以规则只在这一处。
func scopeCategory(kinds, tiers []string, modelID string) string {
	for _, kind := range kinds {
		if strings.HasPrefix(kind, "video.") {
			return "video"
		}
	}
	for _, tier := range tiers {
		switch pattern := strings.ToLower(tier); {
		case strings.HasPrefix(pattern, "claude"):
			return "claude"
		case strings.HasPrefix(pattern, "gpt"), strings.HasPrefix(pattern, "o1"), strings.Contains(pattern, "codex"):
			return "codex"
		}
	}
	if strings.TrimSpace(modelID) != "" {
		family, _ := inferFamily(modelID)
		return familyCategory(family)
	}
	return "other"
}

// familyCategory 模型族 → 使用端的类别。gpt 一族在使用端叫 codex：Orbit 上接它的就是 Codex CLI。
func familyCategory(family string) string {
	switch family {
	case "claude":
		return "claude"
	case "gpt":
		return "codex"
	default:
		return "other"
	}
}

func (s *service) SavePackage(ctx context.Context, req dto.SavePackageRequest) error {
	if len(req.Units) == 0 {
		return fmt.Errorf("商品必须声明额度")
	}
	modelID := strings.TrimSpace(req.ModelID)
	if modelID != "" {
		// 绑一个目录里没有的模型，返现就只能悄悄回落到默认比例，而运营以为设的是那个模型的。
		//
		// 只在「改绑」时查：模型删掉之后还挂着它的老套餐照样要能下架、改价 ——
		// 整行覆盖会把原来的绑定原样带回来，这时候拒掉，运营就只能先解绑才能下架。
		current, err := s.repository.FindPackage(ctx, bizLine, req.PackageCode)
		if err != nil && !notFound(err) {
			return err
		}
		if current == nil || current.ModelID != modelID {
			if _, err := s.repository.FindModel(ctx, bizLine, modelID); notFound(err) {
				return fmt.Errorf("模型目录里没有 %s，先在模型目录里建好再绑定", modelID)
			} else if err != nil {
				return err
			}
		}
	}
	listed := true
	if req.Listed != nil {
		listed = *req.Listed
	}
	return s.repository.SavePackage(ctx, &repository.GalaxyPackage{
		BizLine: bizLine, PackageCode: req.PackageCode, Title: truncate(req.Title, 128),
		UnitsJSON: encodeJSON(req.Units), Amount: req.Amount,
		Currency: defaultString(req.Currency, "CNY"), TTLDays: defaultInt(req.TTLDays, 30),
		AllowedKindsJSON: encodeJSON(req.AllowedKinds), ModelTierJSON: encodeJSON(req.ModelTier),
		Concurrency: defaultInt(req.Concurrency, s.cfg().KeyConcurrency),
		RPM:         defaultInt(req.RPM, s.cfg().KeyRPM),
		ModelID:     modelID,
		Listed:      listed, SortOrder: req.SortOrder,
	})
}

// CreateOrder 下单。额度快照在这一刻定死：商品之后改价改量都不影响已下的单。
func (s *service) CreateOrder(ctx context.Context, req dto.CreateOrderRequest) (dto.OrderView, error) {
	row, err := s.createOrder(ctx, req, payByChannel)
	if err != nil {
		return dto.OrderView{}, err
	}
	return orderView(row, ""), nil
}

// createOrder 建一张待支付的单子。渠道支付和积分购买共用它，校验只写一份。
func (s *service) createOrder(ctx context.Context, req dto.CreateOrderRequest, payMethod string) (*repository.GalaxyOrder, error) {
	item, err := s.repository.FindPackage(ctx, bizLine, req.PackageCode)
	if notFound(err) {
		return nil, fmt.Errorf("额度商品不存在")
	}
	if err != nil {
		return nil, err
	}
	if !item.Listed {
		return nil, fmt.Errorf("该额度商品已下架")
	}

	if req.TargetKeyID != "" {
		// 充值到已有密钥：先确认这把密钥是本人的，且还能收额度。
		key, err := s.repository.FindConsumerKey(ctx, bizLine, req.TargetKeyID)
		if notFound(err) {
			return nil, contract.ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		if key.OwnerUserID != req.UserID {
			return nil, fmt.Errorf("无权给该密钥充值")
		}
		if key.Status == keyStatusRevoked {
			return nil, fmt.Errorf("密钥已吊销，请改为签发新密钥")
		}
	} else {
		// 要签发新密钥：数据告知的确认是硬前置，下单时就挡住，
		// 别等到支付完成才发现发不出密钥（C-13）。
		if err := s.requireConsumerNotice(ctx, req.UserID, req.NoticeVersion); err != nil {
			return nil, err
		}
	}

	now := time.Now()
	row := &repository.GalaxyOrder{
		BizLine: bizLine, OrderID: "o_" + NewULID(now), UserID: req.UserID,
		PackageCode: item.PackageCode, Amount: item.Amount, Currency: item.Currency,
		UnitsJSON: item.UnitsJSON, TargetKeyID: req.TargetKeyID, Status: orderPending,
		ModelID: item.ModelID, PayMethod: payMethod,
	}
	if err := s.repository.CreateOrder(ctx, row); err != nil {
		return nil, err
	}
	return row, nil
}

func (s *service) requireConsumerNotice(ctx context.Context, userID, version string) error {
	if version == "" {
		version = s.cfg().ConsumerNoticeVersion
	}
	if version != s.cfg().ConsumerNoticeVersion {
		return fmt.Errorf("数据告知版本已更新，请重新确认")
	}
	agreed, err := s.HasConsent(ctx, subjectConsumer, userID, version)
	if err != nil {
		return err
	}
	if !agreed {
		return contract.ErrConsentRequired
	}
	return nil
}

// PayOrder 支付回调。重放安全：第二次调用发现订单已经不是 pending，直接返回当前状态。
func (s *service) PayOrder(ctx context.Context, req dto.PayOrderRequest) (dto.OrderView, error) {
	moved, err := s.repository.MarkOrderPaid(ctx, bizLine, req.OrderID, req.PaymentRef, time.Now())
	if err != nil {
		return dto.OrderView{}, err
	}
	if !moved {
		row, err := s.repository.FindOrder(ctx, bizLine, req.OrderID)
		if notFound(err) {
			return dto.OrderView{}, contract.ErrNotFound
		}
		if err != nil {
			return dto.OrderView{}, err
		}
		if row.Status == orderCancelled {
			return dto.OrderView{}, fmt.Errorf("订单已取消")
		}
		// 已经付过并履约过：把当前状态还回去，不重复发额度。
		return orderView(row, ""), nil
	}
	view, err := s.fulfilOrder(ctx, req.OrderID)
	if err != nil {
		return dto.OrderView{}, err
	}
	s.rewardReferrer(ctx, req.OrderID)
	return view, nil
}

// fulfilOrder 履约：签发新密钥或给已有密钥充值。
// 状态机的条件更新保证同一订单只履约一次，并发调用只有一个能赢。
func (s *service) fulfilOrder(ctx context.Context, orderID string) (dto.OrderView, error) {
	row, err := s.repository.FindOrder(ctx, bizLine, orderID)
	if notFound(err) {
		return dto.OrderView{}, contract.ErrNotFound
	}
	if err != nil {
		return dto.OrderView{}, err
	}
	if row.Status == orderFulfilled {
		return orderView(row, ""), nil
	}
	if row.Status != orderPaid {
		return dto.OrderView{}, fmt.Errorf("订单尚未支付")
	}

	units := decodeMetering(row.UnitsJSON)
	secret := ""
	keyID := row.TargetKeyID

	if keyID == "" {
		item, err := s.repository.FindPackage(ctx, bizLine, row.PackageCode)
		if err != nil && !notFound(err) {
			return dto.OrderView{}, err
		}
		issue := dto.IssueKeyRequest{
			OwnerUserID: row.UserID, Alias: row.PackageCode,
			Grants: units, NoticeVersion: s.cfg().ConsumerNoticeVersion,
			ModelID: row.ModelID,
		}
		if item != nil {
			issue.TTLDays = item.TTLDays
			issue.AllowedKinds = decodeStrings(item.AllowedKindsJSON)
			issue.ModelTier = decodeStrings(item.ModelTierJSON)
			issue.Concurrency = item.Concurrency
			issue.RPM = item.RPM
		}
		issued, err := s.IssueKey(ctx, issue)
		if err != nil {
			return dto.OrderView{}, err
		}
		keyID, secret = issued.KeyID, issued.Secret
	} else if err := s.topUp(ctx, keyID, units, row.OrderID); err != nil {
		return dto.OrderView{}, err
	}

	done, err := s.repository.MarkOrderFulfilled(ctx, bizLine, orderID, keyID, time.Now())
	if err != nil {
		return dto.OrderView{}, err
	}
	if !done {
		// 被并发的另一次履约抢先了。它已经把额度发出去了，这里不能再发一遍。
		current, err := s.repository.FindOrder(ctx, bizLine, orderID)
		if err != nil {
			return dto.OrderView{}, err
		}
		return orderView(current, ""), nil
	}
	row.Status = orderFulfilled
	row.KeyID = keyID
	return orderView(row, secret), nil
}

// topUp 给已有密钥充额度，并记一笔消费侧账本。
func (s *service) topUp(ctx context.Context, keyID string, units contract.Metering, txnPrefix string) error {
	balances := make([]*repository.GalaxyConsumerBalance, 0, len(units))
	ledgers := make([]*repository.GalaxyConsumerLedger, 0, len(units))
	for _, unit := range units.Units() {
		amount := units[unit]
		if amount <= 0 {
			continue
		}
		balances = append(balances, &repository.GalaxyConsumerBalance{
			BizLine: bizLine, KeyID: keyID, Unit: unit, Balance: amount,
		})
		ledgers = append(ledgers, &repository.GalaxyConsumerLedger{
			BizLine: bizLine, TxnID: txnPrefix + ":topup:" + unit, KeyID: keyID,
			Type: "topup", Unit: unit, Amount: amount,
		})
	}
	if err := s.repository.UpsertBalance(ctx, balances); err != nil {
		return err
	}
	return s.repository.SaveConsumerLedger(ctx, ledgers)
}

func (s *service) ListOrders(ctx context.Context, userID string, limit int) ([]dto.OrderView, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.repository.ListOrders(ctx, bizLine, userID, limit)
	if err != nil {
		return nil, err
	}
	views := make([]dto.OrderView, 0, len(rows))
	for _, row := range rows {
		views = append(views, orderView(row, ""))
	}
	return views, nil
}

func (s *service) CancelOrder(ctx context.Context, userID, orderID string) error {
	err := s.repository.CancelOrder(ctx, bizLine, userID, orderID)
	if notFound(err) {
		return fmt.Errorf("订单不存在或已不能取消")
	}
	return err
}

func orderView(row *repository.GalaxyOrder, secret string) dto.OrderView {
	return dto.OrderView{
		OrderID: row.OrderID, PackageCode: row.PackageCode, Units: decodeMetering(row.UnitsJSON),
		Amount: row.Amount, Currency: row.Currency, Status: row.Status,
		PayMethod: defaultString(row.PayMethod, payByChannel), ModelID: row.ModelID,
		TargetKeyID: row.TargetKeyID, KeyID: row.KeyID,
		PaidAt: row.PaidAt, FulfilledAt: row.FulfilledAt, CreatedTime: row.CreatedTime,
		IssuedSecret: secret,
	}
}

// RenewKey 续期换发：签一把新密钥，把旧密钥的余额与允许范围整体转过去，旧密钥冻结。
//
// 为什么不是「把旧密钥的 expires_at 往后推」：密钥明文可能已经泄露或散落在多台机器的
// 配置里，到期是收回它的唯一时机。换发让旧明文彻底作废，同时不让用户损失余额。
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
	now := time.Now()
	switch old.Status {
	case keyStatusRevoked:
		return dto.IssuedKeyView{}, fmt.Errorf("密钥已吊销，不能续期")
	case keyStatusExpired, keyStatusFrozen:
		// 冻结期内才可换发；冻结期满余额按积分规则处理，不再跟着走。
		if old.FrozenUntil == nil || now.After(*old.FrozenUntil) {
			return dto.IssuedKeyView{}, fmt.Errorf("冻结期已过，余额不再可转移，请重新购买")
		}
	}

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
		ModelTierJSON: old.ModelTierJSON, Concurrency: old.Concurrency, RPM: old.RPM,
		Status: keyStatusActive, IssuedAt: now, ExpiresAt: now.Add(ttl),
		RenewedFrom: old.KeyID,
		// 告知版本跟着走：同意的是同一个人、同一份告知，不必重新确认。
		NoticeVersion: old.NoticeVersion, NoticeAckAt: old.NoticeAckAt,
	}
	if err := s.repository.CreateConsumerKey(ctx, fresh); err != nil {
		return dto.IssuedKeyView{}, err
	}

	moved, err := s.repository.TransferBalances(ctx, bizLine, old.KeyID, keyID)
	if err != nil {
		return dto.IssuedKeyView{}, err
	}
	ledgers := make([]*repository.GalaxyConsumerLedger, 0, len(moved)*2)
	for _, balance := range moved {
		ledgers = append(ledgers,
			&repository.GalaxyConsumerLedger{
				BizLine: bizLine, TxnID: keyID + ":renew:out:" + balance.Unit, KeyID: old.KeyID,
				Type: "expire", Unit: balance.Unit, Amount: -balance.Balance,
			},
			&repository.GalaxyConsumerLedger{
				BizLine: bizLine, TxnID: keyID + ":renew:in:" + balance.Unit, KeyID: keyID,
				Type: "topup", Unit: balance.Unit, Amount: balance.Balance, BalanceAfter: balance.Balance,
			})
	}
	if err := s.repository.SaveConsumerLedger(ctx, ledgers); err != nil {
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

var _ = gorm.ErrRecordNotFound

// PaymentChannels 这套部署接了哪些渠道，供控制台渲染收银台。
//
// 验签器说不出自己有哪些渠道时返回空 —— 界面据此退回「由平台确认到账」的老话术，
// 而不是编一个渠道名出来。
func (s *service) PaymentChannels() []PaymentChannel {
	directory, ok := s.payment.(PaymentDirectory)
	if !ok {
		return nil
	}
	return directory.Channels()
}

// PaymentEnabled 有没有可以接收外部回调的**已验签**渠道，供路由决定要不要挂回调。
//
// 沙箱渠道不算数：它压根不接受外部回调（见 payments.Registry.Verify），
// 只因为有个沙箱就把未鉴权的回调路由挂上去，是白白多开一个入口。
func (s *service) PaymentEnabled() bool {
	if s.payment == nil {
		return false
	}
	channels := s.PaymentChannels()
	if len(channels) == 0 {
		// 没实现 PaymentDirectory 的验签器：说不出自己有哪些渠道，按已接入处理。
		return true
	}
	for _, channel := range channels {
		if !channel.Sandbox {
			return true
		}
	}
	return false
}

// PaySandbox 沙箱支付：本人在控制台点一下，订单直接算已付并履约。
//
// 它绕过验签是**故意**的 —— 沙箱渠道背后没有收银台，没有任何签名可验。
// 换来的安全边界靠另外三条撑着，缺一条这就是个免费发额度的接口：
//
//  1. 渠道必须在配置里被显式标成沙箱（galaxy.payment.sandbox_channels），
//     一个没配沙箱的部署调这里只会拿到错误。
//  2. 调用方是登录用户，且订单必须是他自己的 —— 拿别人的订单号点不动。
//  3. 履约仍走 PayOrder 那套状态机，重复点击不会重复发额度。
func (s *service) PaySandbox(ctx context.Context, req dto.PaySandboxRequest) (dto.OrderView, error) {
	channel, err := s.resolveSandboxChannel(req.Channel)
	if err != nil {
		return dto.OrderView{}, err
	}
	row, err := s.repository.FindOrder(ctx, bizLine, req.OrderID)
	if notFound(err) {
		return dto.OrderView{}, contract.ErrNotFound
	}
	if err != nil {
		return dto.OrderView{}, err
	}
	// 越权也回 ErrNotFound：回「无权支付」等于告诉调用方这个订单号真实存在。
	if row.UserID != req.UserID {
		return dto.OrderView{}, contract.ErrNotFound
	}
	if row.Status == orderCancelled {
		return dto.OrderView{}, errors.New("订单已取消")
	}
	// 流水号带上渠道与订单号：账目上一眼能认出这笔不是真钱，
	// 同一笔订单重试也算出同一个流水号，不会写出两条对不上的支付记录。
	return s.PayOrder(ctx, dto.PayOrderRequest{
		OrderID: req.OrderID, PaymentRef: "sandbox_" + channel + "_" + req.OrderID,
	})
}

// resolveSandboxChannel 把请求里的渠道码收敛到一个**已注册的沙箱渠道**。
//
// 不接受任意字符串：渠道码会原样进流水号，放任下去就是让调用方往账目里写字。
// 请求没带渠道码时取第一个沙箱渠道（渠道表已按码定序），老前端不带这个字段也能用。
func (s *service) resolveSandboxChannel(requested string) (string, error) {
	requested = strings.ToLower(strings.TrimSpace(requested))
	fallback := ""
	for _, channel := range s.PaymentChannels() {
		if !channel.Sandbox {
			continue
		}
		if requested == channel.Code {
			return channel.Code, nil
		}
		if fallback == "" {
			fallback = channel.Code
		}
	}
	if fallback == "" {
		return "", errors.New("未开启沙箱支付渠道")
	}
	if requested != "" {
		return "", fmt.Errorf("支付渠道 %s 不是沙箱渠道", requested)
	}
	return fallback, nil
}

// PayOrderByCallback 支付渠道回调。
//
// 三道关，缺一不可：
//  1. 验签 —— 证明这条通知真是渠道发的。没有 Verifier 就直接拒，
//     一个不验签的回调等于把「发额度」这件事挂在公网上让人随便调。
//  2. 核金额 —— 签名合法只说明消息没被篡改，不说明付的是这个数。
//     渠道侧金额少于订单金额就不履约（多了照收，那是渠道的对账问题，
//     不该卡住用户提货）。
//  3. 履约 —— 复用 PayOrder 的状态机，重复回调不会重复发额度。
func (s *service) PayOrderByCallback(ctx context.Context, callback PaymentCallback) (dto.OrderView, error) {
	if s.payment == nil {
		return dto.OrderView{}, errors.New("未接入支付渠道")
	}
	result, err := s.payment.Verify(ctx, callback)
	if err != nil {
		return dto.OrderView{}, err
	}
	if !result.Paid {
		// 关单、退款这类通知不是支付成功。照实返回订单当前状态，让渠道拿到 2xx
		// 停止重推 —— 回 5xx 只会让它一直重试一条我们本来就不打算处理的通知。
		return s.orderStatus(ctx, result.OrderID)
	}
	row, err := s.repository.FindOrder(ctx, bizLine, result.OrderID)
	if notFound(err) {
		return dto.OrderView{}, contract.ErrNotFound
	}
	if err != nil {
		return dto.OrderView{}, err
	}
	if result.Currency != "" && !strings.EqualFold(result.Currency, row.Currency) {
		return dto.OrderView{}, fmt.Errorf("支付币种与订单不一致")
	}
	if result.AmountPaid < row.Amount {
		return dto.OrderView{}, fmt.Errorf("支付金额与订单不一致")
	}
	return s.PayOrder(ctx, dto.PayOrderRequest{OrderID: result.OrderID, PaymentRef: result.PaymentRef})
}

func (s *service) orderStatus(ctx context.Context, orderID string) (dto.OrderView, error) {
	row, err := s.repository.FindOrder(ctx, bizLine, orderID)
	if notFound(err) {
		return dto.OrderView{}, contract.ErrNotFound
	}
	if err != nil {
		return dto.OrderView{}, err
	}
	return orderView(row, ""), nil
}
