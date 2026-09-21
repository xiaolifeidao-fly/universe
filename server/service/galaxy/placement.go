package galaxy

import (
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"contract"
)

// 放置算法（设计文档第 4 节）。这个文件只做「选哪个贡献」的纯计算：
// 硬过滤 + 打分 + 有效座位数。真正不可分割的那一步（占座位、预留额度、入队）
// 在 ControlPlane.Place 的 Lua 里做，因为它必须相对其他请求原子。

// ScoreWeights 打分权重。可配；relay 把 w6 置 0，job 把 w1 置 0。
type ScoreWeights struct {
	FreeSeats  float64 // w1 空座位多
	QuotaFloor float64 // w2 余量短板厚
	Idle       float64 // w3 当前空闲
	Latency    float64 // w4 首字节快
	Reputation float64 // w5 靠谱
	Locality   float64 // w6 数据引力
}

func DefaultScoreWeights() ScoreWeights {
	return ScoreWeights{FreeSeats: 0.30, QuotaFloor: 0.25, Idle: 0.20, Latency: 0.10, Reputation: 0.10, Locality: 0.05}
}

// ForPrimitive 按原语调整权重：relay 没有数据引力，job 不认座位。
func (w ScoreWeights) ForPrimitive(primitive contract.Primitive) ScoreWeights {
	switch primitive {
	case contract.PrimitiveRelay:
		w.Locality = 0
	case contract.PrimitiveJob:
		w.FreeSeats = 0
	}
	return w
}

// Candidate 通过硬过滤的一个贡献，连同它的额度参数与得分。
type Candidate struct {
	Snapshot ContributionSnapshot
	Plan     QuotaPlan
	SeatsEff int
	Score    float64
}

// FilterInput 硬过滤要看的全部东西。
type FilterInput struct {
	Route            contract.RouteKey
	Spec             contract.KindSpec
	Estimate         contract.Metering
	Plans            map[string]QuotaPlan // cid → 额度参数
	Now              time.Time
	HeartbeatTimeout time.Duration
	// LocalityKeys job 的输入产物键，用于数据引力打分。
	LocalityKeys []string
	Weights      ScoreWeights
	// FallbackBurn 同 kind 全池的每座位小时消耗率，样本不足的贡献用它兜底。
	FallbackBurn contract.Metering
}

// Filter 硬过滤：kind/版本支持 ∧ provider 匹配 ∧ model ∈ allow∖deny ∧ 在线 ∧ 未限流
// ∧ 上游余量高于主人划的线 ∧ 未排空 ∧ 在挂机时段内 ∧ seatsUsed < seatsEff
// ∧ 各单位余量 > 预留 + 预估 ∧ inflight < conc。
func Filter(snapshots []ContributionSnapshot, in FilterInput) []Candidate {
	candidates := make([]Candidate, 0, len(snapshots))
	for _, snapshot := range snapshots {
		plan := in.Plans[snapshot.CID]
		seatsEff, ok := admit(snapshot, plan, in)
		if !ok {
			continue
		}
		candidates = append(candidates, Candidate{Snapshot: snapshot, Plan: plan, SeatsEff: seatsEff})
	}
	return candidates
}

func admit(snapshot ContributionSnapshot, plan QuotaPlan, in FilterInput) (int, bool) {
	if snapshot.Kind != in.Route.Kind || snapshot.KindVersion != in.Spec.Version {
		return 0, false
	}
	if snapshot.Provider != in.Route.Provider {
		return 0, false
	}
	if in.Route.Model != "" && !contract.ModelMatch(in.Route.Model, snapshot.ModelsAllow, snapshot.ModelsDeny) {
		return 0, false
	}
	if !Online(snapshot, in.Now, in.HeartbeatTimeout) {
		return 0, false
	}
	if snapshot.Draining || snapshot.Paused || !snapshot.UpstreamOK {
		return 0, false
	}
	// 上游自身限流优先于额度：被 429 的贡献临时退出候选（三维额度规则第 7 条）。
	if !snapshot.ThrottledUntil.IsZero() && in.Now.Before(snapshot.ThrottledUntil) {
		return 0, false
	}
	// 上游订阅自己快用完了：主人划的那条线（UpstreamFloors）按节点五分钟一轮的
	// 探测结果判。和 429 是同一类事 —— 上游那边不让跑了，只是这一条是主人提前划的，
	// 为的是给自己留下要用的那部分。
	//
	// 观测缺失一律放行（见 upstreamfloor.go）：探不到余量的机器该照常接单，
	// 把「不知道」当成「没余量」的话，上游改一次输出格式就能让全网静默退出。
	if UpstreamHolding(snapshot) {
		return 0, false
	}
	if !InSchedule(snapshot.Schedule, in.Now) {
		return 0, false
	}
	concurrency := snapshot.Concurrency()
	if concurrency <= 0 || snapshot.Inflight >= concurrency {
		return 0, false
	}
	if !ResourcesSatisfy(snapshot.Resources, in.Spec.Placement.Requires) {
		return 0, false
	}
	if ok, _ := QuotaAccepts(snapshot, plan, in.Estimate); !ok {
		return 0, false
	}
	seatsEff := EffectiveSeats(snapshot, plan, in.Now, in.FallbackBurn)
	if seatsEff <= 0 || snapshot.SeatsUsed >= seatsEff {
		return 0, false
	}
	return seatsEff, true
}

