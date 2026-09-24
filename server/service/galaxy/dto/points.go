package dto

import "time"

// ---------- 使用者积分 ----------
//
// 1 积分 = ¥1。所有积分字段都是「微积分」（÷1_000_000 得到积分），和 amount / price
// 同一量纲 —— 一次请求按单价算出来多少微元，就从余额里扣掉多少微积分，
// 中间没有第二个换算系数。

// 积分流水的类型。
const (
	PointsRecharge         = "recharge"          // 运营充值
	PointsUsage            = "usage"             // 调模型按量扣掉
	PointsRefund           = "refund"            // 申诉成立，那一笔退回来
	PointsReferral         = "referral"          // 邀请来的人被充值，返给邀请人
	PointsRegistrationGift = "registration_gift" // 注册活动赠送，只能用于消费，不能提现
	// PointsPurchase 买额度包花掉。**只剩历史**：额度包已经下架，不再产生新的这类流水。
	PointsPurchase = "purchase"
)

// PointsSummary 积分页顶上那排数字。几个合计都取自流水，不另存一份计数。
type PointsSummary struct {
	Balance int64 `json:"balance"`
	// Recharged 运营累计充进来的；Used 按量消费累计花掉的（正数，已扣掉退款）；
	// Referral 分享累计返进来的；Spent 是**历史**额度包购买，新账号恒为 0。
	Recharged int64 `json:"recharged"`
	Used      int64 `json:"used"`
	Referral  int64 `json:"referral"`
	Spent     int64 `json:"spent"`
}

// PointsLedgerQuery 翻流水。使用端的 OwnerUserID 由令牌决定；运营可以按 OwnerKeyword 找人。
type PointsLedgerQuery struct {
	// Operator 由接口层按路由填：运营看得到全站、备注、经手人和不打码的名字。
	Operator     bool   `form:"-"`
	OwnerUserID  string `form:"-"`
	OwnerKeyword string `form:"keyword"`
	Type         string `form:"type"`
	Offset       int    `form:"offset"`
	Limit        int    `form:"limit"`
}

