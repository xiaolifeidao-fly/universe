package galaxy

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"contract"
)

// 单位化额度引擎。三维（token / 小时 / 次数）是 LLM kind 的默认单位组合，
// 引擎本身只认「任意计量单位集合」，视频类 kind 用自己的单位，同一套规则（三维额度规则第 9 条）。

const (
	// WindowDay 等四种窗口。窗口决定计数器的 key 后缀与过期时刻。
	WindowDay   = "day"
	WindowWeek  = "week"
	WindowMonth = "month"
	WindowTotal = "total"

	// QuotaWarnRatio 软阈值：到 80% 通知主人（P-10）。
	QuotaWarnRatio = 0.8
	// QuotaReserveRatio 保护线：任一维度剩余低于 5% 时不再接新绑定（三维额度规则第 5 条）。
	QuotaReserveRatio = 0.05
	// MinSessionSec 小时维度剩余低于它就不再接新绑定，避免刚绑上就断（第 6 条）。
	MinSessionSec = 900
)

// QuotaGrant 一条授权行。ResetAt 形如 "00:00+08:00"：归零时刻按提供者时区。
type QuotaGrant struct {
	Unit    contract.MeterUnit `json:"unit"`
	Limit   int64              `json:"limit"`
	Window  string             `json:"window"`
	ResetAt string             `json:"resetAt,omitempty"`
}

func (g QuotaGrant) normalizedWindow() string {
	switch strings.ToLower(strings.TrimSpace(g.Window)) {
	case WindowWeek:
		return WindowWeek
	case WindowMonth:
		return WindowMonth
	case WindowTotal:
		return WindowTotal
	default:
		return WindowDay
	}
}

// offset 解析 ResetAt 里的时区偏移与归零时刻。缺省是 UTC 的 00:00。
//
// 归零时刻不是「窗口内的一个时间点」而是窗口的起点：resetAt=04:00+08:00 表示
// 每天东八区 04:00 翻一次窗口，所以算窗口键时要先把时间往回推这段偏移。
func (g QuotaGrant) offset() time.Duration {
	value := strings.TrimSpace(g.ResetAt)
	if value == "" {
		return 0
	}
	var hour, minute int
	var zoneSign time.Duration = 1
	var zoneHour, zoneMinute int

	clock := value
	if index := strings.IndexAny(value, "+-"); index > 0 {
		clock = value[:index]
		zone := value[index:]
		if strings.HasPrefix(zone, "-") {
			zoneSign = -1
		}
		zone = zone[1:]
		parts := strings.SplitN(zone, ":", 2)
		zoneHour, _ = strconv.Atoi(parts[0])
		if len(parts) == 2 {
			zoneMinute, _ = strconv.Atoi(parts[1])
		}
	}
	if parts := strings.SplitN(clock, ":", 2); len(parts) == 2 {
		hour, _ = strconv.Atoi(parts[0])
		minute, _ = strconv.Atoi(parts[1])
	}
	zoneShift := zoneSign * (time.Duration(zoneHour)*time.Hour + time.Duration(zoneMinute)*time.Minute)
	resetShift := time.Duration(hour)*time.Hour + time.Duration(minute)*time.Minute
	// 本地墙钟 = UTC + zoneShift；窗口起点再往后挪 resetShift，
	// 所以「归属哪个窗口」等价于把 UTC 时间加上 zoneShift 再减 resetShift。
	return zoneShift - resetShift
}

// WindowKey 计算某一时刻落在哪个窗口。计数器 key 用它作后缀，窗口翻转就是换一把新计数器。
func (g QuotaGrant) WindowKey(now time.Time) string {
	window := g.normalizedWindow()
	if window == WindowTotal {
		return "all"
	}
	shifted := now.UTC().Add(g.offset())
	switch window {
	case WindowWeek:
		year, week := shifted.ISOWeek()
		return fmt.Sprintf("%04dW%02d", year, week)
	case WindowMonth:
		return shifted.Format("200601")
	default:
		return shifted.Format("20060102")
	}
}

// WindowStart 当前窗口的起始时刻（UTC）。有效座位数要用它算「已过多久」。
func (g QuotaGrant) WindowStart(now time.Time) time.Time {
	offset := g.offset()
	shifted := now.UTC().Add(offset)
	var start time.Time
	switch g.normalizedWindow() {
	case WindowTotal:
		// total 没有起点；退回一年前，让 burn 的分母不为 0 又不至于失真。
		return now.UTC().AddDate(-1, 0, 0)
	case WindowWeek:
		weekday := (int(shifted.Weekday()) + 6) % 7 // 周一为 0
		start = time.Date(shifted.Year(), shifted.Month(), shifted.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, -weekday)
	case WindowMonth:
		start = time.Date(shifted.Year(), shifted.Month(), 1, 0, 0, 0, 0, time.UTC)
	default:
		start = time.Date(shifted.Year(), shifted.Month(), shifted.Day(), 0, 0, 0, 0, time.UTC)
	}
	return start.Add(-offset)
}

