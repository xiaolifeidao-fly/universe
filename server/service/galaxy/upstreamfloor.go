package galaxy

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"

	"service/galaxy/dto"
)

// 上游余量下限：主人给自己的订阅留一条线，快用完的时候先停止接单。
//
// 这是 UpstreamUsageJSON 从「只给人看」变成进决策路径的那一步，原先那条规矩
// （见 20260920_galaxy_upstream_usage.sql）立的理由是两条：上游的形状由上游说了算、
// 而节点自报的数没法验证。两条到今天仍然成立，所以这里的判定是**单向**的：
//
//	认得出来的窗口 + 余量低于线   → 不接单
//	认不出来、没采到、解不动     → 照常接单
//
// 也就是说，这条线只会让一台机器少接活，不会让它多接活。一台探不到余量的机器
// （没装 CLI、探针连着超时、上游换了输出格式）照常共享 —— 反过来把「不知道」
// 当成「没余量」的话，一次输出格式变化就能让全网的机器一起静默退出。
//
// 另一件让它现在可行的事：余量的来源换了。以前是从中转响应头里捎，机器闲着就不更新 ——
// 那种数据拿来做闸门会死锁：低于线 → 不接单 → 没有请求 → 数字永远不刷新。现在是节点
// 每五分钟问本机的 claude / codex 自己（pool/usage_probe.rs），跟有没有人派活无关，
// 窗口重置之后下一轮探测就会把数带回来，闸门自己打开。

// upstreamFloorMaxRows 一条贡献最多留几条线。
//
// 上游一共就报两三个窗口，留 8 条是给「将来多出几个窗口」的余量。有上限是因为
// 这一列要进控制面的哈希，而那份东西每次派单都要读。
const upstreamFloorMaxRows = 8

// upstreamWindowPattern 窗口记法：节点归一化出来的 5h / 7d 这种。
// 空串另有含义（任一窗口），不走这个校验。
var upstreamWindowPattern = regexp.MustCompile(`^[a-z0-9]{1,8}$`)

// UpstreamFloor 一条「余量低到这儿就不接单」的规则。
//
// Window 空串 = 任一窗口：上游报几个窗口由上游说了算，主人多半只想说一句
// 「快用完了就别接了」，不想先去认识 5h 和 7d。Percent 是**剩余**百分比的下限，
// 剩余 ≤ Percent 就不接单。
type UpstreamFloor struct {
	Window  string `json:"window"`
	Percent int    `json:"percent"`
}

// UpstreamLeft 某个窗口此刻还剩多少，以及报出这个数的那个桶叫什么。
//
// 带上桶名是为了让界面能指出**具体哪一行**触了线：周额度底下可能同时有
// 「Current week (all models)」和「Current week (Opus)」，两个都是 7d。
type UpstreamLeft struct {
	Percent float64 `json:"p"`
	Bucket  string  `json:"b,omitempty"`
}

// DefaultUpstreamFloors 没填过的贡献按这个算：任一窗口剩 0% 才停 —— 也就是
// 不额外保护，和加这条线之前的行为一致。
//
// 默认值不是「没有规则」：空着的那一列会被后来的人读成「这条贡献不受保护」，
// 而它其实只是没填过，两者在改行为的时候要做的事完全不同。
func DefaultUpstreamFloors() []UpstreamFloor {
	return []UpstreamFloor{{Window: "", Percent: 0}}
}

// NormalizeUpstreamFloors 校验主人填的那几条，顺便排序去空。
//
// 一个窗口只留一条：两条线盯同一个窗口时，宽的那条永远不会生效，而主人
// 看着界面上明明写着的数字，不会想到它是死的。
func NormalizeUpstreamFloors(in []dto.UpstreamFloorInput) ([]UpstreamFloor, error) {
	if len(in) == 0 {
		return DefaultUpstreamFloors(), nil
	}
	if len(in) > upstreamFloorMaxRows {
		return nil, fmt.Errorf("上游余量下限最多 %d 条，收到 %d 条", upstreamFloorMaxRows, len(in))
	}
	seen := make(map[string]bool, len(in))
	out := make([]UpstreamFloor, 0, len(in))
	for _, row := range in {
		window := strings.ToLower(strings.TrimSpace(row.Window))
		if window != "" && !upstreamWindowPattern.MatchString(window) {
			return nil, fmt.Errorf("认不出这个窗口：%s", row.Window)
		}
		if row.Percent < 0 || row.Percent > 100 {
			return nil, fmt.Errorf("余量下限要在 0 到 100 之间，收到 %d", row.Percent)
		}
		if seen[window] {
			return nil, fmt.Errorf("窗口 %s 配了不止一条余量下限，每个窗口只能留一条", upstreamWindowLabel(window))
		}
		seen[window] = true
		out = append(out, UpstreamFloor{Window: window, Percent: row.Percent})
	}
	sortUpstreamFloors(out)
	return out, nil
}

// upstreamWindowLabel 报错里提到窗口时的说法。空串是「任一窗口」，
// 原样打一个空串出去，主人只会看到一句「窗口 配了不止一条」。
func upstreamWindowLabel(window string) string {
	if window == "" {
		return "任一窗口"
	}
	return window
}

// sortUpstreamFloors 任一窗口那条排最前，其余按窗口名。
// 判定要挑出「是哪条线挡住的」，顺序不稳定的话同一个状态会在两条规则之间跳。
func sortUpstreamFloors(floors []UpstreamFloor) {
	sort.SliceStable(floors, func(i, j int) bool { return floors[i].Window < floors[j].Window })
}

