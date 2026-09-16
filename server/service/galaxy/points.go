package galaxy

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 使用者积分与分享返现。
//
// 钱怎么流：运营在管理端给使用者充积分（线下收了钱）→ 使用者在 Orbit 用积分买套餐，
// 买完签发密钥或充进已有密钥 → 如果他是别人邀请来的，按套餐所绑模型的比例给邀请人返积分。
// 1 积分 = ¥1，量纲和 amount / price 一样是「微」，套餐标价直接就是积分价。
//
// 三条不能松的规则：
//   - 余额的每一次变动都和一行流水在同一个事务里，流水的 txn_id 是幂等键 ——
//     充值和购买按前端生成的请求号，返现按订单号，重放不会多记一笔钱。
//   - 扣积分、订单推到已付、签发或充值，三件事在一个事务里：发不出去就一起回滚，
//     不存在「积分扣了、密钥没到」的中间态，也就不需要事后补偿。
//   - 返现跟着「这一单交付了」走，发生在交付之后、事务之外。返现失败不影响买的人，
//     流水幂等，漏的可以照日志补。

const (
	// bpsScale 返现比例的分母：万分之一。10% 存 1000。
	bpsScale = 10_000
	// maxReferralBps 返现比例上限 100%。再高就是邀请人每拉来一笔都倒赚平台的钱。
	maxReferralBps = bpsScale
	// maxRechargePoints 单次充值上限：100 万积分。挡的是手滑多打几个 0。
	maxRechargePoints = 1_000_000 * priceScale

	settingReferralDefaultBps = "referral.default_bps"

	// inviteAlphabet 邀请码字符表：去掉 0/O、1/I/L 这几个口述和手抄时最容易认错的。
	inviteAlphabet   = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
	inviteCodeLength = 8
)

var errInsufficientPoints = errors.New("积分不足，请联系运营充值后再购买")

// ---------- 积分 ----------

func (s *service) PointsSummary(ctx context.Context, ownerUserID string) (dto.PointsSummary, error) {
	var summary dto.PointsSummary
	account, err := s.repository.FindPointsAccount(ctx, bizLine, ownerUserID)
	if err != nil && !notFound(err) {
		return summary, err
	}
	if account != nil {
		summary.Balance = account.Balance
	}
	sums, err := s.repository.SumPointsByType(ctx, bizLine, ownerUserID)
	if err != nil {
		return summary, err
	}
	summary.Recharged = sums[dto.PointsRecharge]
	// 买套餐记的是负数。
	summary.Spent = -sums[dto.PointsPurchase]
	summary.Referral = sums[dto.PointsReferral]
	return summary, nil
}

func (s *service) PointsLedger(ctx context.Context, query dto.PointsLedgerQuery) (dto.PointsLedgerPage, error) {
	offset, limit := pageWindow(query.Offset, query.Limit)
	var types []string
	switch kind := strings.TrimSpace(query.Type); kind {
	case "":
	case dto.PointsRecharge, dto.PointsPurchase, dto.PointsReferral:
		types = []string{kind}
	default:
		return dto.PointsLedgerPage{}, fmt.Errorf("未知的流水类型：%s", kind)
	}
	// 运营翻全站时才认关键字；使用端的范围只由令牌里的人决定，没有人就一行都不给。
	operator := query.Operator
	if !operator && query.OwnerUserID == "" {
		return dto.PointsLedgerPage{}, contract.ErrNotFound
	}
	filter := repository.PointsLedgerQuery{
		BizLine: bizLine, OwnerUserID: query.OwnerUserID, Types: types, Offset: offset, Limit: limit,
	}
	if operator {
		filter.OwnerKeyword = query.OwnerKeyword
	}
	rows, total, err := s.repository.ListPointsLedger(ctx, filter)
	if err != nil {
		return dto.PointsLedgerPage{}, err
	}

	ids := make([]string, 0, len(rows)*2)
	for _, row := range rows {
		ids = append(ids, row.OwnerUserID, row.RelatedUserID)
	}
	// 运营看「昵称（用户名）」；使用端只拿得到被邀请人打过码的用户名。
	names := map[string]string{}
	if operator {
		if names, err = s.userNames(ctx, dto.SideConsumer, ids); err != nil {
			return dto.PointsLedgerPage{}, err
		}
	} else {
		users, err := s.repository.ListUsersByIDs(ctx, bizLine, dto.SideConsumer, uniqueStrings(ids))
		if err != nil {
			return dto.PointsLedgerPage{}, err
		}
		for _, user := range users {
			names[user.UserID] = maskName(user.Username)
		}
	}

	page := dto.PointsLedgerPage{Total: total, Entries: make([]dto.PointsLedgerEntry, 0, len(rows))}
	for _, row := range rows {
		entry := pointsEntry(row)
		entry.RelatedName = names[row.RelatedUserID]
		if operator {
			entry.OwnerName = names[row.OwnerUserID]
		} else {
			// 运营写的备注和经手人是后台的内部记录，使用端不给。
			entry.Remark, entry.Operator = "", ""
		}
		page.Entries = append(page.Entries, entry)
	}
	return page, nil
}

