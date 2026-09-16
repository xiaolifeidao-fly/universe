package galaxy

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/url"
	"strings"
	"time"

	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 共享端的邀请返现。
//
// 规则一句话说完：被邀请人贡献算力结算出多少积分，平台**额外**奖励邀请人其中的 X%，
// 被邀请人自己的收益一分不少。只返一层 —— 奖励本身不再产生奖励，所以不存在链式分佣。
//
// 三条边界，都是钱上的事，写在这里免得后来人觉得可以省：
//
//  1. **奖励跟着被邀请人的收益走，也跟着它退。** 那笔收益被申诉追回时，对应的奖励
//     按原额反向记一笔（ref_clawback）。不退的话，一次伪造的执行能同时套出两笔钱。
//  2. **同一台设备上跑出来的收益不返。** 奖励是平台出的，把自己的机器挂到一个
//     被自己邀请的小号名下就能白拿 X%。指纹是节点自报的，挡不住改过的客户端，
//     但挡得住「同一台机器换个账号再配一次」这种顺手就能做的事。
//  3. **入账跟着账本行走。** 先插账本（幂等键 = 那次执行），插进去了才加余额；
//     重放时插不进去，也就不会多给一次。
const (
	ledgerReferral         = "referral"
	ledgerReferralClawback = "ref_clawback"
)

// referralTypes 汇总邀请奖励时要算的两种流水。追回记的是负数，所以求和就是净额。
var referralTypes = []string{ledgerReferral, ledgerReferralClawback}

// CreateProviderReferral 给一个共享端账号建邀请关系并分配邀请码。
//
// 注册（account 包，和建账号在同一个事务里）与老账号第一次打开邀请页都走这里，
// 邀请码的生成规则只有这一处。码撞了唯一键就换一个再试；是这个人已经有一行了
// （并发的两次打开），就用已有的那一行。
func CreateProviderReferral(ctx context.Context, repo *repository.GalaxyRepository, userID, invitedBy string) (*repository.GalaxyProviderReferral, error) {
	for attempt := 0; attempt < 5; attempt++ {
		row := &repository.GalaxyProviderReferral{
			BizLine: bizLine, UserID: userID, InviteCode: NewInviteCode(), InvitedBy: invitedBy,
		}
		inserted, err := repo.CreateProviderReferral(ctx, row)
		if err != nil {
			return nil, err
		}
		if inserted {
			return row, nil
		}
		existing, err := repo.FindProviderReferralByUser(ctx, bizLine, userID)
		if err == nil {
			return existing, nil
		}
		if !notFound(err) {
			return nil, err
		}
	}
	return nil, errors.New("邀请码分配失败，请稍后再试")
}

// ensureProviderReferral 取这个人的邀请关系，没有就现建一行（老账号第一次打开邀请页）。
func (s *service) ensureProviderReferral(ctx context.Context, userID string) (*repository.GalaxyProviderReferral, error) {
	row, err := s.repository.FindProviderReferralByUser(ctx, bizLine, userID)
	if err == nil {
		return row, nil
	}
	if !notFound(err) {
		return nil, err
	}
	return CreateProviderReferral(ctx, s.repository, userID, "")
}

// ProviderReferral 邀请页顶上那一块。
func (s *service) ProviderReferral(ctx context.Context, ownerUserID string) (dto.ProviderReferralOverview, error) {
	row, err := s.ensureProviderReferral(ctx, ownerUserID)
	if err != nil {
		return dto.ProviderReferralOverview{}, err
	}
	invitees, err := s.repository.CountProviderInvitees(ctx, bizLine, ownerUserID)
	if err != nil {
		return dto.ProviderReferralOverview{}, err
	}
	now := time.Now()
	scope := repository.LedgerQuery{BizLine: bizLine, OwnerUserID: ownerUserID, Types: referralTypes}
	total, err := s.repository.SumProviderLedger(ctx, scope)
	if err != nil {
		return dto.ProviderReferralOverview{}, err
	}
	week := scope
	week.From = startOfDay(now).AddDate(0, 0, -6)
	recent, err := s.repository.SumProviderLedger(ctx, week)
	if err != nil {
		return dto.ProviderReferralOverview{}, err
	}
	hold := scope
	hold.From = now.AddDate(0, 0, -s.cfg().PayoutHoldDays)
	pending, err := s.repository.SumProviderLedger(ctx, hold)
	if err != nil {
		return dto.ProviderReferralOverview{}, err
	}
	if pending < 0 {
		pending = 0
	}
	return dto.ProviderReferralOverview{
		Code: row.InviteCode, Link: s.providerInviteLink(row.InviteCode),
		Rate: s.cfg().ReferralRate, Days: s.cfg().ReferralDays,
		Enabled:  s.cfg().ReferralRate > 0,
		Invitees: invitees, RewardTotal: total, RewardWeek: recent, RewardPending: pending,
	}, nil
}

