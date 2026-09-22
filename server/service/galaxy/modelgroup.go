package galaxy

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 模型分组（2026-09-22）。
//
// 分组是平台在卖的那个单位：价挂在它上面，密钥选中它才签得出来，共享者加入它才接得到单，
// 请求进来先落到一个分组上，然后**一切按这个分组的属性决策** —— 强度夹到它卖的档里，
// 快速按它开不开。
//
// 为什么把推理强度与快速从请求体里收上来：这两个旋钮直接换算成钱，而拨旋钮的是客户端
// 内置的默认值（Claude Code 默认 high，Codex 默认 medium），不是买单的人做的选择。
// 平台按一份价收、上游按另一份价扣，差额全由平台垫。收进分组之后，运营卖的是
// 「标准 / 深度 / 快速」这种说得清楚的档次，而不是把上游的字段名转述给使用者。

// groupCacheTTL 分组快照多久回查一次。
//
// 它在**每一次中转请求**的路径上（解析这次落哪个分组），所以不能按条查库；
// 又因为运营改完分组要立刻看到效果，也不能只在启动时读一次。十五秒和运行参数
// （settingsTTL）同一个量级，理由也一样：没有哪一项是「晚十几秒就会出事」的。
//
// 本进程自己改过分组（SaveModelGroup / DeleteModelGroup）会立刻作废快照，
// 所以运营在管理端看到的永远是刚存进去的那份；其余进程等这十五秒。
const groupCacheTTL = 15 * time.Second

type groupCache struct {
	mu       sync.RWMutex
	rows     []*repository.GalaxyModelGroup
	loadedAt time.Time
}

// groups 分组目录的进程内快照（含下架的）。
//
// 含下架的：老密钥可能还选着一个已经下架的分组，而「下架」的意思是不再卖给新用户，
// 不是「已经买了的人立刻停服」。候选清单那几处自己再按 Listed 过滤。
func (s *service) groups(ctx context.Context) ([]*repository.GalaxyModelGroup, error) {
	if s.groupCache == nil || s.repository == nil {
		return nil, nil
	}
	s.groupCache.mu.RLock()
	rows, loadedAt := s.groupCache.rows, s.groupCache.loadedAt
	s.groupCache.mu.RUnlock()
	if !loadedAt.IsZero() && time.Since(loadedAt) < groupCacheTTL {
		return rows, nil
	}
	fresh, err := s.repository.ListModelGroups(ctx, bizLine, "", false)
	if err != nil {
		// 查不到就先用旧的：分组是「这一单按什么价收」，数据库抖一下不该让
		// 全站请求改按模型通价收钱 —— 那是静默的收入差额。一份都没有才真的报错。
		if rows != nil {
			return rows, nil
		}
		return nil, err
	}
	s.groupCache.mu.Lock()
	s.groupCache.rows, s.groupCache.loadedAt = fresh, time.Now()
	s.groupCache.mu.Unlock()
	return fresh, nil
}

// invalidateGroups 让下一次读重新查库。改过分组之后调用。
func (s *service) invalidateGroups() {
	if s.groupCache == nil {
		return
	}
	s.groupCache.mu.Lock()
	s.groupCache.loadedAt = time.Time{}
	s.groupCache.mu.Unlock()
}

// groupPolicy 一行分组 → 派单与改写请求体要用的那份策略。
func groupPolicy(row *repository.GalaxyModelGroup, family string) contract.GroupPolicy {
	if row == nil {
		return contract.UnconstrainedPolicy()
	}
	return contract.GroupPolicy{
		GroupID: row.GroupID, ModelID: row.ModelID, Name: row.Name, Family: family,
		Efforts: decodeStrings(row.EffortsJSON), AllowFast: row.AllowFast,
	}
}

