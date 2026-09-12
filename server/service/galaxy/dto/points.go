package dto

import "time"

// ---------- 使用者积分 ----------
//
// 1 积分 = ¥1。所有积分字段都是「微积分」（÷1_000_000 得到积分），和 amount / price
// 同一量纲 —— 套餐标价是多少微元，花掉的就是多少微积分，中间没有第二个换算系数。

// 积分流水的类型。
const (
	PointsRecharge = "recharge" // 运营充值
	PointsPurchase = "purchase" // 买套餐花掉
	PointsReferral = "referral" // 邀请来的人买套餐，返给邀请人
)

// PointsSummary 积分页顶上那排数字。几个合计都取自流水，不另存一份计数。
type PointsSummary struct {
	Balance int64 `json:"balance"`
	// Recharged 运营累计充进来的；Spent 买套餐累计花掉的（正数）；Referral 分享累计返进来的。
	Recharged int64 `json:"recharged"`
	Spent     int64 `json:"spent"`
	Referral  int64 `json:"referral"`
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
	// BaseAmount 充值：实付金额（微元）；返现：那笔购买实付的积分。
	BaseAmount int64  `json:"baseAmount"`
	RateBps    int64  `json:"rateBps,omitempty"`
	OrderID    string `json:"orderId,omitempty"`
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

// PurchaseRequest 使用者用积分买一个套餐。TargetKeyID 非空表示充进这把已有密钥，空表示签发新密钥。
type PurchaseRequest struct {
	UserID        string `json:"-"`
	PackageCode   string `json:"packageCode" binding:"required"`
	TargetKeyID   string `json:"targetKeyId"`
	NoticeVersion string `json:"noticeVersion"`
	// RequestID 前端每次准备下一单时生成一个。按钮点两下、超时重试，同一个 RequestID 只扣一次积分，
	// 第二次拿回的是第一次那一单。
	RequestID string `json:"requestId"`
}

// ---------- 分享 ----------

// ReferralOverview 分享页要的东西：自己的邀请码、邀请了几个人、一共返了多少，以及各模型的返现比例。
type ReferralOverview struct {
	InviteCode string `json:"inviteCode"`
	Invitees   int64  `json:"invitees"`
	Earned     int64  `json:"earned"`
	// DefaultBps 通用套餐（没绑模型的）的返现比例，万分之一。
	DefaultBps int64              `json:"defaultBps"`
	Rates      []ReferralRateView `json:"rates"`
}

// ReferralRateView 一个上架模型此刻生效的返现比例（单独设的，或者回落到默认的）。
type ReferralRateView struct {
	ModelID     string `json:"modelId"`
	DisplayName string `json:"displayName"`
	Family      string `json:"family"`
	Bps         int64  `json:"bps"`
	// Inherited 为真表示这个模型没单独设，用的是默认比例。
	Inherited bool `json:"inherited"`
}

// InviteeView 被邀请的人。用户名打码：邀请人只需要知道「有人来了、买了多少」。
type InviteeView struct {
	Name     string    `json:"name"`
	JoinedAt time.Time `json:"joinedAt"`
	Earned   int64     `json:"earned"`
}

type InviteePage struct {
	Total    int64         `json:"total"`
	Invitees []InviteeView `json:"invitees"`
}

// ReferralSettings 运营的返现开关。各模型自己的比例在模型目录上改。
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

// AdminKeyView 运营看到的一把密钥：比使用者自己看到的多一个主人。
type AdminKeyView struct {
	ConsumerKeyView
	OwnerUserID string `json:"ownerUserId"`
	OwnerName   string `json:"ownerName"`
	OrderID     string `json:"orderId,omitempty"`
}

type AdminKeyPage struct {
	Total int64          `json:"total"`
	Keys  []AdminKeyView `json:"keys"`
}

// ---------- 模型广场 ----------

// ConsumerCatalog 使用端模型广场一次取回的东西：模型、每个模型下的套餐、通用套餐。
//
// 和门户那份 PortalOverview 同源，差在两处：套餐按绑定的模型挂到模型下面；
// 每个模型带着此刻的分享返现比例 —— 门户是给陌生人看的，那个比例跟他们无关。
type ConsumerCatalog struct {
	Endpoint string              `json:"endpoint"`
	Models   []ConsumerModelView `json:"models"`
	// Packages 没绑模型、或者绑的模型已经不在目录里的上架套餐。
	Packages   []PackageView `json:"packages"`
	DefaultBps int64         `json:"defaultBps"`
	UpdatedAt  time.Time     `json:"updatedAt"`
}

type ConsumerModelView struct {
	PortalModelView
	// Category 这个模型属于哪一类：claude / codex / other。
	Category    string        `json:"category"`
	ReferralBps int64         `json:"referralBps"`
	Packages    []PackageView `json:"packages"`
}
