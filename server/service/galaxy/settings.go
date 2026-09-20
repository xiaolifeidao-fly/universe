package galaxy

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 运行参数：把原本只在 application.properties 里的那批可调值搬进后台。
//
// 为什么不是「读配置文件」那条路：改一个起提金额要登服务器、改文件、重启进程，
// 而重启期间在跑的请求全断。这批值是**运营策略**，不是部署事实 ——
// 部署事实（本机地址、加密密钥、对外域名）留在配置文件里，那些改了本来就要重新部署。
//
// 生效方式是**进程内快照 + 定期回查**，不是重启：
//
//   - 读路径（cfg）只做一次原子读，永远不碰数据库 —— 派单、等待、签名这些
//     每个请求都要看的值，不能因为「运营可能改过」而多一次查询。
//   - 快照过期之后由**一个**协程去回查，其余调用方继续用旧值。改完最多
//     settingsTTL 生效，界面上把这句话直接写给运营看。
//   - 跨进程不靠广播：galaxy-api、hub、consumer-api 各自回查同一张表。
//     广播要多一条 Redis 通道和一套重连逻辑，而这批值没有一个是「晚十几秒
//     就会出事」的。
//
// 配置文件那份是**默认值**，不是被取代：某一项没在后台设过，就用配置文件的；
// 后台点「改回默认」删掉那一行，它立刻退回去。所以两边永远是叠加关系，
// 不存在「后台一开，配置文件就全废了」那种断崖。

// settingsTTL 快照多久回查一次。十五秒：运营改完刷一下页面就该看到新值生效，
// 而每个进程每分钟四次单行查询对一张几十行的表毫无压力。
const settingsTTL = 15 * time.Second

// 两个客户端安装包下载地址的键名。
//
// 单独拎出来是因为它们有**表外的用途**：管理端的「ai-bridge 版本」页把这两个值
// 摆在自己的卡片上，保存时按键名提交回 /settings/save。其余参数只被那张通用的
// 参数表按 settingSpecs 循环用到，键名留在字面量里就够了。
const (
	SettingClientProviderDownloadURL = "client.provider_download_url"
	SettingClientConsumerDownloadURL = "client.consumer_download_url"
)

// SettingKind 一项参数的类型，决定怎么解析、怎么校验、界面上怎么填。
type SettingKind string

const (
	// SettingInt 整数。
	SettingInt SettingKind = "int"
	// SettingFloat 小数。
	SettingFloat SettingKind = "float"
	// SettingDurationMs 时长，库里存**毫秒**。界面按秒或分展示由 Unit 决定。
	SettingDurationMs SettingKind = "duration"
	// SettingText 自由文本。
	SettingText SettingKind = "text"
)

// SettingSpec 一项可调参数的定义。
//
// 这张表是**唯一的真相**：接口按它校验、界面按它渲染、回查按它把值写进 Config。
// 加一项参数只改这里，不用在三处各写一遍。
type SettingSpec struct {
	Key string
	// Group 界面上的分组。
	Group string
	// Kind 决定解析与校验。
	Kind SettingKind
	// Min / Max 允许范围。两个都是 0 表示不限。
	//
	// 范围不是装饰：这批值里有好几个填错一位数就会让池子停摆 ——
	// max_wait 填成 3 毫秒，每一个请求都会在排到之前就超时。
	Min, Max float64
	// Unit 界面上的单位提示（秒 / 天 / 次…）。
	Unit string
	// apply 把解析好的值写进 Config。
	apply func(config *Config, raw string) error
	// read 从 Config 里读出当前值，序列化成库里存的那种字符串。
	read func(config Config) string
}

