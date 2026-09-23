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

// 桌面客户端的平台。取值同时是运行参数的键后缀、接口上的字段和界面上那一行的标识，
// 所以只在这里定义一次。
//
// 词表比 ai-bridge 那套（darwin-arm64 / windows-x64…）粗一档，是有意的：
// 这里回答的是「用户该点哪个下载按钮」，而用户分得清的只有「Windows / Mac 的两种芯片」。
const (
	// DesktopPlatformWindows Windows（x64 与 arm64 共用一个安装包）。
	DesktopPlatformWindows = "windows"
	// DesktopPlatformMacX64 macOS，Intel 芯片。
	DesktopPlatformMacX64 = "mac-x64"
	// DesktopPlatformMacArm64 macOS，Apple 芯片。
	DesktopPlatformMacArm64 = "mac-arm64"
)

// DesktopPlatforms 界面上的固定顺序。空串（通用下载页）不在里面 —— 它不是一个平台。
var DesktopPlatforms = []string{DesktopPlatformWindows, DesktopPlatformMacX64, DesktopPlatformMacArm64}

// DesktopDownloadURLs 一个桌面客户端的安装包地址：按平台分的三条，加一条通用的。
//
// 为什么要分平台：一个 Electron 应用出的是三个互不通用的包（Windows 的 exe、
// mac 的两种 zip/dmg），而 Apple 芯片和 Intel 那两个**不能互相代替** ——
// 把 arm64 的包给 Intel 机器，装上去直接起不来。一条地址走天下的做法，
// 要么逼运营去做一个下载页，要么就有一半人下错。
//
// Default 不是「第一条」，是**兜底**：一个列出各系统安装包的下载页。平台那条没填
// 就退回它；它也没填，那一块就不显示 —— 安装包托管在哪儿服务端派生不出来，
// 猜一个只会换来一次 404。
type DesktopDownloadURLs struct {
	// Default 通用下载页。平台地址没填时退回它。
	Default string `json:"default"`
	// Windows Windows 安装包。
	Windows string `json:"windows"`
	// MacX64 macOS（Intel）安装包。
	MacX64 string `json:"macX64"`
	// MacArm64 macOS（Apple 芯片）安装包。
	MacArm64 string `json:"macArm64"`
}

// Pick 某个平台该给哪条地址：平台那条没填就退回通用的。
//
// platform 用的是 DesktopPlatform* 那组词（空串 = 只要通用那条）。
// 认不出来的平台按空串处理 —— 给一条通用地址，而不是猜一个包。
func (u DesktopDownloadURLs) Pick(platform string) string {
	var value string
	switch platform {
	case DesktopPlatformWindows:
		value = u.Windows
	case DesktopPlatformMacX64:
		value = u.MacX64
	case DesktopPlatformMacArm64:
		value = u.MacArm64
	}
	if value != "" {
		return value
	}
	return u.Default
}

// Any 一条都没填吗。界面用它决定那一块显不显示。
func (u DesktopDownloadURLs) Any() bool {
	return u.Default != "" || u.Windows != "" || u.MacX64 != "" || u.MacArm64 != ""
}

// ClientDownloadSlot 管理端那张卡片上的一行：填哪个平台、改它要提交哪个键、现在填的是什么。
//
// 连键名一起给，是因为改地址仍然走 /settings/save —— 前端不自己拼键名，
// 拼错了会被「这一项不是可调参数」顶回来，而那是保存那一刻才看得到的错。
// 加一个平台因此只改服务端这一处（界面按 Platform 取自己的标题）。
type ClientDownloadSlot struct {
	// Platform 平台，空串表示通用下载页。
	Platform string `json:"platform"`
	// SettingKey 改这一行要提交给 /settings/save 的键名。
	SettingKey string `json:"settingKey"`
	// URL 现在填的地址，空串表示还没填。
	URL string `json:"url"`
}

// ClientDownloads 两个桌面客户端各自的那几行，按界面顺序。
type ClientDownloads struct {
	// Provider 共享端 Nova。
	Provider []ClientDownloadSlot `json:"provider"`
	// Consumer 使用端 Orbit。使用端控制台的密钥页摆的就是它们。
	Consumer []ClientDownloadSlot `json:"consumer"`
}

