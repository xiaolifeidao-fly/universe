package galaxy

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"contract"
	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 门户面：未登录也能看到的模型目录、定价与「联系我们」。
//
// 这一面和控制台面共用同一套数据，但读的口径不同：控制台回答「我这把密钥还剩多少」，
// 门户回答「你们卖什么、多少钱」。所以这里的每个方法都不带用户维度，
// 也一律不碰余额、订单、节点这些跟具体的人有关的东西 —— 一个未鉴权的接口
// 只要漏一次用户维度的数据，就是全站可爬。

const (
	leadStatusNew     = "new"
	leadStatusHandled = "handled"
	leadStatusClosed  = "closed"

	// leadWindow / leadBurst 同一 IP 的提交限流。
	// 一小时 5 条：正常来访者填一次就走，填到第六次的多半不是人。
	leadWindow = time.Hour
	leadBurst  = 5

	// portalKind 模型目录没写 kind 时的默认值。门户的主线是中转站这一条；
	// 其余能力（比如视频渲染）只有在上架了对应商品时才会出现在单价表里，
	// 见 portalKinds。
	portalKind = "llm.chat"

	// 卡片角标的四种配色。给的是语义名而不是颜色名：库里存「这是个主推位」，
	// 每个端再按自己的调色板去渲染 —— Orbit 青绿、Nova 暖铜，同一条记录
	// 存一个 "red" 进去，到了另一个端就没处安放。
	badgeToneHot     = "hot"     // 主推、旗舰
	badgeToneNew     = "new"     // 首发、刚上
	badgeToneValue   = "value"   // 性价比、划算
	badgeToneNeutral = "neutral" // 纯说明，不强调

	// maxBadgeText 角标文案上限，与 badge_text 那一列同宽。
	// 四个汉字是这个位置能放下的极限，再长就把模型名挤到换行。
	maxBadgeText = 16
)

// PortalCatalog 门户一次取回整站要展示的东西。
//
// fallbackModels 是部署方在 galaxy.models 里声明的那份清单（relay 的 /v1/models 用的
// 就是它）。目录表为空时用它兜底：门户少几行文案，但不会是一页空白 ——
// 对一个刚部署完还没来得及填目录的环境，这是唯一体面的结果。
func (s *service) PortalCatalog(ctx context.Context, fallbackModels []string) (dto.PortalOverview, error) {
	now := time.Now()

	rows, err := s.repository.ListModels(ctx, bizLine, true)
	if err != nil {
		return dto.PortalOverview{}, err
	}
	models := make([]dto.PortalModelView, 0, len(rows))
	for _, row := range rows {
		models = append(models, portalModelView(row))
	}
	if len(models) == 0 {
		models = fallbackModelViews(fallbackModels)
	}

	// 价目行取一次，几十个模型在内存里各挑各的 —— 单价已经能按模型定了，
	// 再按 kind 取一张表给所有模型用，门户上标的就不是这个模型真会收的价。
	// 门户要跨 kind 列全部模型，这里不收窄。
	priceRows, err := s.repository.ListEffectivePrices(ctx, bizLine, "", now)
	if err != nil {
		return dto.PortalOverview{}, err
	}
	for index := range models {
		kind := defaultString(models[index].Kind, portalKind)
		table, own := resolvePrices(priceRows, kind, models[index].ModelID)
		applyKindPrice(&models[index], table, own)
	}

	sort.SliceStable(models, func(i, j int) bool {
		if models[i].SortOrder != models[j].SortOrder {
			return models[i].SortOrder < models[j].SortOrder
		}
		return models[i].ModelID < models[j].ModelID
	})

	packages, err := s.ListPackages(ctx, true)
	if err != nil {
		return dto.PortalOverview{}, err
	}

	prices, err := s.portalPrices(ctx, now, portalKinds(models, packages))
	if err != nil {
		return dto.PortalOverview{}, err
	}

	return dto.PortalOverview{
		Endpoint:  s.cfg().ConsumerBaseURL,
		Stats:     s.portalStats(models, packages),
		Families:  portalFamilies(models),
		Models:    models,
		Packages:  packages,
		Prices:    prices,
		UpdatedAt: now,
	}, nil
}