// settingSpecs 全部可调参数。
//
// **没有列进来的就是不可调的**，而且理由各不相同：
//
//   - galaxy.instance / consumer_base_url / provider_hub_url / bridge_download_base_url
//     / referral_register_url：部署地址。改它们意味着这套部署换了位置，本来就要重新部署。
//   - galaxy.key_cipher_secret / bridge_release.public_keys：密钥材料。
//     一个能在后台改加密密钥的开关，等于把所有密文的钥匙挂在后台登录页后面。
//   - galaxy.contract_version：编译期契约，节点按它握手。
//   - galaxy.heartbeat_timeout_ms：判「在线 / 离线」的那条线。
//   - galaxy.payout_rate：它不是策略，是**量纲定义**（多少微积分等于一块钱）。
//     改它会让库里已经存着的每一个余额换一个含义，而界面上按 1,000,000 显示的
//     那些数不会跟着变。
var settingSpecs = []SettingSpec{
	// ---------- 派单与等待 ----------
	{
		Key: "platform.seat_limit", Group: "placement", Kind: SettingInt, Min: 1, Max: 10000, Unit: "seat",
		apply: applyInt(func(c *Config, v int64) { c.PlatformSeatLimit = int(v) }),
		read:  func(c Config) string { return strconv.Itoa(c.PlatformSeatLimit) },
	},
	{
		Key: "placement.max_wait_ms", Group: "placement", Kind: SettingDurationMs, Min: 1000, Max: 600000, Unit: "second",
		apply: applyDuration(func(c *Config, v time.Duration) { c.MaxWait = v }),
		read:  readDuration(func(c Config) time.Duration { return c.MaxWait }),
	},
	{
		Key: "placement.spill_wait_ms", Group: "placement", Kind: SettingDurationMs, Min: 0, Max: 120000, Unit: "second",
		apply: applyDuration(func(c *Config, v time.Duration) { c.SpillWait = v }),
		read:  readDuration(func(c Config) time.Duration { return c.SpillWait }),
	},
	{
		Key: "placement.bind_idle_ttl_ms", Group: "placement", Kind: SettingDurationMs, Min: 1000, Max: 86400000, Unit: "minute",
		apply: applyDuration(func(c *Config, v time.Duration) { c.BindIdleTTL = v }),
		read:  readDuration(func(c Config) time.Duration { return c.BindIdleTTL }),
	},
	{
		Key: "placement.affinity_ttl_ms", Group: "placement", Kind: SettingDurationMs, Min: 1000, Max: 86400000, Unit: "minute",
		apply: applyDuration(func(c *Config, v time.Duration) { c.AffinityTTL = v }),
		read:  readDuration(func(c Config) time.Duration { return c.AffinityTTL }),
	},
	{
		Key: "placement.max_attempts", Group: "placement", Kind: SettingInt, Min: 1, Max: 20, Unit: "time",
		apply: applyInt(func(c *Config, v int64) { c.MaxPlaceAttempts = int(v) }),
		read:  func(c Config) string { return strconv.Itoa(c.MaxPlaceAttempts) },
	},
	{
		Key: "placement.body_ttl_ms", Group: "placement", Kind: SettingDurationMs, Min: 60000, Max: 604800000, Unit: "hour",
		apply: applyDuration(func(c *Config, v time.Duration) { c.BodyTTL = v }),
		read:  readDuration(func(c Config) time.Duration { return c.BodyTTL }),
	},
	{
		Key: "session.idle_ttl_ms", Group: "placement", Kind: SettingDurationMs, Min: 60000, Max: 86400000, Unit: "minute",
		apply: applyDuration(func(c *Config, v time.Duration) { c.SessionIdleTTL = v }),
		read:  readDuration(func(c Config) time.Duration { return c.SessionIdleTTL }),
	},

	// ---------- 打分权重 ----------
	// 六个权重决定一个请求落到哪条贡献上。它们只在彼此之间比较，所以是相对值，
	// 不是百分比 —— 全乘以二和全不动是同一个结果。
	{
		Key: "score.free_seats", Group: "score", Kind: SettingFloat, Min: 0, Max: 100,
		apply: applyFloat(func(c *Config, v float64) { c.Weights.FreeSeats = v }),
		read:  readFloat(func(c Config) float64 { return c.Weights.FreeSeats }),
	},
	{
		Key: "score.quota_floor", Group: "score", Kind: SettingFloat, Min: 0, Max: 100,
		apply: applyFloat(func(c *Config, v float64) { c.Weights.QuotaFloor = v }),
		read:  readFloat(func(c Config) float64 { return c.Weights.QuotaFloor }),
	},
	{
		Key: "score.idle", Group: "score", Kind: SettingFloat, Min: 0, Max: 100,
		apply: applyFloat(func(c *Config, v float64) { c.Weights.Idle = v }),
		read:  readFloat(func(c Config) float64 { return c.Weights.Idle }),
	},
	{
		Key: "score.latency", Group: "score", Kind: SettingFloat, Min: 0, Max: 100,
		apply: applyFloat(func(c *Config, v float64) { c.Weights.Latency = v }),
		read:  readFloat(func(c Config) float64 { return c.Weights.Latency }),
	},
	{
		Key: "score.reputation", Group: "score", Kind: SettingFloat, Min: 0, Max: 100,
		apply: applyFloat(func(c *Config, v float64) { c.Weights.Reputation = v }),
		read:  readFloat(func(c Config) float64 { return c.Weights.Reputation }),
	},
	{
		Key: "score.locality", Group: "score", Kind: SettingFloat, Min: 0, Max: 100,
		apply: applyFloat(func(c *Config, v float64) { c.Weights.Locality = v }),
		read:  readFloat(func(c Config) float64 { return c.Weights.Locality }),
	},

	// ---------- 密钥默认值 ----------
	// 只影响**之后**签发的密钥。已经发出去的那些带着自己签发时的参数，不会跟着变。
	{
		Key: "key.ttl_ms", Group: "key", Kind: SettingDurationMs, Min: 3600000, Max: 315360000000, Unit: "day",
		apply: applyDuration(func(c *Config, v time.Duration) { c.KeyTTL = v }),
		read:  readDuration(func(c Config) time.Duration { return c.KeyTTL }),
	},
	{
		Key: "key.freeze_ms", Group: "key", Kind: SettingDurationMs, Min: 0, Max: 31536000000, Unit: "day",
		apply: applyDuration(func(c *Config, v time.Duration) { c.KeyFreeze = v }),
		read:  readDuration(func(c Config) time.Duration { return c.KeyFreeze }),
	},
	{
		Key: "key.concurrency", Group: "key", Kind: SettingInt, Min: 1, Max: 1000,
		apply: applyInt(func(c *Config, v int64) { c.KeyConcurrency = int(v) }),
		read:  func(c Config) string { return strconv.Itoa(c.KeyConcurrency) },
	},
	{
		Key: "key.rpm", Group: "key", Kind: SettingInt, Min: 1, Max: 100000,
		apply: applyInt(func(c *Config, v int64) { c.KeyRPM = int(v) }),
		read:  func(c Config) string { return strconv.Itoa(c.KeyRPM) },
	},

	// ---------- 产物 ----------
	{
		Key: "artifact.presign_put_ttl_ms", Group: "artifact", Kind: SettingDurationMs, Min: 60000, Max: 86400000, Unit: "minute",
		apply: applyDuration(func(c *Config, v time.Duration) { c.PresignPutTTL = v }),
		read:  readDuration(func(c Config) time.Duration { return c.PresignPutTTL }),
	},
	{
		Key: "artifact.presign_get_ttl_ms", Group: "artifact", Kind: SettingDurationMs, Min: 60000, Max: 86400000, Unit: "minute",
		apply: applyDuration(func(c *Config, v time.Duration) { c.PresignGetTTL = v }),
		read:  readDuration(func(c Config) time.Duration { return c.PresignGetTTL }),
	},

	// ---------- 风控 ----------
	{
		Key: "audit.usage_mismatch_ratio", Group: "risk", Kind: SettingFloat, Min: 0.01, Max: 1, Unit: "ratio",
		apply: applyFloat(func(c *Config, v float64) { c.UsageMismatchRatio = v }),
		read:  readFloat(func(c Config) float64 { return c.UsageMismatchRatio }),
	},
	{
		Key: "reputation.recovery_per_day", Group: "risk", Kind: SettingFloat, Min: 0.001, Max: 1, Unit: "ratio",
		apply: applyFloat(func(c *Config, v float64) { c.ReputationRecoveryPerDay = v }),
		read:  readFloat(func(c Config) float64 { return c.ReputationRecoveryPerDay }),
	},

	// ---------- 提现 ----------
	{
		Key: "payout.min_credits", Group: "payout", Kind: SettingInt, Min: 0, Max: 100000000000, Unit: "credit",
		apply: applyInt(func(c *Config, v int64) { c.PayoutMinCredits = v }),
		read:  func(c Config) string { return strconv.FormatInt(c.PayoutMinCredits, 10) },
	},
	{
		Key: "payout.hold_days", Group: "payout", Kind: SettingInt, Min: 0, Max: 365, Unit: "day",
		apply: applyInt(func(c *Config, v int64) { c.PayoutHoldDays = int(v) }),
		read:  func(c Config) string { return strconv.Itoa(c.PayoutHoldDays) },
	},

	// ---------- 邀请返现 ----------
	{
		Key: settingReferralDefaultBps, Group: "referral", Kind: SettingInt, Min: 0, Max: maxReferralBps, Unit: "bps",
		apply: applyInt(func(c *Config, v int64) { c.ConsumerReferralBps = v }),
		read:  func(c Config) string { return strconv.FormatInt(c.ConsumerReferralBps, 10) },
	},
	{
		Key: "referral.rate", Group: "referral", Kind: SettingFloat, Min: 0, Max: 1, Unit: "ratio",
		apply: applyFloat(func(c *Config, v float64) { c.ReferralRate = v }),
		read:  readFloat(func(c Config) float64 { return c.ReferralRate }),
	},
	{
		Key: "referral.days", Group: "referral", Kind: SettingInt, Min: 0, Max: 3650, Unit: "day",
		apply: applyInt(func(c *Config, v int64) { c.ReferralDays = int(v) }),
		read:  func(c Config) string { return strconv.Itoa(c.ReferralDays) },
	},

	// ---------- 客户端安装包 ----------
	//
	// 两个桌面客户端的下载地址。它们**看着像部署地址，但不是**：
	// 没有任何流量走它们，填错的代价只是某一页上多一条坏链接；而它们变动的理由
	// （换个桶放安装包、前面挂上 CDN、改成指一个列各系统安装包的下载页）和这套部署
	// 挪没挪位置完全无关。让运营为了换一条链接去登服务器改文件、重启进程，代价和收益不成比例。
	//
	// 更硬的一条理由是管理端要展示它们：manager-api 和 galaxy-consumer-api 是两个进程、
	// 两份 application.properties，留在配置文件里就得两边各配一遍还得人工保持一致 ——
	// 一处真相被拆成两处，迟早对不上。落到这张表上，两个进程读的是同一行。
	//
	// 空值的含义是「这一块不显示」，所以清空要走「改回默认」（删掉那一行），
	// 而不是保存一个空字符串 —— SaveAdminSetting 那里本来也不收空值。
	{
		Key: SettingClientProviderDownloadURL, Group: "client", Kind: SettingText,
		apply: applyURL(func(c *Config, v string) { c.ProviderClientDownloadURL = v }),
		read:  func(c Config) string { return c.ProviderClientDownloadURL },
	},
	{
		Key: SettingClientConsumerDownloadURL, Group: "client", Kind: SettingText,
		apply: applyURL(func(c *Config, v string) { c.ConsumerClientDownloadURL = v }),
		read:  func(c Config) string { return c.ConsumerClientDownloadURL },
	},

	// ---------- 合规与门户 ----------
	// 版本号一改，旧的同意记录**全部失效**：提供者下次 hello 会被要求重新同意，
	// 使用者签不出新密钥。这是有意的（条款变了就该重新征得同意），
	// 但它不是一个能随手点的开关，界面上要单独警告。
	{
		Key: "terms.provider_version", Group: "compliance", Kind: SettingText,
		apply: applyText(func(c *Config, v string) { c.ProviderTermsVersion = v }),
		read:  func(c Config) string { return c.ProviderTermsVersion },
	},
	{
		Key: "notice.consumer_version", Group: "compliance", Kind: SettingText,
		apply: applyText(func(c *Config, v string) { c.ConsumerNoticeVersion = v }),
		read:  func(c Config) string { return c.ConsumerNoticeVersion },
	},
	{
		Key: "portal.availability", Group: "compliance", Kind: SettingText,
		apply: applyText(func(c *Config, v string) { c.PortalAvailability = v }),
		read:  func(c Config) string { return c.PortalAvailability },
	},
}