func pointsEntry(row *repository.GalaxyPointsLedger) dto.PointsLedgerEntry {
	return dto.PointsLedgerEntry{
		TxnID: row.TxnID, OwnerUserID: row.OwnerUserID, Type: row.Type,
		Amount: row.Amount, BalanceAfter: row.BalanceAfter, BaseAmount: row.BaseAmount, RateBps: row.RateBps,
		OrderID: row.OrderID, ModelID: row.ModelID, Remark: row.Remark, Operator: row.Operator,
		CreatedAt: row.CreatedAt,
	}
}

// RechargePoints 运营给使用者充积分。
//
// 请求号由前端在打开充值框时生成：网络超时后重试、按钮连点两下，落到库里都是同一个
// txn_id，只会充一次，第二次原样返回第一次的结果 —— 报「重复」的话，运营会以为没充上又去充一遍。
func (s *service) RechargePoints(ctx context.Context, req dto.RechargePointsRequest) (dto.PointsLedgerEntry, error) {
	userID := strings.TrimSpace(req.UserID)
	switch {
	case req.Points <= 0:
		return dto.PointsLedgerEntry{}, fmt.Errorf("充值积分要大于 0")
	case req.Points > maxRechargePoints:
		return dto.PointsLedgerEntry{}, fmt.Errorf("单次最多充 %d 积分", maxRechargePoints/priceScale)
	case req.PaidAmount < 0:
		return dto.PointsLedgerEntry{}, fmt.Errorf("实付金额不能是负数")
	}
	// 只在使用端那张表里找：积分是使用端的东西，一个共享端的账号 id 传进来查不到，
	// 报的就是「账号不存在」，不必再单独挡一次「只能给使用端充」。
	if _, err := s.repository.FindUser(ctx, bizLine, dto.SideConsumer, userID); notFound(err) {
		return dto.PointsLedgerEntry{}, fmt.Errorf("使用端账号不存在：%s", userID)
	} else if err != nil {
		return dto.PointsLedgerEntry{}, err
	}

	requestID := clip(req.RequestID, 64)
	if requestID == "" {
		requestID = NewULID(time.Now())
	}
	row := &repository.GalaxyPointsLedger{
		BizLine: bizLine, TxnID: "recharge:" + requestID, OwnerUserID: userID, Type: dto.PointsRecharge,
		Amount: req.Points, BaseAmount: req.PaidAmount,
		Remark: clip(req.Remark, 256), Operator: clip(req.Operator, 64),
	}
	applied, err := s.applyPoints(ctx, row, nil)
	if err != nil {
		return dto.PointsLedgerEntry{}, err
	}
	if !applied {
		existing, err := s.repository.FindPointsLedger(ctx, bizLine, row.TxnID)
		if err != nil {
			return dto.PointsLedgerEntry{}, err
		}
		// 同一个请求号换了人或金额再来一次，说明前端把请求号用串了，不能把这当成重试糊弄过去。
		if existing.OwnerUserID != userID || existing.Type != dto.PointsRecharge || existing.Amount != req.Points {
			return dto.PointsLedgerEntry{}, fmt.Errorf("充值请求号已被另一笔充值用过，请关掉充值框重新打开")
		}
		row = existing
	}
	entry := pointsEntry(row)
	names, err := s.userNames(ctx, dto.SideConsumer, []string{userID})
	if err != nil {
		return dto.PointsLedgerEntry{}, err
	}
	entry.OwnerName = names[userID]
	return entry, nil
}