// Waitable 候选为空时判断等一等还有没有指望：至少有一条贡献只差「手上的活结算完」就能接这单。
//
// 并发占满、额度被在途请求预留着，这两样一结算就还回来，值得排队（C-05）。其余原因 ——
// 模型没人提供、离线、暂停、排空、上游限流、挂机时段外、额度真的用完、座位都被别的消费者
// 绑着（空闲满 bindIdleTTL 才释放）—— 在 maxWait 这几秒里都变不了，让消费者干等只是把
// 一个注定的 503 推迟十秒。
func Waitable(snapshots []ContributionSnapshot, in FilterInput) bool {
	for _, snapshot := range snapshots {
		if _, ok := admit(onceSettled(snapshot), in.Plans[snapshot.CID], in); ok {
			return true
		}
	}
	return false
}

// UpstreamHolding 这条贡献此刻是不是被主人划的余量下限挡着。
//
// 硬过滤、已绑定的快路径、硬钉那条都要问同一句话 —— 只在硬过滤里判的话，
// 回头客（走绑定那条，占九成请求）和链式请求会从这条线底下绕过去，
// 主人留给自己的那部分照样被跑光，而界面上一切正常。
func UpstreamHolding(snapshot ContributionSnapshot) bool {
	_, blocked := UpstreamBlockedBy(snapshot.UpstreamFloors, snapshot.UpstreamLeft)
	return blocked
}

// boundAccepts 已绑定路径的放行条件：座位已经占着，只看并发与额度两项。
func boundAccepts(snapshot ContributionSnapshot, plan QuotaPlan, estimate contract.Metering) bool {
	accepts, _ := QuotaAccepts(snapshot, plan, estimate)
	return accepts && snapshot.Inflight < snapshot.Concurrency()
}

// onceSettled 假设在途的活都已结算：并发归零、预留全部还回去。
// 座位是粘性绑定，结算并不释放，所以照旧。
func onceSettled(snapshot ContributionSnapshot) ContributionSnapshot {
	snapshot.Inflight = 0
	snapshot.QuotaReserved = contract.Metering{}
	return snapshot
}

// ResourcesSatisfy 比对 kind 声明的资源需求与节点探测到的本机资源。
//
// 只认数值型的下限（diskFreeGB、netMbps 这类）：资源需求是「至少要有多少」，
// 不是精确匹配。节点没报某项资源时放行 —— 老版本节点不该因为少报一个字段就被摘掉，
// 真跑不动会在执行时失败，那是可改派的。
func ResourcesSatisfy(resources map[string]any, requires map[string]any) bool {
	for key, wanted := range requires {
		need, ok := toFloat(wanted)
		if !ok {
			continue
		}
		raw, present := resources[key]
		if !present {
			continue
		}
		have, ok := toFloat(raw)
		if !ok || have < need {
			return false
		}
	}
	return true
}

func toFloat(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		parsed, err := typed.Float64()
		return parsed, err == nil
	}
	return 0, false
}

// Online 45s 没收到心跳就认为该节点的贡献已经不在了（设计文档 2.3）。
func Online(snapshot ContributionSnapshot, now time.Time, timeout time.Duration) bool {
	if snapshot.LastBeatAt.IsZero() {
		return false
	}
	if timeout <= 0 {
		timeout = 45 * time.Second
	}
	return now.Sub(snapshot.LastBeatAt) <= timeout
}

// EffectiveSeats 有效座位数（设计文档 4.3）：主人配置的 seats 只是上限，
// 真正能接纳几个消费者由余量与窗口剩余时间决定。
//
// burn 的口径：当前窗口内每座位的小时消耗率。窗口刚翻转时样本为 0，
// 此时退回同 kind 全池均值；池子也没样本就不限制（让第一笔请求进来产生样本）。
func EffectiveSeats(snapshot ContributionSnapshot, plan QuotaPlan, now time.Time, fallbackBurn contract.Metering) int {
	seats := snapshot.Seats
	if seats <= 0 {
		return 0
	}
	left := snapshot.QuotaLeft()

	// 任一维度剩余低于保护线 ⇒ 不再接新绑定。
	for unit, reserve := range plan.Reserve {
		if plan.Limits[unit] > 0 && left[unit] < reserve {
			return 0
		}
	}
	// 小时维度剩余低于 minSessionSec 就别再绑人了，绑上也跑不完一段对话。
	if plan.Limits[contract.UnitTimeSeconds] > 0 && left[contract.UnitTimeSeconds] < MinSessionSec {
		return 0
	}

	effective := seats
	for unit, limit := range plan.Limits {
		if limit <= 0 || unit == contract.UnitTimeSeconds {
			continue
		}
		burn := burnRate(snapshot, unit, plan, now, fallbackBurn)
		if burn <= 0 {
			continue
		}
		// hoursLeft 按该维度自己的窗口算：day 与 month 两个单位的剩余时间不是一回事。
		capacity := int(math.Floor(float64(left[unit]) / (burn * plan.RemainingHours(unit, now))))
		if capacity < effective {
			effective = capacity
		}
	}
	if effective < 0 {
		return 0
	}
	return effective
}