// ResolveGroupPolicy 这一次请求落在哪个分组上。
//
// 三条路，顺序不能换：
//
//  1. 请求没有模型（count_tokens 之类）—— 不约束。没有模型就谈不上分组，
//     而替它挑一个分组会让一次不产出内容的请求按某个档次的价记账。
//  2. 密钥选了分组 —— 在选中的那些里找**这个模型**的那一个。找不到就是
//     「这把密钥没买这个模型」，明确拒绝：悄悄回落到默认分组，等于把一个人
//     没付钱的档次送给他，而账单上看不出任何异常。
//  3. 密钥没选分组（存量密钥、运营代签的）—— 落到这个模型的默认分组；
//     模型压根没建分组就不约束，行为和加分组之前完全一样。
//
// 第 3 条是**迁移期的退路**，不是常态：新签的密钥一律要选（见 CreateConsumerKey）。
func (s *service) ResolveGroupPolicy(ctx context.Context, caller dto.Caller, route contract.RouteKey) (contract.GroupPolicy, error) {
	model := strings.TrimSpace(route.Model)
	if model == "" {
		return contract.UnconstrainedPolicy(), nil
	}
	rows, err := s.groups(ctx)
	if err != nil {
		return contract.UnconstrainedPolicy(), err
	}
	if len(caller.Groups) > 0 {
		selected := map[string]bool{}
		for _, id := range caller.Groups {
			selected[strings.TrimSpace(id)] = true
		}
		for _, row := range rows {
			if selected[row.GroupID] && row.ModelID == model {
				return groupPolicy(row, route.Family), nil
			}
		}
		return contract.GroupPolicy{}, contract.NewUnitError(contract.ErrorClassInput, contract.CodeModelNotAllowed, false,
			fmt.Sprintf("密钥没有选中模型 %s 的分组，换一把或新建一把选上它", model))
	}
	var fallback *repository.GalaxyModelGroup
	for _, row := range rows {
		if row.ModelID != model {
			continue
		}
		if row.Default() {
			return groupPolicy(row, route.Family), nil
		}
		// 没有默认分组时退而求其次：取第一个上架的。顺序由仓储按 (sort_order, name) 定，
		// 也就是运营自己排的顺序 —— 随便挑一个会让同一把密钥今天按这份价、明天按那份价收。
		if fallback == nil && row.Listed {
			fallback = row
		}
	}
	return groupPolicy(fallback, route.Family), nil
}

// ---------- 运营：分组的增删改 ----------

// AdminModelGroups 管理端「商品与定价」里的分组清单，含两套价与平台毛利。
func (s *service) AdminModelGroups(ctx context.Context) ([]dto.ModelGroupView, error) {
	rows, err := s.repository.ListModelGroups(ctx, bizLine, "", false)
	if err != nil {
		return nil, err
	}
	models, err := s.repository.ListModels(ctx, bizLine, false)
	if err != nil {
		return nil, err
	}
	prices, err := s.repository.ListEffectivePrices(ctx, bizLine, "", time.Now())
	if err != nil {
		return nil, err
	}
	catalog := map[string]*repository.GalaxyModel{}
	for _, model := range models {
		catalog[model.ModelID] = model
	}
	views := make([]dto.ModelGroupView, 0, len(rows))
	for _, row := range rows {
		views = append(views, s.adminGroupView(ctx, row, catalog[row.ModelID], prices))
	}
	return views, nil
}

func (s *service) adminGroupView(
	ctx context.Context,
	row *repository.GalaxyModelGroup,
	model *repository.GalaxyModel,
	prices []*repository.GalaxyPrice,
) dto.ModelGroupView {
	kind, family, displayName := portalKind, "", row.ModelID
	if model != nil {
		kind = defaultString(model.Kind, portalKind)
		modelFamily := model.Family
		if modelFamily == "" {
			modelFamily, _ = inferFamily(model.ModelID)
		}
		family = protocolFamily(modelFamily)
		displayName = defaultString(model.DisplayName, model.ModelID)
	} else {
		inferred, _ := inferFamily(row.ModelID)
		family = protocolFamily(inferred)
	}
	table, own := resolvePrices(prices, kind, row.ModelID, row.GroupID)
	view := dto.ModelGroupView{
		GroupID: row.GroupID, ModelID: row.ModelID, ModelName: displayName,
		Name: row.Name, Summary: row.Summary, Family: family,
		Efforts: orEmpty(decodeStrings(row.EffortsJSON)), AllowFast: row.AllowFast,
		Listed: row.Listed, IsDefault: row.Default(), SortOrder: row.SortOrder,
		// Priced 只认「输入和输出都是这个分组自己的行」。只有一档是专属的那些分组，
		// 另一档其实还是模型通价，说成专属会让运营按错的数做决定。
		Priced:            own[contract.UnitInputTokens] >= priceLayerGroup && own[contract.UnitOutputTokens] >= priceLayerGroup,
		InputPrice:        table[contract.UnitInputTokens].Price,
		OutputPrice:       table[contract.UnitOutputTokens].Price,
		CachePrice:        table[contract.UnitCacheReadTokens].Price,
		CacheWritePrice:   table[contract.UnitCacheWrite5mTokens].Price,
		CacheWrite1hPrice: table[contract.UnitCacheWrite1hTokens].Price,

		SettleInputPrice:        settleUnitPrice(table[contract.UnitInputTokens]),
		SettleOutputPrice:       settleUnitPrice(table[contract.UnitOutputTokens]),
		SettleCachePrice:        settleUnitPrice(table[contract.UnitCacheReadTokens]),
		SettleCacheWritePrice:   settleUnitPrice(table[contract.UnitCacheWrite5mTokens]),
		SettleCacheWrite1hPrice: settleUnitPrice(table[contract.UnitCacheWrite1hTokens]),
	}
	view.MarginBps = marginBps(view.OutputPrice, view.SettleOutputPrice)
	if count, err := s.repository.CountKeysUsingGroup(ctx, bizLine, row.GroupID); err == nil {
		view.Keys = count
	}
	return view
}