// portalKinds 门户上**真能买到**的那些能力。
//
// 单价表只列这些：价格表里还有 delivery.task 这种没有对外文案、门户上也买不到的
// 能力，摆上去只会让人问「这个怎么用」而我们答不上来。
//
// 判据是「模型目录里出现过」或「某个上架商品显式允许」。允许范围为空的商品是
// 「不限」，不贡献 kind —— 它能用的正是模型目录里那些，已经算进去了。
func portalKinds(models []dto.PortalModelView, packages []dto.PackageView) map[string]bool {
	kinds := map[string]bool{}
	for _, model := range models {
		kinds[defaultString(model.Kind, portalKind)] = true
	}
	for _, item := range packages {
		for _, kind := range item.AllowedKinds {
			if trimmed := strings.TrimSpace(kind); trimmed != "" {
				kinds[trimmed] = true
			}
		}
	}
	return kinds
}

// portalPrices 当前生效的单价表，每个 (kind, unit) 只留最新生效的那条。
// 不计价的单位（calls、time.seconds）本来就不在价格表里，不用特意过滤。
func (s *service) portalPrices(ctx context.Context, at time.Time, kinds map[string]bool) ([]dto.PortalPriceLine, error) {
	rows, err := s.repository.ListEffectivePrices(ctx, bizLine, "", at)
	if err != nil {
		return nil, err
	}
	seen := map[string]int{}
	lines := make([]dto.PortalPriceLine, 0, len(rows))
	for _, row := range rows {
		if len(kinds) > 0 && !kinds[row.Kind] {
			continue
		}
		// 这张表回答的是「这个 kind 怎么收费」，所以只列兜底价。
		// 把模型的特例也铺进来，同一个 kind 会出现好几行不同的 input_tokens 价，
		// 而这一页没有「哪个模型」这一列，读者只会当成价目表自相矛盾。
		if row.ModelID != "" {
			continue
		}
		key := row.Kind + "|" + row.Unit
		line := dto.PortalPriceLine{
			Kind: row.Kind, Unit: row.Unit, Price: row.Price,
			Currency: defaultString(row.Currency, "CNY"),
		}
		// 行按 effective_from 升序回来，后来的盖掉先来的 —— 同组最后一条就是当前价。
		if index, ok := seen[key]; ok {
			lines[index] = line
			continue
		}
		seen[key] = len(lines)
		lines = append(lines, line)
	}
	sort.Slice(lines, func(i, j int) bool {
		if lines[i].Kind != lines[j].Kind {
			return lines[i].Kind < lines[j].Kind
		}
		return lines[i].Unit < lines[j].Unit
	})
	return lines, nil
}

func (s *service) portalStats(models []dto.PortalModelView, packages []dto.PackageView) dto.PortalStats {
	stats := dto.PortalStats{
		Models:       len(models),
		Packages:     len(packages),
		Currency:     "CNY",
		KeyTTLDays:   wholeDays(s.cfg().KeyTTL),
		FreezeDays:   wholeDays(s.cfg().KeyFreeze),
		Concurrency:  s.cfg().KeyConcurrency,
		RPM:          s.cfg().KeyRPM,
		Availability: strings.TrimSpace(s.cfg().PortalAvailability),
	}
	vendors, families := map[string]bool{}, map[string]bool{}
	for _, model := range models {
		if model.Vendor != "" {
			vendors[model.Vendor] = true
		}
		families[model.Family] = true
		if model.ContextTokens > stats.MaxContext {
			stats.MaxContext = model.ContextTokens
		}
	}
	stats.Vendors, stats.Families = len(vendors), len(families)
	for _, item := range packages {
		if item.Amount <= 0 {
			continue
		}
		if stats.MinTopup == 0 || item.Amount < stats.MinTopup {
			stats.MinTopup = item.Amount
			stats.Currency = defaultString(item.Currency, stats.Currency)
		}
		// 并发与速率取上架商品里最高的那档：首页说的是「最高能到多少」。
		if item.Concurrency > stats.Concurrency {
			stats.Concurrency = item.Concurrency
		}
		if item.RPM > stats.RPM {
			stats.RPM = item.RPM
		}
	}
	return stats
}