// burnRate 每座位每小时的消耗率。用「当前窗口已用量 ÷ 已过小时 ÷ 座位数」估计，
// 不额外存滑动窗口 —— 这个近似只用来决定「还能不能再绑一个人」，不参与计费。
func burnRate(snapshot ContributionSnapshot, unit contract.MeterUnit, plan QuotaPlan, now time.Time, fallback contract.Metering) float64 {
	used := snapshot.QuotaUsed[unit]
	if used <= 0 {
		return float64(fallback[unit])
	}
	seats := snapshot.Seats
	if seats <= 0 {
		seats = 1
	}
	return float64(used) / plan.ElapsedHours(unit, now) / float64(seats)
}

// InSchedule 判断当前是否落在挂机时段内。空时段表示全天可接单。
// 支持跨零点的区间（如 22:00-08:00）。
func InSchedule(windows []ScheduleWindow, now time.Time) bool {
	if len(windows) == 0 {
		return true
	}
	for _, window := range windows {
		location := time.UTC
		if window.TZ != "" {
			if loaded, err := time.LoadLocation(window.TZ); err == nil {
				location = loaded
			}
		}
		local := now.In(location)
		minutes := local.Hour()*60 + local.Minute()
		from, okFrom := parseClock(window.From)
		to, okTo := parseClock(window.To)
		if !okFrom || !okTo {
			continue
		}
		if from == to {
			return true
		}
		if from < to {
			if minutes >= from && minutes < to {
				return true
			}
		} else if minutes >= from || minutes < to {
			return true
		}
	}
	return false
}

func parseClock(value string) (int, bool) {
	parts := strings.SplitN(strings.TrimSpace(value), ":", 2)
	if len(parts) != 2 {
		return 0, false
	}
	hour, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, false
	}
	minute, err := strconv.Atoi(parts[1])
	if err != nil {
		return 0, false
	}
	return hour*60 + minute, true
}

// Score 打分（设计文档 4.4）。得分越高越优先；平手取 lastBoundAt 最早的，
// 让长期没被用到的机器有机会分到活。
func Score(candidate Candidate, in FilterInput) float64 {
	weights := in.Weights.ForPrimitive(in.Spec.Primitive)
	snapshot := candidate.Snapshot

	freeSeats := 0.0
	if candidate.SeatsEff > 0 {
		freeSeats = 1 - float64(snapshot.SeatsUsed)/float64(candidate.SeatsEff)
	}

	quotaFloor := 1.0
	left := snapshot.QuotaLeft()
	for unit, limit := range candidate.Plan.Limits {
		if limit <= 0 {
			continue
		}
		ratio := float64(left[unit]) / float64(limit)
		if ratio < quotaFloor {
			quotaFloor = ratio
		}
	}

	idle := 1.0
	if concurrency := snapshot.Concurrency(); concurrency > 0 {
		idle = 1 - float64(snapshot.Inflight)/float64(concurrency)
	}

	return weights.FreeSeats*clamp01(freeSeats) +
		weights.QuotaFloor*clamp01(quotaFloor) +
		weights.Idle*clamp01(idle) +
		weights.Latency*latencyScore(snapshot.P50TTFBMs) +
		weights.Reputation*clamp01(snapshot.Reputation) +
		weights.Locality*localityHit(snapshot.CachedArtifacts, in.LocalityKeys)
}

// Rank 按得分排序并返回。调用方从头开始试，被抢座位就试下一个。
func Rank(candidates []Candidate, in FilterInput) []Candidate {
	for index := range candidates {
		candidates[index].Score = Score(candidates[index], in)
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		if math.Abs(candidates[i].Score-candidates[j].Score) > 1e-9 {
			return candidates[i].Score > candidates[j].Score
		}
		return candidates[i].Snapshot.LastBoundAt.Before(candidates[j].Snapshot.LastBoundAt)
	})
	return candidates
}

// latencyScore 把 p50 首字节归一到 0..1：150ms 以内满分，3s 以上 0 分。
func latencyScore(p50 int) float64 {
	if p50 <= 0 {
		return 0.5 // 没样本给中位，不奖不罚
	}
	const best, worst = 150.0, 3000.0
	if float64(p50) <= best {
		return 1
	}
	if float64(p50) >= worst {
		return 0
	}
	return 1 - (float64(p50)-best)/(worst-best)
}

func localityHit(cached, wanted []string) float64 {
	if len(wanted) == 0 || len(cached) == 0 {
		return 0
	}
	have := make(map[string]struct{}, len(cached))
	for _, key := range cached {
		have[key] = struct{}{}
	}
	hits := 0
	for _, key := range wanted {
		if _, ok := have[key]; ok {
			hits++
		}
	}
	return float64(hits) / float64(len(wanted))
}

func clamp01(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
}