// SaveModelGroup 新增或改一个分组。
//
// 两道硬校验，都在这里而不在界面上：
//
//   - 档位名必须是上游认识的。分组绑了一个 "High"、"max " 这样的值不会报错、
//     也匹配不上任何一次请求，表现是「这个分组的强度限制从来没生效过」——
//     而那正是运营以为自己设好了的东西。
//   - 模型必须在目录里。分组是挂在模型下卖的，模型名打错一个字母，
//     这个分组在三个端上都不会出现，运营只会看到「我建了但它不在」。
func (s *service) SaveModelGroup(ctx context.Context, req dto.SaveModelGroupRequest) error {
	modelID := strings.TrimSpace(req.ModelID)
	name := strings.TrimSpace(req.Name)
	if modelID == "" || name == "" {
		return errors.New("模型与分组名都要填")
	}
	model, err := s.repository.FindModel(ctx, bizLine, modelID)
	if notFound(err) {
		return fmt.Errorf("模型目录里没有 %s，先把模型建出来再给它分组", modelID)
	}
	if err != nil {
		return err
	}
	family := model.Family
	if family == "" {
		family, _ = inferFamily(model.ModelID)
	}
	efforts, err := normalizeGroupEfforts(protocolFamily(family), req.Efforts)
	if err != nil {
		return err
	}
	now := time.Now()
	groupID := strings.TrimSpace(req.GroupID)
	row := &repository.GalaxyModelGroup{
		BizLine: bizLine, GroupID: groupID, ModelID: modelID,
		Name: truncate(name, 64), Summary: truncate(strings.TrimSpace(req.Summary), 256),
		EffortsJSON: encodeJSON(efforts), AllowFast: req.AllowFast,
		Listed: true, SortOrder: req.SortOrder,
	}
	if groupID == "" {
		row.GroupID = "mg_" + NewULID(now)
	}
	if req.Listed != nil {
		row.Listed = *req.Listed
	}
	if req.IsDefault != nil && *req.IsDefault {
		yes := true
		row.IsDefault = &yes
	}
	if err := s.repository.SaveModelGroup(ctx, row); err != nil {
		return err
	}
	s.invalidateGroups()
	return nil
}

// DeleteModelGroup 删一个分组。
//
// 还有密钥在用就先拦一道：删掉之后那些密钥的每一次请求都会落到
// 「选了一个不存在的分组」上，而报出来的只有一句「模型不允许」，
// 使用者和客服都看不出发生了什么。运营确认之后可以强删。
func (s *service) DeleteModelGroup(ctx context.Context, req dto.DeleteModelGroupRequest) error {
	groupID := strings.TrimSpace(req.GroupID)
	if groupID == "" {
		return errors.New("要删哪个分组")
	}
	if !req.Force {
		count, err := s.repository.CountKeysUsingGroup(ctx, bizLine, groupID)
		if err != nil {
			return err
		}
		if count > 0 {
			return fmt.Errorf("还有 %d 把有效密钥选着这个分组，删掉之后它们会调不动这个模型；确认要删就再点一次", count)
		}
	}
	if err := s.repository.DeleteModelGroup(ctx, bizLine, groupID); err != nil {
		return err
	}
	s.invalidateGroups()
	return nil
}

