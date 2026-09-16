package galaxy

import (
	"context"
	"strings"

	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 邀请返现的运营视角。
//
// 两端各有一套：使用端买套餐返给邀请人，共享端出算力返给邀请人 —— 两张关系表、
// 两套码，码不通用（注册时按端分流）。此前管理端只有一个「默认比例」开关，
// **返出去的钱一分都看不见**：谁在真的带量、平台为这个活动付了多少，都答不上来。
//
// 一个开着的返现活动，钱在流出而没人看得见流向，这本身就是个问题。

// AdminReferrals 邀请关系 + 拉人排行。
func (s *service) AdminReferrals(ctx context.Context, query dto.AdminReferralQuery) (dto.AdminReferralPage, error) {
	side := dto.SideConsumer
	if strings.TrimSpace(query.Side) == dto.SideProvider {
		side = dto.SideProvider
	}
	scope := repository.AdminReferralQuery{
		BizLine: bizLine, Side: side,
		InviterID: strings.TrimSpace(query.InviterID), Keyword: strings.TrimSpace(query.Keyword),
		InvitedOnly: query.InvitedOnly,
		Offset:      query.Offset, Limit: pageLimit(query.Limit, 20, 200),
	}
	rows, total, err := s.repository.ListAdminReferrals(ctx, scope)
	if err != nil {
		return dto.AdminReferralPage{}, err
	}
	// 排行按全站算，不是按当前这一页 —— 一页 20 行里数出来的「最多」没有意义。
	top, err := s.repository.TopInviters(ctx, bizLine, side, 10)
	if err != nil {
		return dto.AdminReferralPage{}, err
	}
	inviterIDs := make([]string, 0, len(top))
	for _, row := range top {
		inviterIDs = append(inviterIDs, row.InviterID)
	}
	payouts, err := s.repository.SumReferralPayouts(ctx, bizLine, side, inviterIDs)
	if err != nil {
		return dto.AdminReferralPage{}, err
	}

	// 名字一次查完：关系行里的 user_id 和 invited_by 都要显示成人名。
	subjects := make([]string, 0, len(rows)*2+len(inviterIDs))
	for _, row := range rows {
		subjects = append(subjects, row.UserID, row.InvitedBy)
	}
	subjects = append(subjects, inviterIDs...)
	names, err := s.userNames(ctx, side, subjects)
	if err != nil {
		return dto.AdminReferralPage{}, err
	}

	page := dto.AdminReferralPage{
		Total: total, Side: side,
		ProviderRate: s.cfg().ReferralRate, ProviderDays: s.cfg().ReferralDays,
		Records: make([]dto.ReferralRecord, 0, len(rows)),
		Top:     make([]dto.InviterRank, 0, len(top)),
	}
	// 使用端的默认比例是运营在后台设的，共享端的比例在配置文件里 —— 两端本来就不是一个来源。
	if settings, err := s.ReferralSettings(ctx); err == nil {
		page.DefaultBps = settings.DefaultBps
	}
	for _, row := range rows {
		page.Records = append(page.Records, dto.ReferralRecord{
			UserID: row.UserID, UserName: names[row.UserID], InviteCode: row.InviteCode,
			InvitedBy: row.InvitedBy, InviterName: names[row.InvitedBy], CreatedTime: row.CreatedTime,
		})
	}
	for _, row := range top {
		page.Top = append(page.Top, dto.InviterRank{
			InviterID: row.InviterID, InviterName: names[row.InviterID],
			Invitees: row.Invitees, Payout: payouts[row.InviterID],
		})
	}
	return page, nil
}