// ListProviderInvitees 邀请来的人，以及各自带来了多少奖励。
func (s *service) ListProviderInvitees(ctx context.Context, ownerUserID string, offset, limit int) (dto.ProviderInviteePage, error) {
	offset, limit = pageWindow(offset, limit)
	rows, total, err := s.repository.ListProviderInvitees(ctx, bizLine, ownerUserID, offset, limit)
	if err != nil {
		return dto.ProviderInviteePage{}, err
	}
	page := dto.ProviderInviteePage{Total: total, Items: make([]dto.ProviderInviteeView, 0, len(rows))}
	if len(rows) == 0 {
		return page, nil
	}
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.UserID)
	}
	users, err := s.repository.ListUsersByIDs(ctx, bizLine, dto.SideProvider, ids)
	if err != nil {
		return dto.ProviderInviteePage{}, err
	}
	names := map[string]string{}
	for _, user := range users {
		names[user.UserID] = user.Username
	}
	rewards, err := s.repository.SumProviderReferralByInvitee(ctx, bizLine, ownerUserID, ids)
	if err != nil {
		return dto.ProviderInviteePage{}, err
	}
	for _, row := range rows {
		item := dto.ProviderInviteeView{
			// 打码：邀请人不该看到好友的完整账号，那是另一个人的登录名。
			Name:     maskName(defaultString(names[row.UserID], row.UserID)),
			JoinedAt: row.CreatedTime,
		}
		if reward, ok := rewards[row.UserID]; ok {
			item.RewardTotal = reward.Amount
			if !reward.LastAt.IsZero() {
				last := reward.LastAt
				item.LastRewardAt = &last
			}
		}
		if s.cfg().ReferralDays > 0 {
			expires := row.CreatedTime.AddDate(0, 0, s.cfg().ReferralDays)
			item.ExpiresAt = &expires
		}
		page.Items = append(page.Items, item)
	}
	return page, nil
}