// PointsLedgerEntry 一行积分流水。
type PointsLedgerEntry struct {
	TxnID       string `json:"txnId"`
	OwnerUserID string `json:"ownerUserId"`
	// OwnerName 主人的「昵称（用户名）」，只有运营的列表会填。
	OwnerName    string `json:"ownerName,omitempty"`
	Type         string `json:"type"`
	Amount       int64  `json:"amount"`
	BalanceAfter int64  `json:"balanceAfter"`
	// BaseAmount 充值：实付金额（微元）；返现：那笔充值的积分。
	BaseAmount int64  `json:"baseAmount"`
	RateBps    int64  `json:"rateBps,omitempty"`
	OrderID    string `json:"orderId,omitempty"`
	// UnitID 消费与退款指向的那一次请求。账单上的 unitId 就是它，申诉也钉这个。
	UnitID string `json:"unitId,omitempty"`
	// Kind 这笔消费调的是哪类能力（llm.chat / video.…），配上 ModelID 就说得清钱花在哪。
	Kind string `json:"kind,omitempty"`
	// RelatedName 返现流水上被邀请人的用户名，打过码。邀请人和被邀请人互相只看得到这么多。
	RelatedName string    `json:"relatedName,omitempty"`
	ModelID     string    `json:"modelId,omitempty"`
	Remark      string    `json:"remark,omitempty"`
	Operator    string    `json:"operator,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
}

type PointsLedgerPage struct {
	Total   int64               `json:"total"`
	Entries []PointsLedgerEntry `json:"entries"`
}

// RechargePointsRequest 运营给使用者充积分。
type RechargePointsRequest struct {
	UserID string `json:"userId" binding:"required"`
	// Points 充多少积分（微积分）。
	Points int64 `json:"points"`
	// PaidAmount 对方实付了多少钱（微元），只记账不参与计算；送的积分就填 0。
	PaidAmount int64  `json:"paidAmount"`
	Remark     string `json:"remark"`
	// RequestID 前端打开充值框时生成一次。网络抖一下、按钮点两下，同一个 RequestID 只充一次。
	RequestID string `json:"requestId"`
	Operator  string `json:"-"`
}

// CreateConsumerKeyRequest 使用者自助新建一把密钥。
//
// 密钥不再带额度：额度就是账户里的积分余额，哪把密钥调用都扣同一份余额。
// 所以这里没有「买什么」「充多少」，只有一个名字 —— 名字是用来区分
// 「这把接的是哪台机器 / 哪个客户端」的，换发和吊销都按它认人。
type CreateConsumerKeyRequest struct {
	UserID string `json:"-"`
	Alias  string `json:"alias"`
	// Groups 这把密钥要用的模型分组（mg_…），**必填**：中转按分组走，
	// 没选分组的密钥回答不了「这次按哪份价收」。一个模型最多选一个分组。
	Groups []string `json:"groups"`
	// NoticeVersion 当前生效的数据告知版本。确认过才发得出密钥（C-13）。
	NoticeVersion string `json:"noticeVersion"`
}

// ---------- 分享 ----------

// ReferralOverview 分享页要的东西：自己的邀请码、邀请了几个人、一共返了多少、按多少返。
type ReferralOverview struct {
	InviteCode string `json:"inviteCode"`
	Invitees   int64  `json:"invitees"`
	Earned     int64  `json:"earned"`
	// DefaultBps 返现比例，万分之一。返现按**被邀请人充值的金额**算，
	// 所以只有一个比例 —— 充值不挑模型，也就没有按模型分开的比例。
	DefaultBps int64 `json:"defaultBps"`
}

// InviteeView 被邀请的人。用户名打码：邀请人只需要知道「有人来了、充了多少」。
type InviteeView struct {
	Name     string    `json:"name"`
	JoinedAt time.Time `json:"joinedAt"`
	Earned   int64     `json:"earned"`
}

type InviteePage struct {
	Total    int64         `json:"total"`
	Invitees []InviteeView `json:"invitees"`
}

// ReferralSettings 运营的返现开关：被邀请人每充一笔，按这个比例返给邀请人。
type ReferralSettings struct {
	DefaultBps int64      `json:"defaultBps"`
	UpdatedBy  string     `json:"updatedBy,omitempty"`
	UpdatedAt  *time.Time `json:"updatedAt,omitempty"`
}

type SaveReferralSettingsRequest struct {
	DefaultBps int64  `json:"defaultBps"`
	UpdatedBy  string `json:"-"`
}

// ---------- 密钥明文 ----------

// KeySecretView 取回的密钥明文与接入地址。运营转交、本人「使用」都拿这一份。
type KeySecretView struct {
	KeyID  string `json:"keyId"`
	Secret string `json:"secret"`
	// BaseURL 就是 SDK 要填的 base_url（带 /v1）。服务端没配时是空串。
	BaseURL string `json:"baseUrl"`
}

// AdminKeyQuery 运营翻全站密钥。
type AdminKeyQuery struct {
	OwnerUserID string `form:"ownerUserId"`
	Keyword     string `form:"keyword"`
	Status      string `form:"status"`
	Offset      int    `form:"offset"`
	Limit       int    `form:"limit"`
}

// AdminKeyView 运营看到的一把密钥：比使用者自己看到的多一个主人和他的余额。
type AdminKeyView struct {
	ConsumerKeyView
	OwnerUserID string `json:"ownerUserId"`
	OwnerName   string `json:"ownerName"`
	// Balance 主人账户此刻的积分余额。额度不再挂在密钥上，运营要判断
	// 「这把为什么调不动」，看的是这个数而不是密钥自己的什么额度。
	Balance int64  `json:"balance"`
	OrderID string `json:"orderId,omitempty"`
}

type AdminKeyPage struct {
	Total int64          `json:"total"`
	Keys  []AdminKeyView `json:"keys"`
}

// ---------- 模型广场 ----------

// ConsumerCatalog 使用端模型广场一次取回的东西：在卖哪些模型、各自什么价。
//
// 和门户那份 PortalOverview 同源，差在一处：每个模型带着此刻的分享返现比例 ——
// 门户是给陌生人看的，那个比例跟他们无关。
//
// 不再有套餐：额度包已经下架，调模型按单价逐笔扣账户余额，
// 这一页只回答「有哪些模型、每百万 token 多少积分」。
type ConsumerCatalog struct {
	Endpoint   string              `json:"endpoint"`
	Models     []ConsumerModelView `json:"models"`
	DefaultBps int64               `json:"defaultBps"`
	UpdatedAt  time.Time           `json:"updatedAt"`
}

type ConsumerModelView struct {
	PortalModelView
	// Category 这个模型属于哪一类：claude / codex / other。
	Category string `json:"category"`
}