var settingSpecByKey = func() map[string]SettingSpec {
	byKey := make(map[string]SettingSpec, len(settingSpecs))
	for _, spec := range settingSpecs {
		byKey[spec.Key] = spec
	}
	return byKey
}()

// ---------- 解析与序列化 ----------

func applyInt(set func(*Config, int64)) func(*Config, string) error {
	return func(config *Config, raw string) error {
		value, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
		if err != nil {
			return fmt.Errorf("要填一个整数，收到 %q", raw)
		}
		set(config, value)
		return nil
	}
}

func applyFloat(set func(*Config, float64)) func(*Config, string) error {
	return func(config *Config, raw string) error {
		value, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
		if err != nil {
			return fmt.Errorf("要填一个数，收到 %q", raw)
		}
		set(config, value)
		return nil
	}
}

// applyDuration 库里存毫秒。存成 "3s" 这种带单位的字符串看着友好，
// 但校验范围、界面换算、SQL 里比大小全都要先解析一遍字符串。
func applyDuration(set func(*Config, time.Duration)) func(*Config, string) error {
	return func(config *Config, raw string) error {
		value, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
		if err != nil {
			return fmt.Errorf("要填一个毫秒数，收到 %q", raw)
		}
		set(config, time.Duration(value)*time.Millisecond)
		return nil
	}
}