// portalFamilies 模型页的分栏。顺序按「族里最便宜的输入价」升序 ——
// 便宜的排前面，来访者第一眼看到的是他大概率会选的那一栏。
func portalFamilies(models []dto.PortalModelView) []dto.PortalFamilyView {
	index := map[string]*dto.PortalFamilyView{}
	var order []string
	for _, model := range models {
		family, ok := index[model.Family]
		if !ok {
			family = &dto.PortalFamilyView{
				Family: model.Family, Vendor: model.Vendor,
				Currency: defaultString(model.Currency, "CNY"),
			}
			index[model.Family] = family
			order = append(order, model.Family)
		}
		family.Count++
		if model.InputPrice > 0 && (family.MinInput == 0 || model.InputPrice < family.MinInput) {
			family.MinInput = model.InputPrice
		}
	}
	views := make([]dto.PortalFamilyView, 0, len(order))
	for _, key := range order {
		views = append(views, *index[key])
	}
	sort.SliceStable(views, func(i, j int) bool {
		left, right := views[i].MinInput, views[j].MinInput
		if left == right {
			return views[i].Family < views[j].Family
		}
		if left == 0 || right == 0 {
			return right == 0 // 没有价的排后面
		}
		return left < right
	})
	return views
}

func portalModelView(row *repository.GalaxyModel) dto.PortalModelView {
	family, vendor := row.Family, row.Vendor
	if family == "" || vendor == "" {
		inferredFamily, inferredVendor := inferFamily(row.ModelID)
		family = defaultString(family, inferredFamily)
		vendor = defaultString(vendor, inferredVendor)
	}
	return dto.PortalModelView{
		ModelID: row.ModelID, DisplayName: defaultString(row.DisplayName, row.ModelID),
		Vendor: vendor, Family: family, Kind: defaultString(row.Kind, portalKind),
		ContextTokens: row.ContextTokens, MaxOutputTokens: row.MaxOutputTokens,
		InputPrice: row.InputPrice, OutputPrice: row.OutputPrice,
		CachePrice: row.CachePrice, CacheWritePrice: row.CacheWritePrice,
		ListInputPrice: row.ListInputPrice, ListOutputPrice: row.ListOutputPrice,
		DiscountBps: discountBps(row.OutputPrice, row.ListOutputPrice),
		Currency:    defaultString(row.Currency, "CNY"),
		Tags:        decodeStrings(row.TagsJSON), Summary: row.Summary,
		BadgeText: row.BadgeText, BadgeTone: badgeTone(row.BadgeText, row.BadgeTone),
		Featured: row.Featured, SortOrder: row.SortOrder,
		// 要「输入和输出都填了」才算这个模型自己的价。
		//
		// 用 || 的话，只填了 input 的那一行会被当成已定价：门户不再标「统一价」，
		// 而 output 那格显示的其实是 kind 的统一价 —— 访问者会把它读成
		// 这个模型的真实输出价。半份价格比没有价格更危险。
		Priced: row.InputPrice > 0 && row.OutputPrice > 0,
	}
}

// fallbackModelViews 目录表为空时，把声明清单摊成最朴素的一份目录。
// 只有模型名和推出来的族 —— 上下文长度、能力标签这些没有出处的东西一律留空。
func fallbackModelViews(declared []string) []dto.PortalModelView {
	views := make([]dto.PortalModelView, 0, len(declared))
	seen := map[string]bool{}
	for _, raw := range declared {
		id := strings.TrimSpace(raw)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		family, vendor := inferFamily(id)
		views = append(views, dto.PortalModelView{
			ModelID: id, DisplayName: id, Family: family, Vendor: vendor,
			Kind: portalKind, Currency: "CNY", SortOrder: len(views),
		})
	}
	return views
}