// ToUpstreamFloorInputs 回给界面的形状。
func ToUpstreamFloorInputs(floors []UpstreamFloor) []dto.UpstreamFloorInput {
	out := make([]dto.UpstreamFloorInput, 0, len(floors))
	for _, floor := range floors {
		out = append(out, dto.UpstreamFloorInput{Window: floor.Window, Percent: floor.Percent})
	}
	return out
}

// EncodeUpstreamFloors 存库与写控制面用同一份形状 —— 两边各一套编码，
// 迟早出现「界面上是 10%、派单按 0% 算」这种只在生产才看得见的偏差。
func EncodeUpstreamFloors(floors []UpstreamFloor) string {
	if len(floors) == 0 {
		return ""
	}
	raw, err := json.Marshal(floors)
	if err != nil {
		return ""
	}
	return string(raw)
}

// DecodeUpstreamFloors 解不动就回默认，不回空切片。
//
// 空切片等于「这条贡献没有任何下限」，而解不动的原因多半是我们自己改了形状 ——
// 那一刻把所有老行都变成「不受保护」，是用一次静默的行为变化去掩盖一次格式变更。
func DecodeUpstreamFloors(payload string) []UpstreamFloor {
	if strings.TrimSpace(payload) == "" {
		return DefaultUpstreamFloors()
	}
	var floors []UpstreamFloor
	if json.Unmarshal([]byte(payload), &floors) != nil || len(floors) == 0 {
		return DefaultUpstreamFloors()
	}
	sortUpstreamFloors(floors)
	return floors
}

// UpstreamLeftByWindow 一份观测 → 每个窗口此刻还剩百分之多少。
//
// 同一个窗口有好几个桶时取**最小**的那个（周额度底下还分总量和 Opus）：
// 任何一个桶见底，那个窗口就真的跑不动了，取平均或取第一个都会高估。
//
// 认不出剩余的桶直接跳过 —— 判定那一侧把「没有这个窗口」当成「不知道」放行，
// 所以这里宁可少给一个键，也不要塞一个猜出来的数。
func UpstreamLeftByWindow(usage *dto.UpstreamUsage) map[string]UpstreamLeft {
	if usage == nil || len(usage.Buckets) == 0 {
		return nil
	}
	out := map[string]UpstreamLeft{}
	for _, bucket := range usage.Buckets {
		left, ok := bucketLeftPercent(bucket)
		if !ok {
			continue
		}
		window := strings.ToLower(strings.TrimSpace(bucket.Window))
		current, exists := out[window]
		if exists && current.Percent <= left {
			continue
		}
		out[window] = UpstreamLeft{Percent: left, Bucket: bucket.Bucket}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// bucketLeftPercent 一个桶还剩百分之多少。
//
// 优先用 usedPercent：节点存的是**已用**（两家一个报已用、一个报剩余，在节点那儿
// 已经统一过一次了，见 pool/usage.rs），这里只做一次减法。没有百分比时才用
// remaining / limit 折算，两样都没有就是「不知道」。
func bucketLeftPercent(bucket dto.UsageBucket) (float64, bool) {
	if bucket.UsedPercent != nil {
		return clampPercent(100 - *bucket.UsedPercent), true
	}
	if bucket.Remaining != nil && bucket.Limit != nil && *bucket.Limit > 0 {
		return clampPercent(float64(*bucket.Remaining) / float64(*bucket.Limit) * 100), true
	}
	return 0, false
}

// clampPercent 上游偶尔会报出 101% 或者负数（不同窗口的计数口径对不齐）。
// 夹回 0–100，不丢弃：那种行仍然说明了「快用完了」这件事。
func clampPercent(value float64) float64 {
	if math.IsNaN(value) {
		return 0
	}
	return math.Max(0, math.Min(100, value))
}

// UpstreamBlockedBy 此刻是哪条线把这条贡献挡住了。第二个返回值 false = 没被挡。
//
// 规则：window 为空的那条看**所有**窗口里最低的那个；填了窗口的只看那一个，
// 而那个窗口没观测到就跳过（不知道 → 放行，见本文件顶注）。
func UpstreamBlockedBy(floors []UpstreamFloor, left map[string]UpstreamLeft) (dto.UpstreamBlockView, bool) {
	if len(floors) == 0 || len(left) == 0 {
		return dto.UpstreamBlockView{}, false
	}
	for _, floor := range floors {
		window, observed, ok := lowestMatch(floor.Window, left)
		if !ok {
			continue
		}
		if observed.Percent > float64(floor.Percent) {
			continue
		}
		return dto.UpstreamBlockView{
			Window: window, Percent: floor.Percent,
			Left: observed.Percent, Bucket: observed.Bucket,
		}, true
	}
	return dto.UpstreamBlockView{}, false
}

// lowestMatch 这条规则盯的那个观测。任一窗口那条取最低的一个，
// 并把它真正落在哪个窗口一起报出来 —— 界面要指出是哪一行触的线。
func lowestMatch(window string, left map[string]UpstreamLeft) (string, UpstreamLeft, bool) {
	if window != "" {
		observed, ok := left[window]
		return window, observed, ok
	}
	best, bestWindow, found := UpstreamLeft{}, "", false
	// 按窗口名遍历，不靠 map 的随机序：同样低的两个窗口要每次都挑出同一个，
	// 否则界面上那句「5h 只剩 3%」会在两个窗口之间来回跳。
	windows := make([]string, 0, len(left))
	for key := range left {
		windows = append(windows, key)
	}
	sort.Strings(windows)
	for _, key := range windows {
		observed := left[key]
		if !found || observed.Percent < best.Percent {
			best, bestWindow, found = observed, key, true
		}
	}
	return bestWindow, best, found
}