// applyPoints 在一个事务里改余额、记流水，再把 within 也放进同一个事务。
//
// Amount 为正是入账；为负是出账，余额不够返回 errInsufficientPoints。
// 第一个返回值为假表示这个 txn_id 已经记过：余额没动、within 没跑，事务整个回滚。
func (s *service) applyPoints(ctx context.Context, row *repository.GalaxyPointsLedger, within func(tx *repository.GalaxyRepository) error) (bool, error) {
	errReplayed := errors.New("points ledger replayed")
	err := s.repository.Tx(ctx, func(tx *repository.GalaxyRepository) error {
		if row.Amount >= 0 {
			after, err := tx.CreditPoints(ctx, bizLine, row.OwnerUserID, row.Amount)
			if err != nil {
				return err
			}
			row.BalanceAfter = after
		} else {
			ok, after, err := tx.DebitPoints(ctx, bizLine, row.OwnerUserID, -row.Amount)
			if err != nil {
				return err
			}
			if !ok {
				return errInsufficientPoints
			}
			row.BalanceAfter = after
		}
		inserted, err := tx.InsertPointsLedger(ctx, row)
		if err != nil {
			return err
		}
		if !inserted {
			return errReplayed
		}
		if within != nil {
			return within(tx)
		}
		return nil
	})
	if errors.Is(err, errReplayed) {
		return false, nil
	}
	return err == nil, err
}

// PurchaseWithPoints 用积分买一个套餐。
//
// 下单的校验（商品上架、目标密钥是本人的且没吊销、签发新密钥前确认过数据告知）
// 全部复用渠道下单那一套。之后扣积分、推到已付、签发或充值在同一个事务里 ——
// 签发写到一半失败，积分和订单状态跟着一起回滚，不会有人花了积分没拿到东西，
// 也不会有人拿到东西又被「退款」补偿一次。
func (s *service) PurchaseWithPoints(ctx context.Context, req dto.PurchaseRequest) (dto.OrderView, error) {
	requestID := clip(req.RequestID, 64)
	// 超时重试最常见：第一次其实已经成了。先按请求号查一次，查到就直接还回那一单，
	// 不然重试会先建一张多余的单子，余额刚好够一单时还会被报成「积分不足」。
	if requestID != "" {
		existing, err := s.repository.FindPointsLedger(ctx, bizLine, "purchase:"+requestID)
		if err == nil {
			return s.purchasedOrder(ctx, req.UserID, existing)
		}
		if !notFound(err) {
			return dto.OrderView{}, err
		}
	}

	order, err := s.createOrder(ctx, dto.CreateOrderRequest{
		UserID: req.UserID, PackageCode: req.PackageCode,
		TargetKeyID: req.TargetKeyID, NoticeVersion: req.NoticeVersion,
	}, payByPoints)
	if err != nil {
		return dto.OrderView{}, err
	}

	// 扣积分那一行流水的 txn_id 就是这一单的幂等键。前端带了请求号就按请求号：
	// 点两下、超时重试会各建一张待支付的单，但只有第一张能写进这一行，后面的在事务里撞键回滚。
	payTxn := "order:" + order.OrderID + ":pay"
	if requestID != "" {
		payTxn = "purchase:" + requestID
	}

	var view dto.OrderView
	deliver := func(tx *repository.GalaxyRepository) error {
		moved, err := tx.MarkOrderPaid(ctx, bizLine, order.OrderID, payByPoints+":"+order.OrderID, time.Now())
		if err != nil {
			return err
		}
		if !moved {
			return fmt.Errorf("订单已不是待支付状态")
		}
		view, err = s.scopedTo(tx).fulfilOrder(ctx, order.OrderID)
		return err
	}
	if order.Amount > 0 {
		var applied bool
		applied, err = s.applyPoints(ctx, &repository.GalaxyPointsLedger{
			BizLine: bizLine, TxnID: payTxn, OwnerUserID: req.UserID,
			Type: dto.PointsPurchase, Amount: -order.Amount, BaseAmount: order.Amount,
			OrderID: order.OrderID, ModelID: order.ModelID,
		}, deliver)
		if err == nil && !applied {
			return s.replayedPurchase(ctx, req.UserID, order.OrderID, payTxn)
		}
	} else {
		err = s.repository.Tx(ctx, deliver)
	}
	if err != nil {
		// 事务已经把积分和订单状态回滚了。剩下这张待支付的单子付不了也不该留着，关掉。
		if cancelErr := s.repository.CancelOrder(ctx, bizLine, req.UserID, order.OrderID); cancelErr != nil && !notFound(cancelErr) {
			log.Printf("galaxy 积分购买失败后关单也失败 order=%s: %v", order.OrderID, cancelErr)
		}
		return dto.OrderView{}, err
	}
	s.rewardReferrer(ctx, order.OrderID)
	return view, nil
}