// applyKindPrice 模型目录没填展示价时，回落到计价表里它真会被收的那个价。
//
// 回落有两层：先看这个模型自己的计价行，没有才用 kind 的兜底价。own 分得清
// 落到了哪一层 —— 落到兜底价才叫「统一价」，Priced 置 false，门户据此说明
// 「这几个数字不是这个模型专属的」；落到模型自己的计价行时，卡片上标的就是
// 它真会被收的价，再说成统一价就是在骗人。
//
// Priced 最后统一算一遍，而不是边填边置 false：目录只填了 input、output 靠
// 模型自己的计价行补上，这种半填的行两个数都是它自己的，Priced 该是 true。
func applyKindPrice(model *dto.PortalModelView, table map[contract.MeterUnit]priceRow, own map[contract.MeterUnit]bool) {
	// fill 返回「这一档最终是不是这个模型自己的价」。目录里填过的当然算。
	fill := func(unit contract.MeterUnit, price *int64) bool {
		if *price > 0 {
			return true
		}
		row, ok := table[unit]
		if !ok {
			return false
		}
		*price = row.Price
		return own[unit]
	}
	if model.InputPrice == 0 {
		if price, ok := table[contract.UnitInputTokens]; ok {
			model.Currency = defaultString(price.Currency, model.Currency)
		}
	}
	inputOwn := fill(contract.UnitInputTokens, &model.InputPrice)
	outputOwn := fill(contract.UnitOutputTokens, &model.OutputPrice)
	fill(contract.UnitCacheReadTokens, &model.CachePrice)
	// 缓存写入单独回落。它和缓存读取不是一档：写入比普通输入还贵，读取便宜一个数量级，
	// 让写入跟着读取的价走等于按十分之一收。
	fill(contract.UnitCacheWriteTokens, &model.CacheWritePrice)
	// 要「输入和输出都是这个模型自己的」才算它有专属价。用 || 的话，
	// 只有一档是专属的那些模型会被当成整份都专属，另一档其实是统一价。
	model.Priced = inputOwn && outputOwn
	model.Currency = defaultString(model.Currency, "CNY")
	// 折扣按**卡片上最终显示的那个价**重算：回落到统一价之后再拿建表时的
	// 0 去比，「省 X%」要么消失要么是个 100%。访问者读到的是「我要付这个数、
	// 官方收那个数」，所以比的就该是他真会付的那个数。
	model.DiscountBps = discountBps(model.OutputPrice, model.ListOutputPrice)
}

// discountBps 自家价比官方参考价便宜多少，万分之一（8500 = 省 85%）。
//
// 只按输出价算。输入与输出的折扣可以填得不一样，两个数都亮出来等于没说；
// 而账单是按输出 token 计的，输出那一档才是使用者真正要付的大头。
//
// 官方价没填、或没比自家价贵时返 0：卡片上划线价与「省 X%」一起不出现。
// 标一个「省 0%」或者负数，比什么都不标更糟。
func discountBps(price, list int64) int {
	if price <= 0 || list <= price {
		return 0
	}
	return int((list - price) * 10000 / list)
}

// badgeTone 收敛角标配色。空文案就没有角标，配色跟着一起清掉 ——
// 留一个孤零零的 tone 在 JSON 里，前端得再判一次「有色但没字」。
// 认不出来的值一律当 neutral：库里躺着一个拼错的 tone，卡片也不该因此不渲染。
func badgeTone(text, tone string) string {
	if strings.TrimSpace(text) == "" {
		return ""
	}
	switch tone {
	case badgeToneHot, badgeToneNew, badgeToneValue:
		return tone
	default:
		return badgeToneNeutral
	}
}

// inferFamily 从模型名推族与厂商。
//
// 只是个兜底：目录表里填了什么就用什么。这里认不出来的一律归 other，
// 不猜 —— 猜错会把一个模型摆进错的栏里，比摆进「其他」更糟。
func inferFamily(modelID string) (family, vendor string) {
	id := strings.ToLower(strings.TrimSpace(modelID))
	switch {
	case strings.HasPrefix(id, "claude"):
		return "claude", "anthropic"
	case strings.HasPrefix(id, "gpt"), strings.HasPrefix(id, "o1"), strings.HasPrefix(id, "o3"),
		strings.Contains(id, "codex"):
		return "gpt", "openai"
	case strings.HasPrefix(id, "gemini"):
		return "gemini", "google"
	default:
		return "other", ""
	}
}

// ---------- 联系我们 ----------

// SubmitLead 门户留资。
//
// 这是全站唯一一条未鉴权就能写库的路径，所以三道闸都在服务端：
// 蜜罐字段、按 IP 的时间窗限流、以及每个字段各自的长度截断。
// 前端那点 maxlength 只算提示 —— 打这条接口的不一定经过前端。
func (s *service) SubmitLead(ctx context.Context, req dto.SubmitLeadRequest) (dto.LeadView, error) {
	now := time.Now()
	// 蜜罐命中：当成功打发走，不写库。回一个错等于告诉对方哪里被拦了，
	// 下一次它就把这个字段留空了。
	if strings.TrimSpace(req.Website) != "" {
		return dto.LeadView{LeadID: NewULID(now), CreatedAt: now}, nil
	}

	contact := clip(req.Contact, 128)
	if contact == "" {
		return dto.LeadView{}, fmt.Errorf("请留一个能联系到你的方式")
	}
	message := clip(req.Message, 1000)

	if ip := strings.TrimSpace(req.IP); ip != "" {
		count, err := s.repository.CountLeadsFromIP(ctx, bizLine, ip, now.Add(-leadWindow))
		if err != nil {
			return dto.LeadView{}, err
		}
		if count >= leadBurst {
			return dto.LeadView{}, fmt.Errorf("提交太频繁了，请稍后再试")
		}
	}

	row := &repository.GalaxyLead{
		BizLine: bizLine, LeadID: NewULID(now),
		Name: clip(req.Name, 64), Contact: contact, Company: clip(req.Company, 128),
		Topic: clip(defaultString(req.Topic, "other"), 32), Scale: clip(req.Scale, 32),
		Message: message, Source: clip(defaultString(req.Source, "portal"), 32),
		IP: clip(req.IP, 64), UserAgent: clip(req.UserAgent, 256),
		Status: leadStatusNew,
	}
	if err := s.repository.CreateLead(ctx, row); err != nil {
		return dto.LeadView{}, err
	}
	return dto.LeadView{LeadID: row.LeadID, CreatedAt: now}, nil
}

