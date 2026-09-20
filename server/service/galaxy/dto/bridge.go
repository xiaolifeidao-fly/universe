package dto

import "time"

// ai-bridge 的版本分发、远程升级，以及共享端的邀请返现。
//
// 使用端那套分享在 points.go（ReferralOverview / InviteeView）。这里的类型都带
// Provider 前缀不是啰嗦：两端是两批人、两张表、两套邀请码，名字混用迟早会有人
// 把使用端的比例填到共享端的接口上。

// ---------- 版本分发 ----------

// BridgeReleaseAsset 某个平台当前可以装的那一版。
type BridgeReleaseAsset struct {
	Platform  string `json:"platform"`
	Version   string `json:"version"`
	FileName  string `json:"fileName"`
	Size      int64  `json:"size"`
	SHA256    string `json:"sha256"`
	Signature string `json:"signature"`
	// DownloadURL 是 Hub 上的**稳定地址**（302 到对象存储），不会过期，
	// 可以写进脚本和文档。真正带签名的对象地址由那一跳当场签发。
	DownloadURL string     `json:"downloadUrl"`
	Notes       string     `json:"notes"`
	PublishedAt *time.Time `json:"publishedAt,omitempty"`
}

// BridgeReleaseManifest 下载页与安装脚本要的全部信息。
type BridgeReleaseManifest struct {
	// Version 所有平台里最高的那一版；一个包都没发布时是空串。
	Version     string     `json:"version"`
	Notes       string     `json:"notes"`
	PublishedAt *time.Time `json:"publishedAt,omitempty"`
	// HubURL 节点要填的平台地址，控制台把它拼进注册命令里。
	HubURL            string `json:"hubUrl"`
	InstallScript     string `json:"installScript"`
	InstallPowerShell string `json:"installPowerShell"`
	// Platforms 每个平台只列最新的已发布版本，顺序固定（Linux 在前：服务器占多数）。
	Platforms []BridgeReleaseAsset `json:"platforms"`
}

// ---------- 客户端安装包 ----------

// ClientDownloads 两个桌面客户端的安装包下载地址。
//
// 空串的含义是「这一块不显示」：安装包托管在哪儿服务端派生不出来，
// 猜一个只会换来一次 404。
type ClientDownloads struct {
	// ProviderURL 共享端 Nova。
	ProviderURL string `json:"providerUrl"`
	// ConsumerURL 使用端 Orbit。使用端控制台的密钥页摆的就是它。
	ConsumerURL string `json:"consumerUrl"`
}

// AdminBridgeReleasePage 管理端那一页要的全部东西：ai-bridge 的包，加上两个客户端的下载地址。
//
// 两样东西合在一条接口里，是因为它们本来就是同一个问题的两半（「用户要装的东西从哪儿拿」），
// 而且这样运营只要有这一页的读权限就都看得到 —— 客户端地址虽然存在运行参数表里，
// 但读它不必再要一份「运行参数」的授权。
type AdminBridgeReleasePage struct {
	Releases []BridgeReleaseView `json:"releases"`
	Clients  ClientDownloads     `json:"clients"`
	// ProviderSettingKey / ConsumerSettingKey 改地址时要提交给 /settings/save 的键名。
	// 由服务端给而不是前端自己拼：键名只在一处定义，改名时不会有一边悄悄留在旧名字上。
	ProviderSettingKey string `json:"providerSettingKey"`
	ConsumerSettingKey string `json:"consumerSettingKey"`
	// PropagationSeconds 改完最多多少秒在全部进程上生效（使用端控制台读的是同一行）。
	PropagationSeconds int `json:"propagationSeconds"`
}

