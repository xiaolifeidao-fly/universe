// Package bridge 是 ai-bridge 安装包的公开分发面：下载清单、下载跳转、校验值、安装脚本。
//
// **不鉴权**，这是想清楚之后的选择：要装它的那台机器此刻还没有任何身份（接入密钥要到
// register 那一步才用得上），而安装包本身不是秘密。真正的把关在别处 —— 包的完整性由
// sha256 与发布签名保证（节点装之前自己验），能不能加入池子由接入密钥决定。
//
// 响应和 agent 那组一样是裸 JSON / 纯文本，不套 httpx 的统一信封：这几个接口的调用方
// 是 curl、shell 脚本和节点自己，它们按 HTTP 状态码分支，不会去读 body 里的 success。
package bridge

import (
	_ "embed"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"contract"
	"service/galaxy"
)

// 安装脚本跟着二进制走，不从对象存储取：它是「怎么把平台的东西装到你机器上」的说明，
// 必须和这套服务端的接口版本一致。里面的 __HUB_URL__ 在下发时换成本部署的对外地址。
//
//go:embed install.sh
var installShell string

//go:embed install.ps1
var installPowerShell string

const hubPlaceholder = "__HUB_URL__"

type Handler struct {
	service galaxy.Service
}

func NewHandler(service galaxy.Service) *Handler {
	return &Handler{service: service}
}

// RegisterHandler 挂在 /agent/v1 下。
//
// 和节点通道同一个前缀，是因为它们用的是同一个平台地址（节点配置里的 pool.hubURL）：
// 分成两个前缀只会让部署方在反代上多配一条规则，而少配的那一条会在深夜的机房里
// 表现成「装不上」。
func (h *Handler) RegisterHandler(group *gin.RouterGroup) {
	api := group.Group("/bridge")
	api.GET("/releases/latest", h.latest)
	api.GET("/download/:platform", h.download)
	api.GET("/checksum/:platform", h.checksum)
	api.GET("/install.sh", h.shellScript)
	api.GET("/install.ps1", h.powerShellScript)
}

// latest 下载清单：每个平台最新的那一版。
func (h *Handler) latest(context *gin.Context) {
	manifest, err := h.service.BridgeManifest(context.Request.Context())
	if err != nil {
		fail(context, http.StatusInternalServerError, contract.ErrorClassHub, "internal_error", err.Error())
		return
	}
	context.JSON(http.StatusOK, manifest)
}

// download 302 到对象存储的地址。
//
// 这一跳存在的理由：对象地址是签出来的、会过期，而文档、脚本和控制台上的按钮
// 需要一个能写死的地址。带 ?version= 可以装指定版本（回滚时用得上）。
func (h *Handler) download(context *gin.Context) {
	url, err := h.service.BridgeDownloadURL(context.Request.Context(),
		context.Param("platform"), context.Query("version"))
	if err != nil {
		fail(context, http.StatusNotFound, contract.ErrorClassInput, "release_not_found", err.Error())
		return
	}
	// 302 而不是 301：签名地址每次都不一样，被缓存成永久重定向就麻烦了。
	context.Redirect(http.StatusFound, url)
}

// checksum sha256sum 的格式，安装脚本直接喂给 sha256sum -c。
func (h *Handler) checksum(context *gin.Context) {
	digest, fileName, err := h.service.BridgeChecksum(context.Request.Context(),
		context.Param("platform"), context.Query("version"))
	if err != nil {
		fail(context, http.StatusNotFound, contract.ErrorClassInput, "release_not_found", err.Error())
		return
	}
	context.String(http.StatusOK, "%s  %s\n", digest, fileName)
}

func (h *Handler) shellScript(context *gin.Context) {
	h.script(context, installShell, "text/x-shellscript; charset=utf-8")
}

func (h *Handler) powerShellScript(context *gin.Context) {
	h.script(context, installPowerShell, "text/plain; charset=utf-8")
}

// script 把脚本里的平台地址换成本部署的对外地址再发出去。
//
// 没配对外地址时直接拒绝，而不是发一个占位符出去：那样的脚本跑起来会去连
// 一个叫 __HUB_URL__ 的主机，报错和「平台没配好」一点关系都看不出来。
func (h *Handler) script(context *gin.Context, body, contentType string) {
	hub := strings.TrimRight(strings.TrimSpace(h.service.Config().ProviderHubURL), "/")
	if hub == "" {
		fail(context, http.StatusServiceUnavailable, contract.ErrorClassHub, "hub_url_missing",
			"平台没有配置对外地址（galaxy.provider_hub_url），安装脚本暂不可用")
		return
	}
	context.Header("Content-Type", contentType)
	context.String(http.StatusOK, strings.ReplaceAll(body, hubPlaceholder, hub))
}

func fail(context *gin.Context, status int, class contract.ErrorClass, code, message string) {
	context.AbortWithStatusJSON(status, gin.H{"class": class, "code": code, "message": message})
}