// replayedPurchase 并发的两次提交撞了同一个请求号，后到的那次在事务里撞键回滚了：
// 它多建出来的那张待支付单关掉，把先到的那一单原样还回去。不报错 —— 对点了两下的人来说，他只买了一次。
func (s *service) replayedPurchase(ctx context.Context, userID, duplicateOrderID, payTxn string) (dto.OrderView, error) {
	if err := s.repository.CancelOrder(ctx, bizLine, userID, duplicateOrderID); err != nil && !notFound(err) {
		log.Printf("galaxy 重复的积分购买关单失败 order=%s: %v", duplicateOrderID, err)
	}
	existing, err := s.repository.FindPointsLedger(ctx, bizLine, payTxn)
	if err != nil {
		return dto.OrderView{}, err
	}
	return s.purchasedOrder(ctx, userID, existing)
}

// purchasedOrder 按扣积分那行流水找回当初那一单。明文不跟着回 —— 要的话去密钥页取。
func (s *service) purchasedOrder(ctx context.Context, userID string, paid *repository.GalaxyPointsLedger) (dto.OrderView, error) {
	// 请求号是别人用过的：不能把别人的订单还给他。
	if paid.OwnerUserID != userID || paid.Type != dto.PointsPurchase {
		return dto.OrderView{}, fmt.Errorf("购买请求号冲突，请刷新页面后重试")
	}
	original, err := s.repository.FindOrder(ctx, bizLine, paid.OrderID)
	if err != nil {
		return dto.OrderView{}, err
	}
	return orderView(original, ""), nil
}

// scopedTo 一个把全部读写都落在给定事务里的 service 副本，只给账务流程用。
// 放置、等待队列这些进程内状态它没有，也不该在事务里碰。
func (s *service) scopedTo(tx *repository.GalaxyRepository) *service {
	// settings 传的是**同一个指针**：副本要是自己去回查，那次查询会落在
	// 正开着的事务里 —— 一个账务事务因为读了一遍运营开关而变长，没有任何道理。
	return &service{
		repository: tx, config: s.config, settings: s.settings,
		cipher: s.cipher, kinds: s.kinds, metrics: s.metrics,
	}
}

// ---------- 分享返现 ----------

