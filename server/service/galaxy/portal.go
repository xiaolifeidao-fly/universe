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

	if err := s.applyCatalogPrices(ctx, models, now); err != nil {
		return dto.PortalOverview{}, err
	}

	sort.SliceStable(models, func(i, j int) bool {
		if models[i].SortOrder != models[j].SortOrder {
			return models[i].SortOrder < models[j].SortOrder
		}
		return models[i].ModelID < models[j].ModelID
	})

	prices, err := s.portalPrices(ctx, now, portalKinds(models))
	if err != nil {
		return dto.PortalOverview{}, err
	}

	return dto.PortalOverview{
		Endpoint:  s.cfg().ConsumerBaseURL,
		Stats:     s.portalStats(models),
		Families:  portalFamilies(models),
		Models:    models,
		Prices:    prices,
		UpdatedAt: now,
	}, nil
}

// portalKinds 门户上**真能用到**的那些能力。
//
// 单价表只列这些：价格表里还有 delivery.task 这种没有对外文案、门户上也用不上的
// 能力，摆上去只会让人问「这个怎么用」而我们答不上来。
//
// 判据是「模型目录里出现过」。
func portalKinds(models []dto.PortalModelView) map[string]bool {
	kinds := map[string]bool{}
	for _, model := range models {
		kinds[defaultString(model.Kind, portalKind)] = true
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

func (s *service) portalStats(models []dto.PortalModelView) dto.PortalStats {
	stats := dto.PortalStats{
		Models:       len(models),
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
		// 四档单价这里一律留空，由 applyKindPrice 从计价表填。模型行上原先也存过
		// 一份「展示价」，于是同一个模型的价在库里有两份、谁也不校验谁 ——
		// 门户标一个价、账上扣另一个价，两边都不会报错。现在只剩计价表一份。
		ListInputPrice: row.ListInputPrice, ListOutputPrice: row.ListOutputPrice, ListCachePrice: row.ListCachePrice,
		Currency: defaultString(row.Currency, "CNY"),
		Tags:     decodeStrings(row.TagsJSON), Summary: row.Summary,
		BadgeText: row.BadgeText, BadgeTone: badgeTone(row.BadgeText, row.BadgeTone),
		Featured: row.Featured, SortOrder: row.SortOrder,
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

// applyCatalogPrices 给一整份目录套上当前生效的对外单价。
//
// 价目行取一次，几十个模型在内存里各挑各的 —— 单价已经能按模型定了，
// 再按 kind 取一张表给所有模型用，标出来的就不是这个模型真会收的价。
// 跨 kind 列全部模型，这里不收窄。
//
// 门户目录（PortalCatalog）和运营目录（ListPortalModels）共用这一份：
// 两处各写一遍取价，同一个模型迟早在门户上标一个数、在运营台上显示另一个数，
// 而运营台恰恰是用来核对门户标了什么的那一页。
func (s *service) applyCatalogPrices(ctx context.Context, models []dto.PortalModelView, at time.Time) error {
	priceRows, err := s.repository.ListEffectivePrices(ctx, bizLine, "", at)
	if err != nil {
		return err
	}
	for index := range models {
		kind := defaultString(models[index].Kind, portalKind)
		table, own := resolvePrices(priceRows, kind, models[index].ModelID, "")
		applyKindPrice(&models[index], table, own)
		applyEffortPrices(&models[index], priceRows, kind)
	}
	return nil
}

// applyEffortPrices 给卡片补上「按强度分档」的那几行。
//
// 卡片上原有的四个数来自 effort 为空的那次取价 —— 它是「没单独定价的强度按它收」，
// 也就是绝大多数请求真正付的价。这里补的是例外：真的单独定过价的那几档。
// 一档都没有就什么也不补，界面上不会多出一块空的「按强度计价」。
func applyEffortPrices(model *dto.PortalModelView, priceRows []*repository.GalaxyPrice, kind string) {
	efforts := pricedEfforts(priceRows, kind, model.ModelID, protocolFamily(model.Family))
	if len(efforts) == 0 {
		return
	}
	model.Efforts = make([]dto.ModelEffortPrice, 0, len(efforts))
	for _, effort := range efforts {
		table, _ := resolvePrices(priceRows, kind, model.ModelID, effort)
		model.Efforts = append(model.Efforts, dto.ModelEffortPrice{
			Effort:      effort,
			InputPrice:  table[contract.UnitInputTokens].Price,
			OutputPrice: table[contract.UnitOutputTokens].Price,
			CachePrice:  table[contract.UnitCacheReadTokens].Price,
			// 和卡片上那一格同一档：绝大多数请求命中的是 5 分钟缓存，
			// 合计（llm.cache_write_tokens）不进账本、通常也没有价。
			CacheWritePrice: table[contract.UnitCacheWrite5mTokens].Price,
		})
	}
}

// applyKindPrice 把计价表里这个模型真会被收的价填进卡片。
//
// **价只有计价表一个出处。** 模型目录上原先也有四档「展示价」，那是第二份数据：
// 门户照目录标、账上照计价表扣，两个数对不上时两边都不报错，而访问者看到的是
// 一个他付不到的价。现在目录只管「这个模型是什么」。
//
// 取价分两层：先看这个模型自己的计价行，按单位找不到才用该 kind 的兜底价。
// own 分得清落到了哪一层 —— 落到兜底价才叫「统一价」，Priced 置 false，
// 门户据此说明「这几个数字不是这个模型专属的」，否则回落期间一屏模型
// 显示同一个数，看起来像页面坏了。
func applyKindPrice(model *dto.PortalModelView, table map[contract.MeterUnit]priceRow, own map[contract.MeterUnit]bool) {
	fill := func(unit contract.MeterUnit, price *int64) {
		if row, ok := table[unit]; ok {
			*price = row.Price
		}
	}
	if price, ok := table[contract.UnitInputTokens]; ok {
		model.Currency = defaultString(price.Currency, model.Currency)
	}
	fill(contract.UnitInputTokens, &model.InputPrice)
	fill(contract.UnitOutputTokens, &model.OutputPrice)
	fill(contract.UnitCacheReadTokens, &model.CachePrice)
	// 缓存写入在卡片上只有一格，取 5 分钟那一档 —— 它是绝大多数请求真正命中的 TTL。
	// 拿合计（llm.cache_write_tokens）来填是错的：那个单位不进账本，通常也没有价。
	fill(contract.UnitCacheWrite5mTokens, &model.CacheWritePrice)
	// 要「输入和输出都是这个模型自己的行」才算它有专属价。用 || 的话，
	// 只有一档是专属的那些模型会被当成整份都专属，另一档其实是统一价。
	model.Priced = own[contract.UnitInputTokens] && own[contract.UnitOutputTokens]
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

// protocolFamily 目录里的族名（claude / gpt / gemini / other）→ 协议族
// （anthropic / openai），也就是 contract 里那张强度词表的键。
//
// 两套族名不合并：目录那一套是**给人看的分栏**，门户上「Claude」「GPT」这两栏就是它；
// 协议族是**上游的接口形状**，决定请求体里那个强度字段叫什么。同一个协议族将来可能
// 装下不止一个展示族（任何 OpenAI 兼容的上游都走 openai 这一套），合成一列就再也拆不开。
//
// 认不出来的回空串 —— 那时 FamilyEfforts 给 nil，模型页就不显示强度分档。
// 猜一族会让一个我们并不了解的上游平白多出几档它没有的价。
func protocolFamily(family string) string {
	switch family {
	case "claude":
		return contract.FamilyAnthropic
	case "gpt":
		return contract.FamilyOpenAI
	}
	return ""
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
		// 上下架只给运营看：门户那条公开接口不走这里。
		listed := row.Listed
		view.Listed = &listed
		views = append(views, view)
	}
	// 和门户走同一套取价（含回落到 kind 兜底价）—— 运营目录那一列回答的正是
	// 「门户上会标成多少」，不回落的话，一个靠兜底价卖的模型在这里显示成「没有价」，
	// 而它在门户上明明标着数。落到兜底价时 Priced 为 false，界面据此标「统一价」，
	// 「这一行自己填了没填价」仍然看得见。
	if err := s.applyCatalogPrices(ctx, views, time.Now()); err != nil {
		return nil, err
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
	if req.ListInputPrice < 0 || req.ListOutputPrice < 0 || req.ListCachePrice < 0 {
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
		ListInputPrice: req.ListInputPrice, ListOutputPrice: req.ListOutputPrice, ListCachePrice: req.ListCachePrice,
		Currency: clip(defaultString(req.Currency, "CNY"), 8),
		TagsJSON: tags, Summary: clip(req.Summary, 256),
		BadgeText: badge,
		BadgeTone: badgeTone(badge, req.BadgeTone),
		Listed:    listed, Featured: req.Featured, SortOrder: req.SortOrder,
	})
}

// ConsumerCatalog 使用端的模型广场。
//
// 模型与单价和门户同源（PortalCatalog 那一套回落规则原样生效），差别只在多一个
// 类别（这个模型该接 Claude Code 还是 Codex）和此刻的返现比例。
func (s *service) ConsumerCatalog(ctx context.Context, fallbackModels []string) (dto.ConsumerCatalog, error) {
	overview, err := s.PortalCatalog(ctx, fallbackModels)
	if err != nil {
		return dto.ConsumerCatalog{}, err
	}
	settings, err := s.ReferralSettings(ctx)
	if err != nil {
		return dto.ConsumerCatalog{}, err
	}
	catalog := dto.ConsumerCatalog{
		Endpoint: overview.Endpoint, DefaultBps: settings.DefaultBps, UpdatedAt: overview.UpdatedAt,
		Models: make([]dto.ConsumerModelView, 0, len(overview.Models)),
	}
	for _, model := range overview.Models {
		catalog.Models = append(catalog.Models, dto.ConsumerModelView{
			PortalModelView: model, Category: familyCategory(model.Family),
		})
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
