package bootstrap

import (
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"common/middleware/httpx"
	"service/galaxy"
)

// LoadConfig 把默认参数表（设计文档第 15 节）接到 application.properties 上。
// 没配的项一律走默认值，部署方只需要覆盖真正想改的那几个。
func LoadConfig() galaxy.Config {
	config := galaxy.DefaultConfig()
	config.Instance = InstanceAddress()
	config.ContractVersion = IntProperty("galaxy.contract_version", config.ContractVersion)
	config.PlatformSeatLimit = IntProperty("galaxy.platform_seat_limit", config.PlatformSeatLimit)
	config.BindIdleTTL = DurationProperty("galaxy.bind_idle_ttl_ms", int(config.BindIdleTTL.Milliseconds()))
	config.AffinityTTL = DurationProperty("galaxy.affinity_ttl_ms", int(config.AffinityTTL.Milliseconds()))
	config.SpillWait = DurationProperty("galaxy.spill_wait_ms", int(config.SpillWait.Milliseconds()))
	config.MaxWait = DurationProperty("galaxy.max_wait_ms", int(config.MaxWait.Milliseconds()))
	config.HeartbeatTimeout = DurationProperty("galaxy.heartbeat_timeout_ms", int(config.HeartbeatTimeout.Milliseconds()))
	config.KeyTTL = time.Duration(IntProperty("galaxy.key_ttl_days", 30)) * 24 * time.Hour
	// 密钥明文加密存储用的密钥。manager-api 取回明文时要用同一个值，没配就只是取不回。
	config.KeyCipherSecret = strings.TrimSpace(httpx.Property("galaxy.key_cipher_secret"))
	if config.KeyCipherSecret == "" {
		log.Print("galaxy.key_cipher_secret 未配置：新签发的算力密钥取不回明文，「使用」按钮与运营转交都不可用")
	}
	config.KeyFreeze = time.Duration(IntProperty("galaxy.key_freeze_days", 30)) * 24 * time.Hour
	config.ProviderTermsVersion = DefaultString(httpx.Property("galaxy.provider_terms_version"), config.ProviderTermsVersion)
	config.ConsumerNoticeVersion = DefaultString(httpx.Property("galaxy.consumer_notice_version"), config.ConsumerNoticeVersion)
	// 不配就由 withDefaults 从 galaxy.instance 派生成 <instance>/v1。
	config.ConsumerBaseURL = strings.TrimSpace(httpx.Property("galaxy.consumer_base_url"))
	// 节点侧的对外地址。不配就由 withDefaults 从 consumer_base_url 去掉 /v1 派生。
	config.ProviderHubURL = strings.TrimSpace(httpx.Property("galaxy.provider_hub_url"))
	// 使用端桌面客户端的下载地址。只有使用端控制台用得上，不配就是那一块不显示 ——
	// 安装包托管在哪儿派生不出来。
	//
	// 配置文件里只有**通用那条**（一个列出各系统安装包的下载页）。分平台的三条
	// （Windows / mac Intel / mac Apple 芯片）只在后台改：它们跟着发版走，
	// 一版一换，而配置文件改一次要重新部署一次。
	config.ConsumerClientDownload.Default = strings.TrimSpace(httpx.Property("galaxy.consumer_client_download_url"))
	config.SessionIdleTTL = time.Duration(IntProperty("galaxy.session_idle_hours", 24)) * time.Hour
	config.PayoutRate = IntProperty("galaxy.payout_rate", config.PayoutRate)
	config.PayoutMinCredits = int64(IntProperty("galaxy.payout_min_credits", int(config.PayoutMinCredits)))
	config.PayoutHoldDays = IntProperty("galaxy.payout_hold_days", config.PayoutHoldDays)
	if raw := strings.TrimSpace(httpx.Property("galaxy.reputation_recovery_per_day")); raw != "" {
		if value, err := strconv.ParseFloat(raw, 64); err == nil && value > 0 {
			config.ReputationRecoveryPerDay = value
		}
	}
	// 门户上那句可用性承诺。不配就是空串 —— 门户少显示一格，
	// 而不是替部署方许一个他没许的诺。
	config.PortalAvailability = strings.TrimSpace(httpx.Property("galaxy.portal.availability"))

	// ai-bridge 安装包的公开访问前缀。桶是公开读或者前面挂了 CDN 时配上，
	// 下载就不再逐次签名；不配走签名地址（下载那一跳当场签）。
	config.BridgeDownloadBaseURL = strings.TrimSpace(httpx.Property("galaxy.bridge_release.download_base_url"))

	// 共享端邀请返现。比例是 0~1 的小数，0 或不配表示这个活动没开；
	// 注册页地址不配就没有链接可分享（邀请页只显示邀请码）。
	if raw := strings.TrimSpace(httpx.Property("galaxy.referral.rate")); raw != "" {
		if value, err := strconv.ParseFloat(raw, 64); err == nil && value >= 0 {
			config.ReferralRate = value
		}
	}
	// 期限单独解析而不是走 IntProperty：那个函数把 0 当成「没配」，
	// 而这里的 0 有确切含义 —— 长期有效。
	if raw := strings.TrimSpace(httpx.Property("galaxy.referral.days")); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil && value >= 0 {
			config.ReferralDays = value
		}
	}
	config.ReferralRegisterURL = strings.TrimSpace(httpx.Property("galaxy.referral.register_url"))
	return config
}