// rewardReferrer 给下单人的邀请人返现。失败只记日志 —— 买的人已经拿到东西了，
// 返现流水按订单号幂等，漏掉的照日志里的订单号再调一次就补上。
func (s *service) rewardReferrer(ctx context.Context, orderID string) {
	if err := s.awardReferral(ctx, orderID); err != nil {
		log.Printf("galaxy 分享返现失败 order=%s: %v", orderID, err)
	}
}

// awardReferral 按「实付 × 套餐所绑模型的比例」给邀请人返积分。
//
// 实付就是订单金额：积分付的是积分，渠道付的是钱，1 积分 = ¥1，两者同一量纲。
// 比例在返现这一刻取，并记进流水 —— 运营之后改比例，已经返过的不跟着变，账上看得出当时按多少算的。
func (s *service) awardReferral(ctx context.Context, orderID string) error {
	order, err := s.repository.FindOrder(ctx, bizLine, orderID)
	if err != nil {
		return err
	}
	if order.Status != orderFulfilled || order.Amount <= 0 {
		return nil
	}
	referral, err := s.repository.FindReferralByUser(ctx, bizLine, order.UserID)
	if notFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if referral.InvitedBy == "" || referral.InvitedBy == order.UserID {
		return nil
	}
	rates, err := s.referralRates(ctx)
	if err != nil {
		return err
	}
	bps := rates.of(order.ModelID)
	cashback := order.Amount * bps / bpsScale
	if cashback <= 0 {
		return nil
	}
	_, err = s.applyPoints(ctx, &repository.GalaxyPointsLedger{
		BizLine: bizLine, TxnID: "order:" + order.OrderID + ":referral", OwnerUserID: referral.InvitedBy,
		Type: dto.PointsReferral, Amount: cashback, BaseAmount: order.Amount, RateBps: bps,
		OrderID: order.OrderID, RelatedUserID: order.UserID, ModelID: order.ModelID,
	}, nil)
	return err
}

// referralRateTable 此刻生效的返现比例：模型单独设了的用模型的，其余（含通用套餐）用默认。
type referralRateTable struct {
	defaultBps int64
	models     map[string]int64
}

func (t referralRateTable) of(modelID string) int64 {
	if bps, ok := t.models[modelID]; ok && modelID != "" {
		return bps
	}
	return t.defaultBps
}

// inherits 这个模型是不是没单独设、跟着默认走。
func (t referralRateTable) inherits(modelID string) bool {
	_, ok := t.models[modelID]
	return !ok
}

func (s *service) referralRates(ctx context.Context) (referralRateTable, error) {
	settings, err := s.ReferralSettings(ctx)
	if err != nil {
		return referralRateTable{}, err
	}
	// 下架的模型也要在表里：套餐可能还挂着它在卖，返现照它设的比例算。
	rows, err := s.repository.ListModels(ctx, bizLine, false)
	if err != nil {
		return referralRateTable{}, err
	}
	table := referralRateTable{defaultBps: settings.DefaultBps, models: map[string]int64{}}
	for _, row := range rows {
		if row.ReferralBps != nil {
			table.models[row.ModelID] = clampBps(*row.ReferralBps)
		}
	}
	return table, nil
}

func (s *service) ReferralSettings(ctx context.Context) (dto.ReferralSettings, error) {
	row, err := s.repository.FindSetting(ctx, bizLine, settingReferralDefaultBps)
	if notFound(err) {
		// 没设过就是 0：钱相关的默认值只能是「不给」，比例由运营显式打开。
		return dto.ReferralSettings{}, nil
	}
	if err != nil {
		return dto.ReferralSettings{}, err
	}
	bps, _ := strconv.ParseInt(strings.TrimSpace(row.Value), 10, 64)
	updatedAt := row.UpdatedTime
	return dto.ReferralSettings{DefaultBps: clampBps(bps), UpdatedBy: row.UpdatedBy, UpdatedAt: &updatedAt}, nil
}