func (s *service) ListLeads(ctx context.Context, status string, offset, limit int) (dto.LeadPage, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	rows, total, err := s.repository.ListLeads(ctx, bizLine, strings.TrimSpace(status), offset, limit)
	if err != nil {
		return dto.LeadPage{}, err
	}
	page := dto.LeadPage{Total: total, Leads: make([]dto.LeadRecord, 0, len(rows))}
	for _, row := range rows {
		page.Leads = append(page.Leads, dto.LeadRecord{
			LeadID: row.LeadID, Name: row.Name, Contact: row.Contact, Company: row.Company,
			Topic: row.Topic, Scale: row.Scale, Message: row.Message, Source: row.Source,
			Status: row.Status, HandledBy: row.HandledBy, HandledAt: row.HandledAt,
			CreatedTime: row.CreatedTime,
		})
	}
	return page, nil
}

func (s *service) HandleLead(ctx context.Context, req dto.HandleLeadRequest) error {
	switch req.Status {
	case leadStatusNew, leadStatusHandled, leadStatusClosed:
	default:
		return fmt.Errorf("未知的线索状态：%s", req.Status)
	}
	return s.repository.UpdateLeadStatus(ctx, bizLine, req.LeadID, req.Status, req.HandledBy, time.Now())
}

// ---------- 运营维护模型目录 ----------

func (s *service) ListPortalModels(ctx context.Context, listedOnly bool) ([]dto.PortalModelView, error) {
	rows, err := s.repository.ListModels(ctx, bizLine, listedOnly)
	if err != nil {
		return nil, err
	}
	views := make([]dto.PortalModelView, 0, len(rows))
	for _, row := range rows {
		view := portalModelView(row)
		// 运营目录要看见「这一行自己填了没填价」，所以不回落到 kind 统一价。
		// 返现比例和上下架只给运营看：门户那条公开接口不走这里。
		listed := row.Listed
		view.ReferralBps, view.Listed = row.ReferralBps, &listed
		views = append(views, view)
	}
	return views, nil
}

func (s *service) SavePortalModel(ctx context.Context, req dto.SaveModelRequest) error {
	modelID := strings.TrimSpace(req.ModelID)
	if modelID == "" {
		return fmt.Errorf("模型名不能为空")
	}
	// 别的字段超长就截断，模型名不行：它要和 relay 的 /v1/models 里那个名字
	// 一模一样才有意义，截一半之后既对不上上游也搜不到，还不会报错。
	if len([]rune(modelID)) > 96 {
		return fmt.Errorf("模型名最长 96 个字符：%s", modelID)
	}
	family, vendor := inferFamily(modelID)
	listed := true
	if req.Listed != nil {
		listed = *req.Listed
	}
	if req.ReferralBps != nil && (*req.ReferralBps < 0 || *req.ReferralBps > maxReferralBps) {
		return fmt.Errorf("返现比例要在 0%% 到 100%% 之间")
	}
	if req.ListInputPrice < 0 || req.ListOutputPrice < 0 {
		return fmt.Errorf("官方参考价不能是负数")
	}
	// 官方价填得比自家价还低不拦：拦了就意味着运营为了改一个无关字段
	// （整行覆盖，每次保存都要把这两个数带回来）得先去把价格理顺。
	// 它的后果只是 discountBps 返 0、卡片上不出现划线价，运营台那一列
	// 会直接显示成「-」，看得见。
	tags := ""
	if len(req.Tags) > 0 {
		encoded, err := json.Marshal(req.Tags)
		if err != nil {
			return err
		}
		tags = clip(string(encoded), 512)
	}
	badge := clip(req.BadgeText, maxBadgeText)
	return s.repository.SaveModel(ctx, &repository.GalaxyModel{
		BizLine: bizLine, ModelID: modelID,
		DisplayName:   clip(defaultString(req.DisplayName, modelID), 96),
		Vendor:        clip(defaultString(req.Vendor, vendor), 32),
		Family:        clip(defaultString(req.Family, family), 32),
		Kind:          clip(defaultString(req.Kind, portalKind), 64),
		ContextTokens: req.ContextTokens, MaxOutputTokens: req.MaxOutputTokens,
		InputPrice: req.InputPrice, OutputPrice: req.OutputPrice,
		CachePrice: req.CachePrice, CacheWritePrice: req.CacheWritePrice,
		ListInputPrice: req.ListInputPrice, ListOutputPrice: req.ListOutputPrice,
		Currency: clip(defaultString(req.Currency, "CNY"), 8),
		TagsJSON: tags, Summary: clip(req.Summary, 256),
		BadgeText:   badge,
		BadgeTone:   badgeTone(badge, req.BadgeTone),
		ReferralBps: req.ReferralBps,
		Listed:      listed, Featured: req.Featured, SortOrder: req.SortOrder,
	})
}

