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
	// 分组：共享者要回答的是「跑哪个模型的哪个分组更赚」，以及「我加入了哪些」。
	groups, err := s.repository.ListModelGroups(ctx, bizLine, "", true)
	if err != nil {
		return nil, err
	}

	// 这个人名下的全部贡献。**不按状态过滤**：加入哪些分组是主人定的规则，
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
		views = append(views, providerModelView(row, priceRows, groups, contributions, earned))
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
	groups []*repository.GalaxyModelGroup,
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
	table, own := resolvePrices(priceRows, kind, row.ModelID, "")

	view := dto.ProviderModelView{
		ModelID: row.ModelID, DisplayName: defaultString(row.DisplayName, row.ModelID),
		Vendor: vendor, Family: family, Kind: kind,
		ContextTokens: row.ContextTokens, MaxOutputTokens: row.MaxOutputTokens,
		Tags: decodeStrings(row.TagsJSON), Summary: row.Summary,
		BadgeText: row.BadgeText, BadgeTone: badgeTone(row.BadgeText, row.BadgeTone),
		// 结算价，不是对外价。settleUnitPrice 会把还没填结算价的行按老比例折出来，
		// 和真正记进账本的数是同一个算式 —— 这一页说的数必须等于收益页加出来的数。
		InputPrice:  settleUnitPrice(table[contract.UnitInputTokens]),
		OutputPrice: settleUnitPrice(table[contract.UnitOutputTokens]),
		CachePrice:  settleUnitPrice(table[contract.UnitCacheReadTokens]),
		// 缓存写入两格：5 分钟与 1 小时，和使用端模型广场（portal 的 applyKindPrice）
		// 取的是同一对单位，两端说的话一致。TTL 由调用方在请求体里自己写，
		// 共享者这边只是照单记账 —— 两档都摆出来他才知道接到 1h 的那笔多记了多少。
		//
		// 不能取合计（llm.cache_write_tokens）：那个单位是 5m + 1h 的和、
		// **永远不进账本**（billing 的 derivedUnits），价目表里通常压根没有它的价 ——
		// 取它这一格恒为 0，共享者看到「缓存写入 0 积分」，以为跑缓存白干。
		CacheWritePrice:   settleUnitPrice(table[contract.UnitCacheWrite5mTokens]),
		CacheWrite1hPrice: settleUnitPrice(table[contract.UnitCacheWrite1hTokens]),

		// 要「输入和输出都落在这个模型自己的行上」才算它有专属价。只有一档是专属的
		// 那些模型，另一档其实还是兜底价，说成专属会让人按错的数做决定。
		Priced: own[contract.UnitInputTokens] >= priceLayerModel &&
			own[contract.UnitOutputTokens] >= priceLayerModel,
		Earned7d:  earned[row.ModelID],
		SortOrder: row.SortOrder,
		// 按分组的结算价。共享者要回答的是「跑哪个模型的哪个分组更赚」——
		// 深档那个分组烧掉的推理 token 多一个量级，往往也单独加过价，
		// 只给一个模型通价，这一页就答不了那个问题。
		Groups: modelGroupPrices(groups, priceRows, kind, row.ModelID, settlePrice),
	}
	joined := map[string]bool{}
	for _, contribution := range contributions {
		if containsString(decodeStrings(contribution.ModelsAvailableJSON), row.ModelID) {
			view.Available = true
		}
		// 分组名单为空 = 这条车道不限分组，什么单都接。它和「加入了全部分组」
		// 在界面上是两句话：前者会自动接上新建的分组，后者不会。
		lanes := decodeStrings(contribution.GroupsJSON)
		if len(lanes) == 0 {
			view.GroupsUnrestricted = true
			continue
		}
		for _, id := range lanes {
			joined[id] = true
		}
	}
	for _, price := range view.Groups {
		if joined[price.GroupID] {
			view.JoinedGroups = append(view.JoinedGroups, price.GroupID)
		}
	}
	// 开放与否就是「加入了这个模型底下的某个分组没有」：分组是唯一的范围闸，
	// 模型通配名单那一维 2026-09-22 起不再存在。
	//
	// 不限分组的车道（GroupsUnrestricted）要这个模型**确实有分组在卖**才算开放 ——
	// 一个没建分组的模型谁也接不到它的单，说成「已开放」是句空话。
	view.Allowed = len(view.JoinedGroups) > 0 || (view.GroupsUnrestricted && len(view.Groups) > 0)
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