func applyText(set func(*Config, string)) func(*Config, string) error {
	return func(config *Config, raw string) error {
		set(config, strings.TrimSpace(raw))
		return nil
	}
}

// applyURL 一条要摆到界面上、给人点开的地址。
//
// 校验严格到「有 scheme 有 host」为止，不再往下猜：这里拦的是把安装包的文件名、
// 内网路径或者一句说明填进来这种当场就看得出的错。真正的死链只有点开才知道，
// 而那不是一个正则能替运营验的事。
//
// 只认 http/https：这个值会原样进 <a href>，javascript: 和 data: 就是一条
// 从后台输入框通到浏览器的路。校验放在 apply 里，validateSetting 对文本型
// 只调 apply —— 保存接口和进程回查（loadSettings）因此走的是同一道校验，
// 手工改库改出来的非法值会在回查时被跳过，而不是被摆到页面上。
func applyURL(set func(*Config, string)) func(*Config, string) error {
	return func(config *Config, raw string) error {
		value := strings.TrimSpace(raw)
		if value != "" {
			parsed, err := url.Parse(value)
			if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
				return fmt.Errorf("要填一个 http(s) 开头的完整地址，收到 %q", raw)
			}
		}
		set(config, value)
		return nil
	}
}

func readDuration(get func(Config) time.Duration) func(Config) string {
	return func(config Config) string { return strconv.FormatInt(get(config).Milliseconds(), 10) }
}