// normalizeGroupEfforts 收敛分组绑定的档位：去空、去重、按该族由浅到深排。
//
// 排序不是为了好看：「最浅的一档」是夹强度时要挑的那个（contract.GroupPolicy.LowestEffort），
// 而运营在界面上看到的顺序就该是那个顺序，否则他设完一个分组，
// 说不出请求被夹到哪一档去了。
//
// 族认不出来时（gemini 之类还没接的上游）只做去重，不校验也不排序 ——
// 替一个我们并不了解的上游宣布它的计价刻度，比放过一个错值更糟。
func normalizeGroupEfforts(family string, values []string) ([]string, error) {
	ladder := contract.FamilyEfforts(family)
	seen := map[string]bool{}
	kept := make([]string, 0, len(values))
	for _, raw := range values {
		effort := strings.ToLower(strings.TrimSpace(raw))
		if effort == "" || seen[effort] {
			continue
		}
		if len(ladder) > 0 && contract.NormalizeEffort(family, effort) == "" {
			return nil, fmt.Errorf("推理强度 %q 不是 %s 认识的档位，可选：%s",
				raw, family, strings.Join(ladder, " / "))
		}
		seen[effort] = true
		kept = append(kept, effort)
	}
	if len(ladder) == 0 {
		return kept, nil
	}
	ordered := make([]string, 0, len(kept))
	for _, effort := range ladder {
		if seen[effort] {
			ordered = append(ordered, effort)
			delete(seen, effort)
		}
	}
	rest := make([]string, 0, len(seen))
	for effort := range seen {
		rest = append(rest, effort)
	}
	sort.Strings(rest)
	return append(ordered, rest...), nil
}

// ---------- 对外：分组的三副面孔 ----------