// SaveReferralSettings 改使用端的默认返现比例。
//
// 这一项同时也在「运行参数」那张表里（referral.default_bps）——
// 同一行、同一个键，两个入口写的是同一个地方。这里保存完要让本进程的参数快照
// 立刻失效，否则运营在这一页改完，下一页还显示旧值。
func (s *service) SaveReferralSettings(ctx context.Context, req dto.SaveReferralSettingsRequest) error {
	if req.DefaultBps < 0 || req.DefaultBps > maxReferralBps {
		return fmt.Errorf("返现比例要在 0%% 到 100%% 之间")
	}
	defer s.invalidateSettings()
	return s.repository.SaveSetting(ctx, &repository.GalaxySetting{
		BizLine: bizLine, SettingKey: settingReferralDefaultBps,
		Value: strconv.FormatInt(req.DefaultBps, 10), UpdatedBy: clip(req.UpdatedBy, 64),
	})
}

func clampBps(value int64) int64 {
	if value < 0 {
		return 0
	}
	if value > maxReferralBps {
		return maxReferralBps
	}
	return value
}

// ReferralOverview 分享页。老账号没有邀请码，第一次打开时补一个。
func (s *service) ReferralOverview(ctx context.Context, ownerUserID string) (dto.ReferralOverview, error) {
	referral, err := s.ensureReferral(ctx, ownerUserID)
	if err != nil {
		return dto.ReferralOverview{}, err
	}
	invitees, err := s.repository.CountInvitees(ctx, bizLine, ownerUserID)
	if err != nil {
		return dto.ReferralOverview{}, err
	}
	sums, err := s.repository.SumPointsByType(ctx, bizLine, ownerUserID)
	if err != nil {
		return dto.ReferralOverview{}, err
	}
	rates, err := s.referralRates(ctx)
	if err != nil {
		return dto.ReferralOverview{}, err
	}
	models, err := s.repository.ListModels(ctx, bizLine, true)
	if err != nil {
		return dto.ReferralOverview{}, err
	}
	view := dto.ReferralOverview{
		InviteCode: referral.InviteCode, Invitees: invitees, Earned: sums[dto.PointsReferral],
		DefaultBps: rates.defaultBps, Rates: []dto.ReferralRateView{},
	}
	for _, row := range models {
		bps := rates.of(row.ModelID)
		if bps <= 0 {
			// 不返现的模型不列：分享页要回答的是「分享哪个模型能拿到返现」。
			continue
		}
		model := portalModelView(row)
		view.Rates = append(view.Rates, dto.ReferralRateView{
			ModelID: row.ModelID, DisplayName: model.DisplayName, Family: model.Family,
			Bps: bps, Inherited: rates.inherits(row.ModelID),
		})
	}
	return view, nil
}

func (s *service) ListInvitees(ctx context.Context, ownerUserID string, offset, limit int) (dto.InviteePage, error) {
	offset, limit = pageWindow(offset, limit)
	rows, total, err := s.repository.ListInvitees(ctx, bizLine, ownerUserID, offset, limit)
	if err != nil {
		return dto.InviteePage{}, err
	}
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.UserID)
	}
	users, err := s.repository.ListUsersByIDs(ctx, bizLine, dto.SideConsumer, ids)
	if err != nil {
		return dto.InviteePage{}, err
	}
	usernames := make(map[string]string, len(users))
	for _, user := range users {
		usernames[user.UserID] = user.Username
	}
	earned, err := s.repository.SumReferralByInvitee(ctx, bizLine, ownerUserID, ids)
	if err != nil {
		return dto.InviteePage{}, err
	}
	page := dto.InviteePage{Total: total, Invitees: make([]dto.InviteeView, 0, len(rows))}
	for _, row := range rows {
		page.Invitees = append(page.Invitees, dto.InviteeView{
			Name: maskName(usernames[row.UserID]), JoinedAt: row.CreatedTime, Earned: earned[row.UserID],
		})
	}
	return page, nil
}