// ---------- 模型候选 ----------

// ProviderModelOptions 共享设置页「接哪些分组」的候选项：平台在卖的模型，
// 每个模型底下挂着它的分组。
//
// 为什么不复用「模型」那一页（ProviderModels）：那一页要算四档结算价、要比对
// 每个人加入了哪些分组、还要数最近七天赚了多少 —— 填规则的人一个都用不上，
// 而共享设置这一页会跟着切机器、切车道反复取。这里只要名字。
//
// 也不从节点的 availableModels 汇总：那是「这台机器的上游此刻有什么」，
// 上游抽一次风候选项就空半天（见 pool/models.rs 的降级），而主人这会儿
// 要填的是一条长期生效的规则。两者都要 —— 界面上把「平台在卖」当清单，
// 把「这台机器有」当标注，见 ShareSettings 的 groupChoices。
func (s *service) ProviderModelOptions(ctx context.Context) ([]dto.ModelOptionGroup, error) {
	rows, err := s.repository.ListModels(ctx, bizLine, true)
	if err != nil {
		return nil, err
	}
	// 分组跟着模型一起给：共享设置那一屏勾的就是分组，而分组要按所属模型摆成一行一行。
	// 分开两条接口取的话，两份数据会在不同时刻到达，界面得自己对齐模型与它的分组。
	groups, err := s.repository.ListModelGroups(ctx, bizLine, "", true)
	if err != nil {
		return nil, err
	}
	// 价也一起：勾不勾一个分组就是「这一档值不值得我接」的决定，而那个决定要看着数字做。
	// 取的是**结算价**（settlePrice），和「模型」那一页同一个口径 —— 共享端从不看对外价。
	prices, err := s.repository.ListEffectivePrices(ctx, bizLine, "", time.Now())
	if err != nil {
		return nil, err
	}
	return modelOptionGroups(rows, groups, prices), nil
}

// modelOptionGroups 已上架的模型目录 → 按厂商分组的候选项。
//
// 分组键是**族**（claude / gpt / gemini / other），组上再带一个 Category
// （claude / codex / other）给前端认车道 —— 两套名字不合并的理由见
// portal.go 的 protocolFamily：族是给人看的分栏，另一套是别的用途的键。
//
// 顺序一律跟着目录本身（仓储已按 sort_order, model_id 排过）：运营把主推的
// 模型排在前面是有意的，替他排一次等于把这个决定抹掉。组的顺序按首次出现。
func modelOptionGroups(
	rows []*repository.GalaxyModel,
	groups []*repository.GalaxyModelGroup,
	prices []*repository.GalaxyPrice,
) []dto.ModelOptionGroup {
	order := make([]string, 0, 2)
	// byFamily 按厂商分栏。名字里带 family 是为了和上面那份「模型分组」分开 ——
	// 这个文件里「组」有两个意思：界面上的厂商分栏，和平台在卖的模型分组。
	byFamily := make(map[string]*dto.ModelOptionGroup, 2)
	for _, row := range rows {
		family, vendor := row.Family, row.Vendor
		if family == "" || vendor == "" {
			inferredFamily, inferredVendor := inferFamily(row.ModelID)
			family = defaultString(family, inferredFamily)
			vendor = defaultString(vendor, inferredVendor)
		}
		group, ok := byFamily[family]
		if !ok {
			group = &dto.ModelOptionGroup{
				Category: familyCategory(family), Vendor: vendor, Family: family,
				Models: []dto.ModelOption{},
			}
			byFamily[family] = group
			order = append(order, family)
		}
		group.Models = append(group.Models, dto.ModelOption{
			ModelID: row.ModelID, DisplayName: defaultString(row.DisplayName, row.ModelID),
			// 和「模型」那一页算价的是同一个函数、同一个 pick —— 两页对同一个分组
			// 报出不同的数，共享者会按其中一个错的做决定，而我们分不清是哪一个错。
			Groups: modelGroupPrices(groups, prices, defaultString(row.Kind, portalKind), row.ModelID, settlePrice),
		})
	}
	// 空目录回空切片而不是 nil：nil 序列化出去是 null，前端的 .find() 会崩。
	out := make([]dto.ModelOptionGroup, 0, len(order))
	for _, family := range order {
		out = append(out, *byFamily[family])
	}
	return out
}