// InstanceAddress Hub 这一台的专属地址（galaxy.instance）。
//
// 它是多实例部署里唯一必须逐台不同的值：派单时写进 req:{rid}.instance，
// 节点领活拿到的 streamURL 由它拼成，上行必须打回**这一个进程**。
// 为了不让三台机器因此各留一份只差一行的配置文件，这里多给两条注入途径：
//
//   - 环境变量 GALAXY_INSTANCE 优先于配置项，容器/编排直接注入即可；
//   - 值里的 {hostname} 换成本机主机名的短名（去掉域名部分）。
//
// 于是 galaxy.instance = https://hub.example.com/s/{hostname} 这一行可以三台照抄，
// 各自渲染成 /s/hub-1、/s/hub-2……前面的 nginx 按这一段精确转发到对应实例。
//
// 取不到主机名时**保留占位符原样**，不做任何兜底：一个打不通的地址会让节点立刻报错，
// 而悄悄换成一个能连上的错地址，只会让上行送到别的实例去等超时。
func InstanceAddress() string {
	value := strings.TrimSpace(os.Getenv("GALAXY_INSTANCE"))
	if value == "" {
		value = strings.TrimSpace(httpx.Property("galaxy.instance"))
	}
	if value == "" {
		return "http://127.0.0.1:10006"
	}
	if !strings.Contains(value, instanceHostnamePlaceholder) {
		return value
	}
	host, err := os.Hostname()
	if host = strings.TrimSpace(host); err != nil || host == "" {
		log.Printf("galaxy.instance 含 %s 但取不到主机名（%v）：节点将拿到一个打不通的 streamURL",
			instanceHostnamePlaceholder, err)
		return value
	}
	return strings.ReplaceAll(value, instanceHostnamePlaceholder, strings.SplitN(host, ".", 2)[0])
}

const instanceHostnamePlaceholder = "{hostname}"

// LoadAuditConfig 抽检参数。比例在 service 里再封一次 1% 上限 ——
// 那是对提供者的承诺，不该由一行配置就能改掉。
func LoadAuditConfig() galaxy.AuditConfig {
	config := galaxy.DefaultAuditConfig()
	if raw := strings.TrimSpace(httpx.Property("galaxy.audit.ratio")); raw != "" {
		if value, err := strconv.ParseFloat(raw, 64); err == nil && value >= 0 {
			config.Ratio = value
		}
	}
	config.DailyCap = IntProperty("galaxy.audit.daily_cap", config.DailyCap)
	return config
}

// TokenSecret Galaxy 账号令牌的签名密钥。
//
// 优先读 galaxy.auth.token_secret；没配就退回这个进程自己的 auth.token_secret，
// 老部署不改配置也能起来。两个名字读的都是 galaxy-api 自己的配置文件，
// 和 web-api 那边配的是不是同一个值，不影响令牌串不串用（见 service/galaxy/account/token.go）；
// 但各配各的仍然是该做的事，退回时在日志里提一句。
func TokenSecret() string {
	if secret := strings.TrimSpace(httpx.Property("galaxy.auth.token_secret")); secret != "" {
		return secret
	}
	secret := strings.TrimSpace(httpx.Property("auth.token_secret"))
	if secret != "" {
		log.Print("galaxy.auth.token_secret 未配置，Galaxy 账号令牌暂用 auth.token_secret 签名；建议单独配一个")
	} else {
		log.Print("galaxy.auth.token_secret 未配置，Galaxy 账号无法登录与注册")
	}
	return secret
}

func TokenTTL() time.Duration {
	seconds, _ := strconv.Atoi(DefaultString(httpx.Property("galaxy.auth.token_ttl_seconds"), httpx.Property("auth.token_ttl_seconds")))
	if seconds <= 0 {
		seconds = 604800
	}
	return time.Duration(seconds) * time.Second
}

func IntProperty(key string, fallback int) int {
	value, err := strconv.Atoi(strings.TrimSpace(httpx.Property(key)))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

// signedProperty 读一个**允许为负**的整数配置，没配或写不成数就返回 0。
//
// 不能用 IntProperty：它把 <= 0 一律当成「没配」。而登录失败上限那几个键要区分
// 三种情况 —— 没配（0，用领域层的默认值）、配了个正数（就用它）、配了负数
// （这一维不限制）。混起来的话，「关掉限制」这件事根本写不出来。
func signedProperty(key string) int {
	value, err := strconv.Atoi(strings.TrimSpace(httpx.Property(key)))
	if err != nil {
		return 0
	}
	return value
}

func DurationProperty(key string, fallbackMillis int) time.Duration {
	return time.Duration(IntProperty(key, fallbackMillis)) * time.Millisecond
}

func DefaultString(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}