// ensureReferral 取这个人的邀请关系。没有就补一行 —— 只分配邀请码，邀请人留空：
// 老账号是自己注册的，事后补填邀请人等于让人随便认一个上家。
func (s *service) ensureReferral(ctx context.Context, userID string) (*repository.GalaxyReferral, error) {
	row, err := s.repository.FindReferralByUser(ctx, bizLine, userID)
	if err == nil {
		return row, nil
	}
	if !notFound(err) {
		return nil, err
	}
	// 只认使用端那张表：邀请码是使用端的东西，共享端的账号在这里查不到，
	// 返回的就是「不存在」，而不是给他也发一个永远没人能用的码。
	if _, err := s.repository.FindUser(ctx, bizLine, dto.SideConsumer, userID); notFound(err) {
		return nil, contract.ErrNotFound
	} else if err != nil {
		return nil, err
	}
	return CreateReferral(ctx, s.repository, userID, "")
}

// CreateReferral 给一个使用端账号建邀请关系并分配邀请码。注册（account 包）和
// 老账号第一次打开分享页都走这里，邀请码的生成规则只在这一处。
//
// 码撞了唯一键就换一个再试；是这个人已经有一行了（并发的两次打开），就用已有的那行。
func CreateReferral(ctx context.Context, repo *repository.GalaxyRepository, userID, invitedBy string) (*repository.GalaxyReferral, error) {
	for attempt := 0; attempt < 5; attempt++ {
		row := &repository.GalaxyReferral{BizLine: bizLine, UserID: userID, InviteCode: NewInviteCode(), InvitedBy: invitedBy}
		inserted, err := repo.CreateReferral(ctx, row)
		if err != nil {
			return nil, err
		}
		if inserted {
			return row, nil
		}
		existing, err := repo.FindReferralByUser(ctx, bizLine, userID)
		if err == nil {
			return existing, nil
		}
		if !notFound(err) {
			return nil, err
		}
	}
	return nil, errors.New("邀请码分配失败，请稍后再试")
}

// NewInviteCode 8 位邀请码。31 个字符的表，31^8 ≈ 8.5×10¹¹，撞码靠唯一索引兜底。
// 拒绝采样去掉取模偏差：256 不是 31 的倍数，直接取模会让表头几个字符出现得更频繁。
func NewInviteCode() string {
	code := make([]byte, 0, inviteCodeLength)
	buffer := make([]byte, inviteCodeLength*2)
	limit := byte(256 - 256%len(inviteAlphabet))
	for len(code) < inviteCodeLength {
		if _, err := rand.Read(buffer); err != nil {
			// 熵源坏了：退回时间戳混出来的码，唯一索引仍然兜得住撞码。
			return strings.ToUpper(NewULID(time.Now())[18:26])
		}
		for _, value := range buffer {
			if value >= limit {
				continue
			}
			code = append(code, inviteAlphabet[int(value)%len(inviteAlphabet)])
			if len(code) == inviteCodeLength {
				break
			}
		}
	}
	return string(code)
}

// NormalizeInviteCode 用户手抄、口述、链接里带过来的码都收成库里的形状：大写、去空白和连字符。
func NormalizeInviteCode(raw string) string {
	return strings.ToUpper(strings.NewReplacer(" ", "", "-", "", "\t", "").Replace(strings.TrimSpace(raw)))
}

// maskName 打码用户名：留首尾各一个字，中间最多四个星号。zhangsan → z****n。
func maskName(name string) string {
	runes := []rune(strings.TrimSpace(name))
	switch len(runes) {
	case 0:
		return ""
	case 1:
		return "*"
	case 2:
		return string(runes[0]) + "*"
	}
	stars := len(runes) - 2
	if stars > 4 {
		stars = 4
	}
	return string(runes[0]) + strings.Repeat("*", stars) + string(runes[len(runes)-1])
}

func pageWindow(offset, limit int) (int, int) {
	if limit <= 0 || limit > 200 {
		limit = 20
	}
	if offset < 0 {
		offset = 0
	}
	return offset, limit
}