// WindowEnd 当前窗口的结束时刻（UTC）。
func (g QuotaGrant) WindowEnd(now time.Time) time.Time {
	switch g.normalizedWindow() {
	case WindowTotal:
		// total 没有窗口末尾；给一个足够远的时刻，让计数器不过期。
		return now.UTC().AddDate(10, 0, 0)
	case WindowWeek:
		return g.WindowStart(now).AddDate(0, 0, 7)
	case WindowMonth:
		return g.WindowStart(now).AddDate(0, 1, 0)
	default:
		return g.WindowStart(now).AddDate(0, 0, 1)
	}
}

// CounterTTL 计数器存活到窗口末 + 1 天，留出对账余量（设计文档 5.2）。
func (g QuotaGrant) CounterTTL(now time.Time) time.Duration {
	ttl := g.WindowEnd(now).Add(24 * time.Hour).Sub(now.UTC())
	if ttl < time.Minute {
		return time.Minute
	}
	return ttl
}

// QuotaPlan 是一次放置需要携带的全部额度参数：上限、窗口键、计数器过期。
type QuotaPlan struct {
	Limits  contract.Metering
	Windows map[contract.MeterUnit]string
	Expiry  map[contract.MeterUnit]time.Duration
	// Reserve 各单位的保护线绝对值，= limit × QuotaReserveRatio。
	Reserve contract.Metering
	// Start / End 各单位当前窗口的起止时刻，有效座位数按它算消耗率与剩余时间。
	Start map[contract.MeterUnit]time.Time
	End   map[contract.MeterUnit]time.Time
}

// ElapsedHours 某单位当前窗口已经过去的小时数，下界 1/60 小时避免除零。
func (p QuotaPlan) ElapsedHours(unit contract.MeterUnit, now time.Time) float64 {
	start, ok := p.Start[unit]
	if !ok {
		return 1
	}
	hours := now.UTC().Sub(start).Hours()
	if hours < 1.0/60 {
		return 1.0 / 60
	}
	return hours
}

// RemainingHours 某单位当前窗口还剩多少小时，下界同上。
func (p QuotaPlan) RemainingHours(unit contract.MeterUnit, now time.Time) float64 {
	end, ok := p.End[unit]
	if !ok {
		return 1
	}
	hours := end.Sub(now.UTC()).Hours()
	if hours < 1.0/60 {
		return 1.0 / 60
	}
	return hours
}

// BuildQuotaPlan 把授权行展开成放置要用的参数表。
func BuildQuotaPlan(grants []QuotaGrant, now time.Time) QuotaPlan {
	plan := QuotaPlan{
		Limits:  contract.Metering{},
		Windows: map[contract.MeterUnit]string{},
		Expiry:  map[contract.MeterUnit]time.Duration{},
		Reserve: contract.Metering{},
		Start:   map[contract.MeterUnit]time.Time{},
		End:     map[contract.MeterUnit]time.Time{},
	}
	for _, grant := range grants {
		if grant.Limit <= 0 {
			continue
		}
		plan.Limits[grant.Unit] = grant.Limit
		plan.Windows[grant.Unit] = grant.WindowKey(now)
		plan.Expiry[grant.Unit] = grant.CounterTTL(now)
		plan.Reserve[grant.Unit] = int64(math.Ceil(float64(grant.Limit) * QuotaReserveRatio))
		plan.Start[grant.Unit] = grant.WindowStart(now)
		plan.End[grant.Unit] = grant.WindowEnd(now)
	}
	return plan
}

// QuotaAccepts 报告某个贡献在预留了 estimate 之后是否仍在各维度上限之内。
// 这是 Hub 侧的预筛，真正的判定在 Lua 里原子重做一次（可能被别的请求抢先）。
func QuotaAccepts(snapshot ContributionSnapshot, plan QuotaPlan, estimate contract.Metering) (bool, contract.MeterUnit) {
	left := snapshot.QuotaLeft()
	for unit, limit := range plan.Limits {
		if limit <= 0 {
			continue
		}
		if left[unit]-estimate[unit] < plan.Reserve[unit] {
			return false, unit
		}
	}
	return true, ""
}

// ExhaustedUnits 列出已经触顶（used ≥ limit）的单位。任一触顶该贡献停止接新单，
// 在跑的跑完（三维额度规则第 2 条）。
func ExhaustedUnits(snapshot ContributionSnapshot) []contract.MeterUnit {
	var units []contract.MeterUnit
	for _, unit := range snapshot.QuotaLimit.Units() {
		limit := snapshot.QuotaLimit[unit]
		if limit > 0 && snapshot.QuotaUsed[unit] >= limit {
			units = append(units, unit)
		}
	}
	return units
}

// WarnedUnits 列出跨过软阈值的单位，用于给主人发预警。
func WarnedUnits(snapshot ContributionSnapshot) []contract.MeterUnit {
	var units []contract.MeterUnit
	for _, unit := range snapshot.QuotaLimit.Units() {
		limit := snapshot.QuotaLimit[unit]
		if limit <= 0 {
			continue
		}
		if float64(snapshot.QuotaUsed[unit])/float64(limit) >= QuotaWarnRatio {
			units = append(units, unit)
		}
	}
	return units
}