// AdminBridgeReleasePage 管理端那一页要的全部东西：ai-bridge 的包，加上两个客户端的下载地址。
//
// 两样东西合在一条接口里，是因为它们本来就是同一个问题的两半（「用户要装的东西从哪儿拿」），
// 而且这样运营只要有这一页的读权限就都看得到 —— 客户端地址虽然存在运行参数表里，
// 但读它不必再要一份「运行参数」的授权。
type AdminBridgeReleasePage struct {
	Releases []BridgeReleaseView `json:"releases"`
	// Clients 每个客户端一组行，键名跟着行一起给 —— 前端不自己拼键名，
	// 改名或者加一个平台时不会有一边悄悄留在旧名字上。
	Clients ClientDownloads `json:"clients"`
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

// ---------- 机器上的本机工具（claude / codex） ----------
//
// 和上面那套远程升级是两件事：那个升的是 ai-bridge 自己，这个装的是它调用的那两个
// 命令行。共用的只有「指令搭心跳下发」这条路 —— 控制台点一下，机器最多等一个心跳
// 就收到，之后的进度顺着心跳报回来。
//
// Hub 只说**装哪一个工具**，不说怎么装：命令在节点自己那张固定表里
// （pool::tools::upgrade_command）。让 Hub 送一条命令过去执行，等于把
// 「在我的机器上跑什么」这条边界交出去。

// 工具任务的状态。pending 是 Hub 这边的：指令发出去了、机器还没开工。
// 其余三个都是节点报的。
const (
	ToolJobPending   = "pending"
	ToolJobRunning   = "running"
	ToolJobSucceeded = "succeeded"
	ToolJobFailed    = "failed"
)

// NodeToolCommand 搭在心跳响应上下发的「装 / 升这个工具」。
type NodeToolCommand struct {
	ID   string `json:"id"`
	Tool string `json:"tool"`
}

// NodeToolReport 节点在心跳里自报的一个工具。字段与节点侧 ToolStatus 一一对应。
type NodeToolReport struct {
	Name string `json:"name"`
	// Current 本机在跑的版本，空串表示没装。
	Current string `json:"current"`
	// Latest 上游最新版，空串表示节点这会儿问不到（网络不通等），此时不该催人升级。
	Latest     string `json:"latest"`
	Upgradable bool   `json:"upgradable"`
	Installed  bool   `json:"installed"`
	// LoggedIn 这个工具在那台机器上登录了没有。
	//
	// **nil 不是「没登录」，是「这个问题没有意义」**：那台机器的配置里没有对应的上游，
	// 主人根本没打算共享它 —— 界面据此决定画不画登录按钮，画了只会催他登一个
	// 他不想共享的账号。老版本节点也不报这个字段，同样是 nil。
	LoggedIn *bool        `json:"loggedIn,omitempty"`
	Job      *NodeToolJob `json:"job,omitempty"`
}

// NodeToolJob 正在装 / 刚装完的那一次。
type NodeToolJob struct {
	// CommandID 这一次是被哪条指令拉起来的。节点自己在机器上点的那次没有这个值 ——
	// Hub 靠它认出「机器已经领走了我发的那条」，认不出就会一直重发。
	CommandID string `json:"commandId"`
	// Action install / upgrade；State running / succeeded / failed。
	Action string `json:"action"`
	State  string `json:"state"`
	// Phase starting / resolving / downloading / installing / done / failed。
	Phase string `json:"phase"`
	// Percent 0-100。npm 不报百分比，这是节点按真实事件推的估算，只进不退。
	Percent int `json:"percent"`
	// Detail 最后一行有信息量的输出；失败时是 npm 说的原因。
	Detail    string `json:"detail"`
	ElapsedMs int64  `json:"elapsedMs"`
	// Command 节点真正跑的那条命令，失败时摆给主人看，他可以自己去机器上跑一遍。
	Command string `json:"command"`
}

// NodeToolView 控制台上机器详情里的一行工具。
//
// 比 NodeToolReport 多一个 Job.State=pending：指令已经发出去、机器还没来领的那段时间，
// 界面上必须有东西在动 —— 否则点完按钮到下一个心跳之间，看起来就像没点上。
type NodeToolView struct {
	Name       string       `json:"name"`
	Current    string       `json:"current"`
	Latest     string       `json:"latest"`
	Upgradable bool         `json:"upgradable"`
	Installed  bool         `json:"installed"`
	LoggedIn   *bool        `json:"loggedIn,omitempty"`
	Job        *NodeToolJob `json:"job,omitempty"`
}

// ---------- 远端登录 ----------
//
// 和上面那组「装 / 升」是两种形状：装东西发出去就不用管了，而登录中间必须有主人参与。
//
//   · codex 走设备码：机器拿到短码和地址，主人在任意一台有浏览器的设备上输码，
//     机器自己轮询换 token。**单向**。
//   · claude 没有设备码流程：机器打印一条授权地址，主人在浏览器里授权完拿到一串码，
//     得把它粘回控制台，再由 Hub 送回那台机器喂给还等着的进程。**有回程**。
//
// 回程为什么也搭心跳：poll 接入的机器 Hub 连不上它（只有 export 节点有入站面），
// 机房里的机器多半是 poll。代价是码最多晚一跳才到，节点那边用「会话期间心跳提速
// 到 5 秒」补偿。

const (
	// LoginPending 指令已经发出去、机器还没来领。Hub 自己加的，节点不报这个状态。
	LoginPending = "pending"
	// LoginRunning 进程起来了，但还没拿到可以交给主人的地址。
	LoginRunning = "running"
	// LoginWaiting 地址（和短码）已就绪，在等主人。界面这时才有东西可显示。
	LoginWaiting   = "waiting"
	LoginSucceeded = "succeeded"
	LoginFailed    = "failed"

	// LoginPhaseVerifying 码已经喂进那个等着的进程了，CLI 正在拿它换 token。
	//
	// 这是回程唯一的回执。节点不会为「收到码」单报一条，但它一收到就把 phase 翻成
	// verifying —— Hub 看到这个才停止重发那串码（见 saveNodeLogins）。码要是错的，
	// 节点会把 phase 翻回 authorize 并在 detail 里写上 CLI 的原话。
	LoginPhaseVerifying = "verifying"
	// LoginPhaseAuthorize 在等主人去浏览器授权。
	LoginPhaseAuthorize = "authorize"
)

// NodeLoginCommand 搭在心跳响应上下发的登录指令。
//
// Code 为空是「起一次登录」，有值是「这是主人粘回来的码」。两者 ID 相同 ——
// 它们是同一次会话的两段，节点按 id 加码本身去重（见 pool::runner::accept_login_command）。
type NodeLoginCommand struct {
	ID   string `json:"id"`
	Tool string `json:"tool"`
	Code string `json:"code,omitempty"`
}

// NodeLoginReport 节点在心跳里自报的一次登录。字段与节点侧 LoginStatus 一一对应。
type NodeLoginReport struct {
	Tool  string `json:"tool"`
	State string `json:"state"`
	Phase string `json:"phase"`
	// VerificationURI 让主人在浏览器里打开的地址。
	VerificationURI string `json:"verificationUri"`
	// UserCode 设备码流程里要主人手输的短码。claude 没有。
	UserCode string `json:"userCode"`
	// NeedsCode 这条流程要不要主人把码粘回来。界面据此决定画不画输入框。
	NeedsCode bool `json:"needsCode"`
	// Detail 失败时是 CLI 自己说的原因（「Invalid code」那种）。
	Detail    string `json:"detail"`
	ElapsedMs int64  `json:"elapsedMs"`
	// Command 节点真正跑的那条命令，失败时摆给主人看。
	Command string `json:"command"`
	// CommandID 这一次是被哪条指令拉起来的。**回程要靠它**：主人粘码时，
	// Hub 从这里取出这次会话的 id，再把码按同一个 id 发回去。
	CommandID string `json:"commandId"`
}

// NodeLoginView 控制台上的一次登录。比上报多一个 pending：指令已发、机器还没领的那十几秒。
type NodeLoginView struct {
	Tool            string `json:"tool"`
	State           string `json:"state"`
	Phase           string `json:"phase"`
	VerificationURI string `json:"verificationUri"`
	UserCode        string `json:"userCode"`
	NeedsCode       bool   `json:"needsCode"`
	Detail          string `json:"detail"`
	ElapsedMs       int64  `json:"elapsedMs"`
	Command         string `json:"command"`
	CommandID       string `json:"commandId"`
}
