package galaxy

import (
	"context"
	"sort"
	"time"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 共享端的模型页。
//
// 三个端看到的是三份不同的价，这一份是给出算力的人的：
//
//	管理端    对外单价 + 结算单价 + 平台毛利      —— 它要定价，所以两头都看得见
//	使用端    对外单价（模型广场、账单、套餐）    —— 他付这个数
//	共享端    **只有结算单价**                    —— 他赚这个数
//
// 共享端这一份刻意不带对外价：两个数一相除就是平台抽成，而抽成不是共享者要做的
// 决定。他要做的决定是「开放哪些模型」，那只需要知道每个模型记多少积分、
// 自己的机器上有没有它、以及最近它给自己赚了多少。

// providerEarningsWindowDays 模型页上「最近赚了多少」看几天。
// 和「今天」那一页的趋势图同一个窗口，两页的数对得上。
const providerEarningsWindowDays = 7

// ProviderModels 共享端模型页的全部内容，一个请求拿全。
//
// 只列**已上架**的模型：下架意味着平台不卖它了，跟共享者说「跑它能赚钱」是空头支票。
// 模型目录是空的就返空列表 —— 这一页的内容（说明、上下文、标签）全部来自目录，
// 没有目录就真的没东西可显示，编一份出来只会让人以为平台在卖这些。
func (s *service) ProviderModels(ctx context.Context, ownerUserID string) ([]dto.ProviderModelView, error) {
	rows, err := s.repository.ListModels(ctx, bizLine, true)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return []dto.ProviderModelView{}, nil
	}

	now := time.Now()
	// 模型页跨 kind 列全部已上架模型，这里不收窄。
	priceRows, err := s.repository.ListEffectivePrices(ctx, bizLine, "", now)
	if err != nil {
		return nil, err
	}

	// 这个人名下的全部贡献。**不按状态过滤**：允许/拒绝名单是主人定的规则，
	// 暂停只是此刻不接单，不代表他不想要这个模型。「此刻接不接得到单」
	// 是「今天」那一页回答的问题，不是这一页。
	contributions, err := s.repository.ListContributionsByOwner(ctx, bizLine, ownerUserID)
	if err != nil {
		return nil, err
	}

	earned, err := s.earningsByModel(ctx, ownerUserID, now)
	if err != nil {
		return nil, err
	}

	views := make([]dto.ProviderModelView, 0, len(rows))
	for _, row := range rows {
		views = append(views, providerModelView(row, priceRows, contributions, earned))
	}
	sort.SliceStable(views, func(i, j int) bool {
		if views[i].SortOrder != views[j].SortOrder {
			return views[i].SortOrder < views[j].SortOrder
		}
		return views[i].ModelID < views[j].ModelID
	})
	return views, nil
}

// providerModelView 一行的全部内容。不挂在 service 上 —— 它只是几份数据的函数，
// 而这一页说错一个数就是共享者按错的价做决定，拿数据直接验比起整条链路跑一遍便宜得多。
func providerModelView(
	row *repository.GalaxyModel,
	priceRows []*repository.GalaxyPrice,
	contributions []*repository.GalaxyContribution,
	earned map[string]int64,
) dto.ProviderModelView {
	family, vendor := row.Family, row.Vendor
	if family == "" || vendor == "" {
		inferredFamily, inferredVendor := inferFamily(row.ModelID)
		family = defaultString(family, inferredFamily)
		vendor = defaultString(vendor, inferredVendor)
	}
	kind := defaultString(row.Kind, portalKind)
	table, own := resolvePrices(priceRows, kind, row.ModelID)

	view := dto.ProviderModelView{
		ModelID: row.ModelID, DisplayName: defaultString(row.DisplayName, row.ModelID),
		Vendor: vendor, Family: family, Kind: kind,
		ContextTokens: row.ContextTokens, MaxOutputTokens: row.MaxOutputTokens,
		Tags: decodeStrings(row.TagsJSON), Summary: row.Summary,
		BadgeText: row.BadgeText, BadgeTone: badgeTone(row.BadgeText, row.BadgeTone),
		// 结算价，不是对外价。settleUnitPrice 会把还没填结算价的行按老比例折出来，
		// 和真正记进账本的数是同一个算式 —— 这一页说的数必须等于收益页加出来的数。
		InputPrice:      settleUnitPrice(table[contract.UnitInputTokens]),
		OutputPrice:     settleUnitPrice(table[contract.UnitOutputTokens]),
		CachePrice:      settleUnitPrice(table[contract.UnitCacheReadTokens]),
		CacheWritePrice: settleUnitPrice(table[contract.UnitCacheWriteTokens]),
		// 要「输入和输出都是这个模型自己的行」才算它有专属价。只有一档是专属的
		// 那些模型，另一档其实还是兜底价，说成专属会让人按错的数做决定。
		Priced:    own[contract.UnitInputTokens] && own[contract.UnitOutputTokens],
		Earned7d:  earned[row.ModelID],
		SortOrder: row.SortOrder,
	}
	for _, contribution := range contributions {
		if contract.ModelMatch(row.ModelID, decodeStrings(contribution.ModelsAllowJSON), decodeStrings(contribution.ModelsDenyJSON)) {
			view.Allowed = true
		}
		if containsString(decodeStrings(contribution.ModelsAvailableJSON), row.ModelID) {
			view.Available = true
		}
	}
	return view
}

// earningsByModel 最近几天每个模型给这个人记了多少积分。
//
// 只数 settle：提现是负数、邀请奖励不属于任何模型，把它们算进来这一列就
// 不再是「跑这个模型赚了多少」了。
func (s *service) earningsByModel(ctx context.Context, ownerUserID string, now time.Time) (map[string]int64, error) {
	scope, err := s.ledgerScope(ctx, ownerUserID)
	if err != nil {
		return nil, err
	}
	scope.Types = []string{ledgerSettle}
	scope.From = startOfDay(now).AddDate(0, 0, -(providerEarningsWindowDays - 1))
	scope.To = now
	rows, err := s.repository.SumProviderLedgerByModel(ctx, scope)
	if err != nil {
		return nil, err
	}
	out := make(map[string]int64, len(rows))
	for _, row := range rows {
		out[row.Model] = row.Amount
	}
	return out, nil
}