// modelGroupPrices 一个模型在卖的分组，连同它们的价。
//
// pick 决定取哪一个数：对外价（门户、使用端）还是结算价（共享端）。
// 两边共用同一批行、同一道回落 —— 各写一遍取价，同一个分组迟早在门户上标一个数、
// 在共享端显示另一个数，而两个数之差就是平台抽成。
func modelGroupPrices(
	groups []*repository.GalaxyModelGroup,
	prices []*repository.GalaxyPrice,
	kind, modelID string,
	pick func(priceRow) int64,
) []dto.ModelGroupPrice {
	out := make([]dto.ModelGroupPrice, 0, 4)
	for _, row := range groups {
		if row.ModelID != modelID || !row.Listed {
			continue
		}
		table, _ := resolvePrices(prices, kind, modelID, row.GroupID)
		out = append(out, dto.ModelGroupPrice{
			GroupID: row.GroupID, Name: row.Name, Summary: row.Summary,
			AllowFast: row.AllowFast, IsDefault: row.Default(),
			InputPrice:  pick(table[contract.UnitInputTokens]),
			OutputPrice: pick(table[contract.UnitOutputTokens]),
			CachePrice:  pick(table[contract.UnitCacheReadTokens]),
			// 缓存写入两档都给：TTL 是调用方在 cache_control 里自己写的，平台既控制不了
			// 也预测不了，只标一档的话用 1h 的人按 5m 的价算成本，账单会比他算的贵六成。
			CacheWritePrice:   pick(table[contract.UnitCacheWrite5mTokens]),
			CacheWrite1hPrice: pick(table[contract.UnitCacheWrite1hTokens]),
		})
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// listPrice / settlePrice 是上面那个 pick 的两种取法。
func listPrice(row priceRow) int64   { return row.Price }
func settlePrice(row priceRow) int64 { return settleUnitPrice(row) }

// ConsumerGroupOptions 使用端新建密钥那一屏的候选：每个已上架模型的每个上架分组一行。
//
// 带着价给：选分组就是选价钱，把价留在另一个页面上，使用者得开两个标签页对着看。
func (s *service) ConsumerGroupOptions(ctx context.Context) (dto.ConsumerGroupCatalog, error) {
	models, err := s.repository.ListModels(ctx, bizLine, true)
	if err != nil {
		return dto.ConsumerGroupCatalog{}, err
	}
	groups, err := s.repository.ListModelGroups(ctx, bizLine, "", true)
	if err != nil {
		return dto.ConsumerGroupCatalog{}, err
	}
	prices, err := s.repository.ListEffectivePrices(ctx, bizLine, "", time.Now())
	if err != nil {
		return dto.ConsumerGroupCatalog{}, err
	}
	catalog := dto.ConsumerGroupCatalog{Options: []dto.ConsumerGroupOption{}}
	for _, model := range models {
		family, vendor := model.Family, model.Vendor
		if family == "" || vendor == "" {
			inferredFamily, inferredVendor := inferFamily(model.ModelID)
			family = defaultString(family, inferredFamily)
			vendor = defaultString(vendor, inferredVendor)
		}
		kind := defaultString(model.Kind, portalKind)
		for _, price := range modelGroupPrices(groups, prices, kind, model.ModelID, listPrice) {
			catalog.Options = append(catalog.Options, dto.ConsumerGroupOption{
				ModelID: model.ModelID, ModelName: defaultString(model.DisplayName, model.ModelID),
				Vendor: vendor, Family: family, Category: familyCategory(family), Group: price,
			})
		}
	}
	return catalog, nil
}

// keyGroupViews 把密钥上存的分组 id 解成界面能显示的东西。
//
// 解不出来的（分组被删了）也要给出去，标上 Missing：那把密钥此刻确实调不动那个模型，
// 而静默丢掉这一条，界面上会显示成「这把密钥没选任何分组」——那是另一回事（存量密钥），
// 处置方式完全不同。
func (s *service) keyGroupViews(ctx context.Context, ids []string) []dto.KeyGroupView {
	// 空的也要给一个空切片，不能是 nil：nil 序列化出去是 null 而不是 []，
	// 而界面那边是 class-transformer 把响应灌进类里的 —— 它会把 null 原样盖上去，
	// 类字段上写的 `= []` 只在字段整个缺席时才留得住。存量密钥全都没有分组，
	// 一个 null 就够让密钥页整页崩掉。
	if len(ids) == 0 {
		return []dto.KeyGroupView{}
	}
	rows, err := s.groups(ctx)
	if err != nil {
		rows = nil
	}
	byID := make(map[string]*repository.GalaxyModelGroup, len(rows))
	for _, row := range rows {
		byID[row.GroupID] = row
	}
	models, _ := s.repository.ListModels(ctx, bizLine, false)
	names := make(map[string]string, len(models))
	for _, model := range models {
		names[model.ModelID] = defaultString(model.DisplayName, model.ModelID)
	}
	views := make([]dto.KeyGroupView, 0, len(ids))
	for _, id := range ids {
		row, ok := byID[id]
		if !ok {
			views = append(views, dto.KeyGroupView{GroupID: id, Missing: true})
			continue
		}
		views = append(views, dto.KeyGroupView{
			GroupID: row.GroupID, ModelID: row.ModelID, ModelName: names[row.ModelID],
			Name: row.Name, AllowFast: row.AllowFast, Missing: !row.Listed,
		})
	}
	return views
}

// validateKeyGroups 签发密钥时校验选中的分组：存在、上架、且一个模型只选一个。
//
// 一个模型两个分组必须拦：一次请求只认模型，两个分组就回答不了「按哪份价收」，
// 而随便挑一个的后果是同一把密钥今天按标准价、明天按深度价收钱。
func (s *service) validateKeyGroups(ctx context.Context, ids []string) ([]string, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := s.groups(ctx)
	if err != nil {
		return nil, err
	}
	byID := make(map[string]*repository.GalaxyModelGroup, len(rows))
	for _, row := range rows {
		byID[row.GroupID] = row
	}
	seenModel := map[string]string{}
	kept := make([]string, 0, len(ids))
	for _, raw := range ids {
		id := strings.TrimSpace(raw)
		if id == "" {
			continue
		}
		row, ok := byID[id]
		if !ok || !row.Listed {
			return nil, fmt.Errorf("分组 %s 不存在或已下架，刷新一下再选", id)
		}
		if previous, clash := seenModel[row.ModelID]; clash {
			return nil, fmt.Errorf("模型 %s 只能选一个分组，现在选了「%s」和「%s」", row.ModelID, previous, row.Name)
		}
		seenModel[row.ModelID] = row.Name
		kept = append(kept, id)
	}
	return kept, nil
}
