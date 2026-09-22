package dto

// 模型分组：平台真正在卖的那个单位（2026-09-22）。
//
// 一个模型底下有若干个分组，分组上挂着价（对外价 + 结算价）、绑定的推理强度、
// 以及卖不卖「快速」。使用者建密钥时选分组，共享者共享时选分组，
// 请求进来先落到一个分组上，然后**一切按这个分组的属性决策**。
//
// 三个端看到的是同一批分组的三副面孔，和模型那一页的分工一模一样：
//
//	管理端  全部属性 + 两个价 + 平台毛利     —— 它要定价
//	使用端  分组名、说明、能力、对外价       —— 他付这个数
//	共享端  分组名、说明、能力、结算价       —— 他赚这个数
//
// 三份都**不含推理强度的档位名**。档位名是上游的内部刻度（output_config.effort /
// reasoning.effort），把它摆到对外界面上，等于让上游的字段名替平台解释自己在卖什么；
// 上游换一次词表，三个端的文案一起失效。运营在管理端把档位绑进分组，
// 对外只说「标准 / 深度 / 快速」。

// ModelGroupView 管理端看到的一个分组。
type ModelGroupView struct {
	GroupID string `json:"groupId"`
	ModelID string `json:"modelId"`
	// ModelName 所属模型的展示名。分组列表是跨模型的一张表，只给 modelId
	// 会让运营在一屏 claude-opus-4-6-20260514 里认名字。
	ModelName string `json:"modelName,omitempty"`
	Name      string `json:"name"`
	Summary   string `json:"summary,omitempty"`
	// Family 协议族（anthropic / openai），界面按它决定「绑定强度」那个多选给哪张词表。
	Family string `json:"family,omitempty"`
	// Efforts 绑定的推理强度。空 = 不限：请求带什么档就按什么档打上游。
	// 非空时，不在表里的档会被夹到表里最浅的那一档。
	Efforts []string `json:"efforts"`
	// AllowFast 卖不卖快速。关着时，客户端开了快速也不算数。
	AllowFast bool `json:"allowFast"`
	Listed    bool `json:"listed"`
	// IsDefault 该模型的默认分组：没选分组的老密钥落在它上面。每个模型最多一个。
	IsDefault bool `json:"isDefault"`
	SortOrder int  `json:"sortOrder"`
	// Priced 这个分组有没有自己的价目行。没有就是跟着模型通价走 ——
	// 界面要说得出区别，否则一屏分组显示同一个数，看起来像页面坏了。
	Priced bool `json:"priced"`
	// 五档**对外**单价，口径同模型卡片（每百万 token 微分）。
	InputPrice        int64 `json:"inputPrice"`
	OutputPrice       int64 `json:"outputPrice"`
	CachePrice        int64 `json:"cachePrice"`
	CacheWritePrice   int64 `json:"cacheWritePrice"`
	CacheWrite1hPrice int64 `json:"cacheWrite1hPrice"`
	// 五档**结算**单价：跑一次记给共享者多少微积分。
	SettleInputPrice        int64 `json:"settleInputPrice"`
	SettleOutputPrice       int64 `json:"settleOutputPrice"`
	SettleCachePrice        int64 `json:"settleCachePrice"`
	SettleCacheWritePrice   int64 `json:"settleCacheWritePrice"`
	SettleCacheWrite1hPrice int64 `json:"settleCacheWrite1hPrice"`
	// MarginBps 按输出价算的平台毛利率，万分之一。负数是平台在倒贴。
	MarginBps int `json:"marginBps"`
	// Keys 还有几把有效密钥选中了它。删之前要看这个数。
	Keys int64 `json:"keys"`
}

// SaveModelGroupRequest 新增或改一个分组。GroupID 为空是新增。
type SaveModelGroupRequest struct {
	GroupID string `json:"groupId"`
	ModelID string `json:"modelId" binding:"required"`
	Name    string `json:"name" binding:"required"`
	Summary string `json:"summary"`
	// Efforts 绑定的推理强度。空数组 = 不限。
	Efforts   []string `json:"efforts"`
	AllowFast bool     `json:"allowFast"`
	// Listed / IsDefault 是指针：false 和「没传」在这两件事上不是一回事 ——
	// 前端只改名字时不该顺手把一个上架的分组下架掉。
	Listed    *bool `json:"listed"`
	IsDefault *bool `json:"isDefault"`
	SortOrder int   `json:"sortOrder"`
}

// DeleteModelGroupRequest 删一个分组，连同它名下的价目行。
type DeleteModelGroupRequest struct {
	GroupID string `json:"groupId" binding:"required"`
	// Force 明知还有密钥在用也要删。不给的话服务端会拦下来并告诉运营有几把。
	Force bool `json:"force"`
}

// ModelGroupPrice 对外的一个分组：名字、能力、五档单价。
//
// 口径随所在视图 —— 门户与使用端是**对外价**，共享端是**结算价**，
// 和模型卡片上那几个数一致（见 ProviderModelView 的说明）。
//
// 它取代了原先的 ModelEffortPrice：档位名不再出现在任何一个对外界面上。
type ModelGroupPrice struct {
	GroupID string `json:"groupId"`
	Name    string `json:"name"`
	Summary string `json:"summary,omitempty"`
	// AllowFast 这个分组支不支持快速。不支持时，客户端开了快速也会被改写掉 ——
	// 这句话必须在买之前就说清楚，否则使用者只会看到「我开了快速但它没快」。
	AllowFast bool `json:"allowFast"`
	// IsDefault 该模型的默认分组。没选分组的老密钥落在它上面。
	IsDefault   bool  `json:"isDefault,omitempty"`
	InputPrice  int64 `json:"inputPrice"`
	OutputPrice int64 `json:"outputPrice"`
	CachePrice  int64 `json:"cachePrice"`
	// 缓存写入分 TTL 两档，对应 llm.cache_write_5m_tokens 与 llm.cache_write_1h_tokens。
	CacheWritePrice   int64 `json:"cacheWritePrice"`
	CacheWrite1hPrice int64 `json:"cacheWrite1hPrice"`
}

// ConsumerGroupOption 使用端新建密钥时的一个候选分组。
//
// 只有「买什么」要用的信息：哪个模型、哪个分组、什么价、支不支持快速。
// 强度档位不在里面（见本文件开头）。
type ConsumerGroupOption struct {
	ModelID   string          `json:"modelId"`
	ModelName string          `json:"modelName"`
	Vendor    string          `json:"vendor,omitempty"`
	Family    string          `json:"family,omitempty"`
	Category  string          `json:"category,omitempty"`
	Group     ModelGroupPrice `json:"group"`
}

// ConsumerGroupCatalog 新建密钥那一屏要的全部候选，按模型摊平成一行一个分组。
//
// 摊平而不是嵌套：那一屏要做的选择就是「一个模型选一个分组」，
// 嵌套结构会让前端先展开模型、再展开分组，而使用者心里只有一个清单。
type ConsumerGroupCatalog struct {
	Options []ConsumerGroupOption `json:"options"`
}