func readFloat(get func(Config) float64) func(Config) string {
	return func(config Config) string { return strconv.FormatFloat(get(config), 'f', -1, 64) }
}

// numericValue 把一项的字符串值读成数字，供范围校验用。文本型返回 false。
func numericValue(kind SettingKind, raw string) (float64, bool) {
	if kind == SettingText {
		return 0, false
	}
	value, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil {
		return 0, false
	}
	return value, true
}

// validateSetting 一项值是否可用。范围不是装饰 —— 这批值里有好几个填错一位数
// 就会让池子停摆（max_wait 填成 3 毫秒，每个请求都会在排到之前就超时）。
func validateSetting(spec SettingSpec, raw string) error {
	probe := Config{}
	if err := spec.apply(&probe, raw); err != nil {
		return err
	}
	if spec.Kind == SettingText {
		return nil
	}
	value, ok := numericValue(spec.Kind, raw)
	if !ok {
		return fmt.Errorf("解析不出数值：%q", raw)
	}
	if spec.Min != 0 || spec.Max != 0 {
		if value < spec.Min || value > spec.Max {
			return fmt.Errorf("要在 %s 到 %s 之间，收到 %s",
				strconv.FormatFloat(spec.Min, 'f', -1, 64),
				strconv.FormatFloat(spec.Max, 'f', -1, 64),
				strings.TrimSpace(raw))
		}
	}
	return nil
}