// ConsumerCatalog 使用端的模型广场。
//
// 模型与单价和门户同源（PortalCatalog 那一套回落规则原样生效），差别只在组织方式：
// 套餐挂到它绑定的模型下面，每个模型带着此刻生效的返现比例。
// 绑定的模型不在上架目录里（下架了、删了）的套餐不跟着消失，落进「通用套餐」——
// 商品还在卖，只是暂时没有模型卡片可挂。
func (s *service) ConsumerCatalog(ctx context.Context, fallbackModels []string) (dto.ConsumerCatalog, error) {
	overview, err := s.PortalCatalog(ctx, fallbackModels)
	if err != nil {
		return dto.ConsumerCatalog{}, err
	}
	rates, err := s.referralRates(ctx)
	if err != nil {
		return dto.ConsumerCatalog{}, err
	}
	catalog := dto.ConsumerCatalog{
		Endpoint: overview.Endpoint, DefaultBps: rates.defaultBps, UpdatedAt: overview.UpdatedAt,
		Models:   make([]dto.ConsumerModelView, 0, len(overview.Models)),
		Packages: []dto.PackageView{},
	}
	index := make(map[string]int, len(overview.Models))
	for _, model := range overview.Models {
		index[model.ModelID] = len(catalog.Models)
		catalog.Models = append(catalog.Models, dto.ConsumerModelView{
			PortalModelView: model, Category: familyCategory(model.Family),
			ReferralBps: rates.of(model.ModelID), Packages: []dto.PackageView{},
		})
	}
	for _, item := range overview.Packages {
		if position, ok := index[item.ModelID]; ok && item.ModelID != "" {
			catalog.Models[position].Packages = append(catalog.Models[position].Packages, item)
			continue
		}
		catalog.Packages = append(catalog.Packages, item)
	}
	return catalog, nil
}

func (s *service) DeletePortalModel(ctx context.Context, modelID string) error {
	id := strings.TrimSpace(modelID)
	if id == "" {
		return fmt.Errorf("模型名不能为空")
	}
	return s.repository.DeleteModel(ctx, bizLine, id)
}

// wholeDays 把时长折成天，不足一天但大于零的算一天。
//
// 直接 int(d.Hours()/24) 的话，配成 12h 的冻结期会显示成「先冻结 0 天」——
// 一句读起来像 bug 的承诺，而它其实只是被向下取整了。
func wholeDays(value time.Duration) int {
	if value <= 0 {
		return 0
	}
	days := int(value.Hours() / 24)
	if days == 0 {
		return 1
	}
	return days
}

// clip 去空白并按**字符**截断。
//
// 按字节截会把一个汉字拦腰砍成半个 —— utf8mb4 下 varchar(64) 数的是字符，
// Go 的 len() 数的是字节，两处口径不同就会在「刚好填满」时报 1406。
func clip(value string, max int) string {
	trimmed := strings.TrimSpace(value)
	runes := []rune(trimmed)
	if len(runes) <= max {
		return trimmed
	}
	return string(runes[:max])
}