// providerInviteLink 拼出分享出去的注册地址。平台没配注册页地址时返回空串 ——
// 页面据此只显示邀请码，而不是给出一个打不开的链接。
func (s *service) providerInviteLink(code string) string {
	base := strings.TrimSpace(s.cfg().ReferralRegisterURL)
	if base == "" || code == "" {
		return ""
	}
	parsed, err := url.Parse(base)
	if err != nil {
		return ""
	}
	// 用 Query 拼而不是字符串拼接：配置里那个地址可能已经带了参数。
	query := parsed.Query()
	query.Set("invite", code)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

// rewardProviderReferrer 结算完一次执行之后，给邀请人记一笔奖励。
//
// 失败一律不影响结算本身：结算已经落账了，奖励算不出来是另一回事 ——
// 让一次奖励失败把提供者的收益一起回滚，是这里最不该做的事。
func (s *service) rewardProviderReferrer(ctx context.Context, runtime UnitRuntime, contribution *repository.GalaxyContribution, credit int64) {
	bps := referralBps(s.cfg().ReferralRate)
	if bps <= 0 || credit <= 0 || contribution == nil || contribution.OwnerUserID == "" {
		return
	}
	referral, err := s.repository.FindProviderReferralByUser(ctx, bizLine, contribution.OwnerUserID)
	if err != nil || referral.InvitedBy == "" {
		return
	}
	if s.cfg().ReferralDays > 0 {
		if time.Since(referral.CreatedTime) > time.Duration(s.cfg().ReferralDays)*24*time.Hour {
			return
		}
	}
	// 同一台设备不返（见文件头第 2 条）。查不到机器或者机器没报过指纹时照常返：
	// 老节点不报指纹，不能因为这个把正常的邀请奖励全部停掉。
	if node, err := s.repository.FindNode(ctx, bizLine, contribution.NodeID); err == nil && node.MachineFingerprint != "" {
		shared, err := s.repository.OwnerHasMachine(ctx, bizLine, referral.InvitedBy, node.MachineFingerprint)
		if err == nil && shared {
			s.metrics.Count(MetricReferralSelfInvite, map[string]string{"inviter": referral.InvitedBy}, 1)
			return
		}
	}
	bonus := credit * bps / 10000
	if bonus <= 0 {
		return
	}
	// 幂等键钉在「这一次执行」上，和结算那笔用的是同一组 (rid, attempt)。
	txn := fmt.Sprintf("%s:%d:referral", runtime.RID, runtime.Attempt)
	inserted, err := s.repository.SaveProviderLedgerRow(ctx, &repository.GalaxyProviderLedger{
		BizLine: bizLine, TxnID: txn, OwnerUserID: referral.InvitedBy, Type: ledgerReferral,
		Unit: unitCredit, Amount: bonus, Price: bps, UnitID: runtime.RID,
		RelatedUserID: contribution.OwnerUserID,
	})
	if err != nil || !inserted {
		// 插不进去 = 这次执行的奖励已经记过（重放）。什么都不做才是对的。
		return
	}
	// 入账跟着账本行走：上面那一行插进去了，这里才加余额。
	_ = s.repository.AddCredit(ctx, bizLine, referral.InvitedBy, bonus)
	// 平台账上记一笔支出，两侧才对得平 —— 这笔钱是平台额外出的，不是从谁头上扣的。
	_ = s.repository.SavePlatformLedger(ctx, []*repository.GalaxyPlatformLedger{{
		BizLine: bizLine, TxnID: txn, Type: ledgerReferral, Amount: bonus, UnitID: runtime.RID,
	}})
}

// clawbackProviderReferral 申诉成立时，把那次执行带出来的邀请奖励按原额退回去。
//
// 按**当初真的给出去的那个数**退，不按现在的比例重算：比例改过之后重算会多退或少退，
// 而账本上那一行写着当时是按多少算的。
func (s *service) clawbackProviderReferral(ctx context.Context, row *repository.GalaxyDispute) {
	if row == nil {
		return
	}
	txn := fmt.Sprintf("%s:%d:referral", row.UnitID, row.Attempt)
	award, err := s.repository.FindProviderLedgerByTxn(ctx, bizLine, txn)
	if err != nil || award.Amount <= 0 || award.OwnerUserID == "" {
		return
	}
	inserted, err := s.repository.SaveProviderLedgerRow(ctx, &repository.GalaxyProviderLedger{
		BizLine: bizLine, TxnID: txn + ":dispute", OwnerUserID: award.OwnerUserID,
		Type: ledgerReferralClawback, Unit: unitCredit, Amount: -award.Amount,
		Price: award.Price, UnitID: row.UnitID, RelatedUserID: award.RelatedUserID,
	})
	if err != nil || !inserted {
		return
	}
	_ = s.repository.AddCredit(ctx, bizLine, award.OwnerUserID, -award.Amount)
	_ = s.repository.SavePlatformLedger(ctx, []*repository.GalaxyPlatformLedger{{
		BizLine: bizLine, TxnID: txn + ":dispute", Type: ledgerReferralClawback,
		Amount: -award.Amount, UnitID: row.UnitID,
	}})
}

// referralBps 把配置里的比例折成万分之一，并且封在 0~100% 之间。
//
// 存进账本的是这个整数而不是那个浮点数：账上的比例要能逐笔对得出金额，
// 0.1 这种十进制小数在二进制浮点里本来就不是精确值。
func referralBps(rate float64) int64 {
	if rate <= 0 || math.IsNaN(rate) {
		return 0
	}
	bps := int64(math.Round(rate * 10000))
	if bps > 10000 {
		return 10000
	}
	return bps
}