// ---------- 进程内快照 ----------

// settingsCache 叠加了后台设置之后的那份 Config，以及它是什么时候读出来的。
type settingsCache struct {
	// value 读路径只做一次原子读。永远不在这里碰数据库 ——
	// 派单、等待、签名这些每个请求都要看的值，不能因为「运营可能改过」多一次查询。
	value atomic.Pointer[Config]
	// loadedAt 上次回查完成的时刻（UnixNano）。
	loadedAt atomic.Int64
	// refreshing 同一时刻只让一个协程去回查，其余的继续用旧值。
	// 没有它的话，快照一过期，那一瞬间的每个请求都会各开一个协程去查同一张表。
	refreshing atomic.Bool
	// once 第一次读**同步**加载：刚起来的进程如果先返回配置文件那份，
	// 头十五秒会按一套运营早就改过的参数跑，而日志里什么都看不出来。
	once sync.Once
}

// cfg 当前生效的参数。
//
// 这是**唯一**该读配置的地方 —— 代码里不要再直接碰 s.config，
// 那一份是配置文件给的默认值，后台改过的项不在里面。
func (s *service) cfg() Config {
	// settings 为 nil 的只有直接拼出来的 service 字面量（测试里那些只验入参校验的）。
	// 它们没有仓储可查，退回配置文件那份就是对的 —— 而不是在这里空指针。
	if s.settings == nil || s.repository == nil {
		return s.config
	}
	s.settings.once.Do(func() {
		// 第一次同步读一次。失败就先用配置文件那份，下一次过期时再试 ——
		// 数据库这会儿不通是个更大的问题，不该让它把服务卡在启动上。
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if merged, err := s.loadSettings(ctx); err == nil {
			s.settings.value.Store(&merged)
			s.settings.loadedAt.Store(time.Now().UnixNano())
		}
	})
	current := s.settings.value.Load()
	if current == nil {
		return s.config
	}
	if time.Since(time.Unix(0, s.settings.loadedAt.Load())) > settingsTTL &&
		s.settings.refreshing.CompareAndSwap(false, true) {
		go s.refreshSettings()
	}
	return *current
}

func (s *service) refreshSettings() {
	defer s.settings.refreshing.Store(false)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	merged, err := s.loadSettings(ctx)
	if err != nil {
		// 读不到就继续用旧快照。把 loadedAt 往前推一点，避免每次 cfg 都去重试。
		s.settings.loadedAt.Store(time.Now().Add(-settingsTTL / 2).UnixNano())
		return
	}
	s.settings.value.Store(&merged)
	s.settings.loadedAt.Store(time.Now().UnixNano())
}

// loadSettings 把库里那几行叠到配置文件那份上。
//
// 认不出来的 key 直接跳过，不报错：降级部署时新版本写进去的键会被老版本读到，
// 为一个它还不认识的开关整份配置读失败，等于让一次灰度把老实例全打成默认参数。
func (s *service) loadSettings(ctx context.Context) (Config, error) {
	merged := s.config
	rows, err := s.repository.ListSettings(ctx, bizLine)
	if err != nil {
		return merged, err
	}
	for _, row := range rows {
		spec, known := settingSpecByKey[row.SettingKey]
		if !known {
			continue
		}
		if err := validateSetting(spec, row.Value); err != nil {
			// 库里存着一个非法值：跳过它、用默认值，而不是让整份配置失效。
			continue
		}
		_ = spec.apply(&merged, row.Value)
	}
	return merged.withDefaults(), nil
}

// invalidateSettings 让本进程的快照立刻失效。
//
// 只影响**这一个**进程（运营点保存的那个 manager-api）。其余进程按 TTL 自己回查 ——
// 所以界面上要明说「最多 N 秒后全部生效」，而不是让运营以为点完就到处都变了。
func (s *service) invalidateSettings() {
	s.settings.loadedAt.Store(0)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if merged, err := s.loadSettings(ctx); err == nil {
		s.settings.value.Store(&merged)
		s.settings.loadedAt.Store(time.Now().UnixNano())
	}
}

