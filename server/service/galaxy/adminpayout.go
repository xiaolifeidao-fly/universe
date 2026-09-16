package galaxy

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"gorm.io/gorm"

	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 提现审批。申请那一端在 earnings.go（CreatePayout：先扣积分再建单），
// 这一端把单子从 pending 推到 paid / rejected。
//
// **这条路必须在管理端有**：积分在申请那一刻就从账户里扣走了，单子停在 pending
// 就等于那笔钱既不在用户手上、也没打出去。没有审批入口的结果不是「暂时没人处理」，
// 是「谁也处理不了」—— 只能有人去库里手工 UPDATE，而手工 UPDATE 不会退积分。

const (
	payoutPaid     = "paid"
	payoutRejected = "rejected"
)

// AdminPayouts 提现队列。默认按时间倒序，带各状态的计数。
func (s *service) AdminPayouts(ctx context.Context, query dto.AdminPayoutQuery) (dto.AdminPayoutPage, error) {
	limit := pageLimit(query.Limit, 20, 200)
	rows, total, err := s.repository.ListAdminPayouts(ctx, repository.AdminPayoutQuery{
		BizLine: bizLine, Status: strings.TrimSpace(query.Status),
		OwnerUserID: strings.TrimSpace(query.OwnerUserID), Keyword: strings.TrimSpace(query.Keyword),
		Offset: query.Offset, Limit: limit,
	})
	if err != nil {
		return dto.AdminPayoutPage{}, err
	}
	counts, err := s.repository.CountPayoutsByStatus(ctx, bizLine)
	if err != nil {
		return dto.AdminPayoutPage{}, err
	}
	owners := make([]string, 0, len(rows))
	for _, row := range rows {
		owners = append(owners, row.OwnerUserID)
	}
	// 提现是共享端的事，主人只可能在 provider 那张账号表里。
	names, err := s.userNames(ctx, dto.SideProvider, owners)
	if err != nil {
		return dto.AdminPayoutPage{}, err
	}
	page := dto.AdminPayoutPage{
		Total: total, Counts: counts,
		MinCredits: s.cfg().PayoutMinCredits, HoldDays: s.cfg().PayoutHoldDays,
		Payouts: make([]dto.AdminPayoutView, 0, len(rows)),
	}
	for _, row := range rows {
		page.Payouts = append(page.Payouts, dto.AdminPayoutView{
			PayoutView:  payoutView(row),
			OwnerUserID: row.OwnerUserID,
			OwnerName:   names[row.OwnerUserID],
			HandledBy:   row.HandledBy,
		})
	}
	return page, nil
}

// HandlePayout 处置一张提现单。
//
// 驳回要把积分退回账户，所以**先条件改状态、改成了才退钱**：反过来先退钱再改状态，
// 两个运营同时点驳回就会退两次。状态更新带 status = 'pending' 的条件，
// 第二个人改到 0 行，在这里就停住了。
func (s *service) HandlePayout(ctx context.Context, req dto.HandlePayoutRequest) (dto.AdminPayoutView, error) {
	status := strings.TrimSpace(strings.ToLower(req.Status))
	if status != payoutPaid && status != payoutRejected {
		return dto.AdminPayoutView{}, fmt.Errorf("不支持的处置结果: %s", req.Status)
	}
	note := strings.TrimSpace(req.Note)
	if status == payoutRejected && note == "" {
		// 一个没有理由的驳回，申请人只会原样再提一次。
		return dto.AdminPayoutView{}, errors.New("驳回要写明原因，申请人看得到这句话")
	}
	payoutID := strings.TrimSpace(req.PayoutID)
	row, err := s.repository.FindPayout(ctx, bizLine, payoutID)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return dto.AdminPayoutView{}, fmt.Errorf("提现单不存在: %s", payoutID)
		}
		return dto.AdminPayoutView{}, err
	}
	if row.Status != payoutPending {
		return dto.AdminPayoutView{}, fmt.Errorf("这张单子已经是 %s，不能再处置", row.Status)
	}

	now := time.Now()
	changed, err := s.repository.HandlePayout(ctx, bizLine, payoutID, status, note, req.HandledBy, now)
	if err != nil {
		return dto.AdminPayoutView{}, err
	}
	if !changed {
		return dto.AdminPayoutView{}, errors.New("这张单子刚刚已被处置，请刷新后再看")
	}

	if status == payoutRejected {
		// 申请时扣掉的积分原路退回，账本上记一笔反向流水 ——
		// 余额凭空多出来一笔而账本里没有对应的行，对账时没人能解释它。
		if err := s.repository.AddCredit(ctx, bizLine, row.OwnerUserID, row.Credits); err != nil {
			return dto.AdminPayoutView{}, err
		}
		_ = s.repository.SaveProviderLedger(ctx, []*repository.GalaxyProviderLedger{{
			BizLine: bizLine, TxnID: row.PayoutID + ":payout_refund", OwnerUserID: row.OwnerUserID,
			Type: ledgerPayout, Unit: unitCredit, Amount: row.Credits,
		}})
	}

	row.Status, row.Note, row.HandledBy, row.HandledAt = status, note, req.HandledBy, &now
	names, err := s.userNames(ctx, dto.SideProvider, []string{row.OwnerUserID})
	if err != nil {
		return dto.AdminPayoutView{}, err
	}
	return dto.AdminPayoutView{
		PayoutView: payoutView(row), OwnerUserID: row.OwnerUserID,
		OwnerName: names[row.OwnerUserID], HandledBy: row.HandledBy,
	}, nil
}

// RevealPayoutAccount 取收款账号明文。要打款的那一刻才调，走 POST ——
// 只读角色只授 GET，收款账号天然就不在它的授权范围里。
func (s *service) RevealPayoutAccount(ctx context.Context, payoutID string) (dto.PayoutAccountView, error) {
	row, err := s.repository.FindPayout(ctx, bizLine, strings.TrimSpace(payoutID))
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return dto.PayoutAccountView{}, fmt.Errorf("提现单不存在: %s", payoutID)
		}
		return dto.PayoutAccountView{}, err
	}
	return dto.PayoutAccountView{PayoutID: row.PayoutID, Method: row.Method, Account: row.Account}, nil
}
