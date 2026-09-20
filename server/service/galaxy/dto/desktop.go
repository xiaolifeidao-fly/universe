package dto

import "time"

// 桌面客户端（Nova 共享端 / Orbit 使用端）的版本分发。
//
// 和 ai-bridge 那套（bridge.go）是两件事，别混：
//
//	ai-bridge   命令行版的共享节点，包三兆，字节经服务端、要验发布签名，节点自己去 Hub 要升级指令。
//	桌面客户端   Electron 应用，包一百多兆，字节**不经服务端**（浏览器拿签名地址直传 OSS），
//	            客户端按 electron-updater 的规矩直接读 OSS 上的 latest-*.yml。
//
// 所以这里没有 sha256 与发布签名：校验值在清单里（electron-builder 打包时算的 sha512），
// 客户端下载完自己比对。真正的「这个包是我们发的」要靠代码签名，那是打包机上的事。

// 平台通道。名字不是我们起的：electron-updater 按运行平台去取固定文件名的清单，
// mac 取 latest-mac.yml、windows 取 latest.yml、linux 取 latest-linux.yml。
const (
	DesktopChannelMac   = "mac"
	DesktopChannelWin   = "win"
	DesktopChannelLinux = "linux"
)

// 一行发版记录的状态。
//
// staging 是这套流程独有的：包太大，走「先登记拿签名地址 → 浏览器直传 → 再发布」两步，
// 中间这一步就停在 staging。它对客户端不可见 —— 清单只在 published 的行里挑。
const (
	DesktopStaging   = "staging"
	DesktopPublished = "published"
	DesktopWithdrawn = "withdrawn"
)

// DesktopReleaseFile 清单里的一个文件。运营列表用它显示「这一版要传哪几个包」。
type DesktopReleaseFile struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	// SHA512 是 electron-builder 算的 base64，客户端下载完比对的就是它。
	SHA512 string `json:"sha512"`
	// Uploaded 发布那一刻在对象存储上查到的结果。列表里不填。
	Uploaded bool `json:"uploaded,omitempty"`
}

// DesktopReleaseView 运营看到的一行。
type DesktopReleaseView struct {
	ReleaseID string `json:"releaseId"`
	Product   string `json:"product"`
	Channel   string `json:"channel"`
	Version   string `json:"version"`
	// ManifestFile 这个通道的清单文件名，客户端按平台取的就是它。
	ManifestFile string               `json:"manifestFile"`
	Files        []DesktopReleaseFile `json:"files"`
	Size         int64                `json:"size"`
	Notes        string               `json:"notes"`
	Status       string               `json:"status"`
	// Current 这一条就是客户端现在会更新到的那一版（同端同通道里版本最高的在架行）。
	// 由服务端算，不让两个前端各算一遍 —— 算法差一点，页面上说的和机器实际装的就不是一回事。
	Current     bool       `json:"current"`
	PublishedBy string     `json:"publishedBy"`
	PublishedAt *time.Time `json:"publishedAt,omitempty"`
	CreatedAt   time.Time  `json:"createdAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
}

// DesktopReleasePage 管理端那一页要的全部东西。
type DesktopReleasePage struct {
	Releases []DesktopReleaseView `json:"releases"`
	// ObjectRoot 清单与安装包在对象存储上的目录（**含部署配置的 dirPrefix**）。
	// 运营要拿它拼出两个端 runtime.json 里的 GALAXY_UPDATE_FEED_URL，所以由服务端给：
	// 前端自己拼就会漏掉 dirPrefix 那一段，而漏掉之后客户端取清单是 404。
	ObjectRoot string `json:"objectRoot"`
	// Products / Channels 页面上的固定顺序与可选项，服务端给一份，免得两处各写一张表。
	Products []string `json:"products"`
	Channels []string `json:"channels"`
}

// PrepareDesktopReleaseRequest 第一步：把 electron-builder 出的清单交上来，换回几个直传地址。
type PrepareDesktopReleaseRequest struct {
	// Product nova / orbit。
	Product string `json:"product" binding:"required"`
	// FileName 清单文件名，必须是 latest-mac.yml / latest.yml / latest-linux.yml 之一。
	// 通道从它来，不另设字段 —— 两处各填一遍迟早会不一致。
	FileName string `json:"fileName" binding:"required"`
	// Manifest 清单原文（release/<端>/ 下那个 latest-*.yml）。版本、文件名、大小、
	// sha512 全部从它解析：那些值是打包时算出来的，让人再填一遍只会填错。
	Manifest string `json:"manifest" binding:"required"`
	// Notes 版本说明。会写进清单的 releaseNotes，客户端的更新提示里原样展示。
	Notes    string `json:"notes"`
	Operator string `json:"-"`
}

// DesktopReleaseUploadTarget 一个要传的文件，和它的直传地址。
type DesktopReleaseUploadTarget struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	// ContentType 上传时必须原样带上：它参与签名，对不上 OSS 直接拒。
	ContentType string `json:"contentType"`
	// URL 短期有效的 PUT 直传地址。服务端不经手字节。
	URL string `json:"url"`
}

// DesktopReleaseUpload 第一步的返回：登记好的这一版，加上要传的几个文件。
type DesktopReleaseUpload struct {
	ReleaseID string                       `json:"releaseId"`
	Product   string                       `json:"product"`
	Channel   string                       `json:"channel"`
	Version   string                       `json:"version"`
	Uploads   []DesktopReleaseUploadTarget `json:"uploads"`
	ExpiresAt time.Time                    `json:"expiresAt"`
}

// PublishDesktopReleaseRequest 第二步：文件都传完了，把清单写到 OSS 上去。
type PublishDesktopReleaseRequest struct {
	ReleaseID string `json:"releaseId" binding:"required"`
	Operator  string `json:"-"`
}

type SetDesktopReleaseStatusRequest struct {
	ReleaseID string `json:"releaseId" binding:"required"`
	Status    string `json:"status" binding:"required"`
	Operator  string `json:"-"`
}