// SettingsPropagationSeconds 后台改完最多多少秒在全部进程上生效。界面原样显示。
func SettingsPropagationSeconds() int { return int(settingsTTL / time.Second) }

// ---------- 运营接口 ----------

// sortedSpecs 按分组、再按键名排好的参数定义。界面按这个顺序画。
func sortedSpecs() []SettingSpec {
	specs := append([]SettingSpec{}, settingSpecs...)
	order := map[string]int{
		"placement": 1, "score": 2, "key": 3, "artifact": 4,
		"risk": 5, "payout": 6, "referral": 7, "compliance": 8, "client": 9,
	}
	sort.SliceStable(specs, func(i, j int) bool {
		if order[specs[i].Group] != order[specs[j].Group] {
			return order[specs[i].Group] < order[specs[j].Group]
		}
		return specs[i].Key < specs[j].Key
	})
	return specs
}

// lookupSpec 按键名取定义。
func lookupSpec(key string) (SettingSpec, error) {
	spec, known := settingSpecByKey[strings.TrimSpace(key)]
	if !known {
		return SettingSpec{}, errors.New("这一项不是可调参数：" + key)
	}
	return spec, nil
}

// AdminSettings 全部可调参数此刻的样子：生效值、默认值、改没改过。
func (s *service) AdminSettings(ctx context.Context) (dto.AdminSettingsPage, error) {
	rows, err := s.repository.ListSettings(ctx, bizLine)
	if err != nil {
		return dto.AdminSettingsPage{}, err
	}
	stored := make(map[string]*repository.GalaxySetting, len(rows))
	for _, row := range rows {
		stored[row.SettingKey] = row
	}

	// 两份都要：defaults 是配置文件那份（「改回默认」退回它），current 是叠加之后的。
	// 只回其中一份的话，界面上没法回答「这个数是我改的，还是它本来就这样」。
	defaults := s.config.withDefaults()
	current := s.cfg()

	page := dto.AdminSettingsPage{
		PropagationSeconds: SettingsPropagationSeconds(),
		Settings:           make([]dto.SettingView, 0, len(settingSpecs)),
	}
	for _, spec := range sortedSpecs() {
		view := dto.SettingView{
			Key: spec.Key, Group: spec.Group, Kind: string(spec.Kind), Unit: spec.Unit,
			Min: spec.Min, Max: spec.Max,
			Value: spec.read(current), Default: spec.read(defaults),
		}
		if row, ok := stored[spec.Key]; ok {
			view.Overridden = true
			view.UpdatedBy = row.UpdatedBy
			updatedAt := row.UpdatedTime
			view.UpdatedAt = &updatedAt
		}
		page.Settings = append(page.Settings, view)
	}
	return page, nil
}

// SaveAdminSetting 改一项运行参数，或者把它改回默认。
//
// 保存完立刻让本进程的快照失效 —— 运营点完保存，这一页刷新出来就该是新值。
// 其余进程按 TTL 自己回查，界面上把这个秒数原样显示给运营看。
func (s *service) SaveAdminSetting(ctx context.Context, req dto.SaveSettingRequest) error {
	spec, err := lookupSpec(req.Key)
	if err != nil {
		return err
	}
	defer s.invalidateSettings()

	if req.Reset {
		// 「改回默认」是**删掉那一行**，不是写一个默认值进去：默认值来自配置文件，
		// 各环境不一样，而且它会随版本变。写死一个数进去，下次版本改了默认值，
		// 这一项会以「运营设过」的身份把新默认挡在外面。
		return s.repository.DeleteSetting(ctx, bizLine, spec.Key)
	}
	value := strings.TrimSpace(req.Value)
	if value == "" {
		return errors.New("要填一个值；想退回默认请用「改回默认」")
	}
	if err := validateSetting(spec, value); err != nil {
		return fmt.Errorf("%s：%w", spec.Key, err)
	}
	return s.repository.SaveSetting(ctx, &repository.GalaxySetting{
		BizLine: bizLine, SettingKey: spec.Key,
		Value: value, UpdatedBy: truncate(req.UpdatedBy, 64),
	})
}