// BridgeReleaseView 运营看到的一行，含已下架的。
type BridgeReleaseView struct {
	ReleaseID   string     `json:"releaseId"`
	Version     string     `json:"version"`
	Platform    string     `json:"platform"`
	FileName    string     `json:"fileName"`
	Size        int64      `json:"size"`
	SHA256      string     `json:"sha256"`
	Signature   string     `json:"signature"`
	Notes       string     `json:"notes"`
	Status      string     `json:"status"`
	PublishedBy string     `json:"publishedBy"`
	PublishedAt *time.Time `json:"publishedAt,omitempty"`
	CreatedAt   time.Time  `json:"createdAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
}

// PublishBridgeReleaseRequest 运营上传一个安装包。
//
// 整个包走 base64 进请求体：管理端的浏览器到 manager-api 中间隔着 Next.js 的
// 通配代理，那条路只转发 JSON。包 3 MB 上下，base64 之后 4 MB，可以接受。
type PublishBridgeReleaseRequest struct {
	// FileName 必须是 ai-bridge-<版本>-<平台>.tar.gz（windows 是 .zip）：
	// 版本与平台从它解析，不另设字段 —— 两处各填一遍迟早会不一致。
	FileName string `json:"fileName"`
	Content  string `json:"content"`
	// Signature 离线签出来的 base64。服务端先验一遍再收：验不过的包发上去，
	// 每一台机器都会在升级的最后一步拒装，而运营要到那时候才知道。
	Signature string `json:"signature"`
	Notes     string `json:"notes"`
	Operator  string `json:"-"`
}

type SetBridgeReleaseStatusRequest struct {
	ReleaseID string `json:"releaseId" binding:"required"`
	Status    string `json:"status" binding:"required"`
	Operator  string `json:"-"`
}

// ---------- 远程升级 ----------

// 升级状态。进行中的四个是节点回报的，两个终态里 succeeded 由 Hub 判定
// （重启之后 hello 报上来的版本等于目标版本），failed 两边都可能写。
const (
	UpgradePending     = "pending"
	UpgradeDownloading = "downloading"
	UpgradeInstalling  = "installing"
	UpgradeRestarting  = "restarting"
	UpgradeSucceeded   = "succeeded"
	UpgradeFailed      = "failed"
)

// NodeUpgradeCommand 搭在心跳响应上下发给节点的升级指令。
//
// URL 是当场签发的对象地址，sha256 与 signature 让节点自己把关：
// 节点先验签名（签名覆盖版本、平台、sha256），再下载、再比对 sha256。
type NodeUpgradeCommand struct {
	ID        string `json:"id"`
	Version   string `json:"version"`
	Platform  string `json:"platform"`
	URL       string `json:"url"`
	SHA256    string `json:"sha256"`
	Size      int64  `json:"size"`
	Signature string `json:"signature"`
}

// NodeUpgradeView 控制台上这台机器最近一次升级。
type NodeUpgradeView struct {
	ID          string `json:"id"`
	Version     string `json:"version"`
	FromVersion string `json:"fromVersion"`
	// Status 是**折算过**的：卡在进行中太久的会以 failed 报出来，
	// 前端不用自己算超时（算两遍迟早两边不一样）。
	Status      string     `json:"status"`
	Message     string     `json:"message"`
	RequestedAt *time.Time `json:"requestedAt,omitempty"`
	UpdatedAt   *time.Time `json:"updatedAt,omitempty"`
}

// NodeUpgradeReport 节点回报升级进度。
type NodeUpgradeReport struct {
	NodeID  string `json:"-"`
	ID      string `json:"id"`
	State   string `json:"state"`
	Message string `json:"message"`
}

// ---------- 共享端邀请返现 ----------

// ProviderReferralOverview 邀请页顶上那一块。
type ProviderReferralOverview struct {
	Code string `json:"code"`
	// Link 完整邀请链接。平台没配注册页地址时是空串，页面只显示邀请码。
	Link string `json:"link"`
	// Rate 0.1 表示返 10%。Days 是返现期限，0 表示长期。
	Rate    float64 `json:"rate"`
	Days    int     `json:"days"`
	Enabled bool    `json:"enabled"`

	Invitees    int64 `json:"invitees"`
	RewardTotal int64 `json:"rewardTotal"`
	RewardWeek  int64 `json:"rewardWeek"`
	// RewardPending 争议期内的那部分：奖励跟着被邀请人的收益走，
	// 那笔收益被申诉追回时奖励也要跟着退，所以同样要过争议期才能提。
	RewardPending int64 `json:"rewardPending"`
}

// ProviderInviteeView 一位被邀请人。名字打码：邀请人不该看到好友的完整账号。
type ProviderInviteeView struct {
	Name         string     `json:"name"`
	JoinedAt     time.Time  `json:"joinedAt"`
	RewardTotal  int64      `json:"rewardTotal"`
	LastRewardAt *time.Time `json:"lastRewardAt,omitempty"`
	// ExpiresAt 返现截止时间，只有设了期限时才有。
	ExpiresAt *time.Time `json:"expiresAt,omitempty"`
}

type ProviderInviteePage struct {
	Total int64                 `json:"total"`
	Items []ProviderInviteeView `json:"items"`
}
