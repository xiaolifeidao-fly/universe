package redisctl

import (
	"encoding/json"
	"sort"
	"strconv"
	"strings"
	"time"

	"contract"
	"service/galaxy"
)

// Redis 里一切都是字符串。这个文件把贡献快照在「HASH 字段」与「Go 结构」之间来回翻译。

func encode(value any) string {
	if value == nil {
		return ""
	}
	raw, err := json.Marshal(value)
	if err != nil || string(raw) == "null" {
		return ""
	}
	return string(raw)
}

func decodeStrings(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var out []string
	_ = json.Unmarshal([]byte(raw), &out)
	return out
}

func decodeMetering(raw string) contract.Metering {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var out contract.Metering
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil
	}
	return out
}

func decodeObject(raw string) map[string]any {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var out map[string]any
	_ = json.Unmarshal([]byte(raw), &out)
	return out
}

// decodeUpstreamLeft 控制面里那份「各窗口还剩多少」。
//
// 解不动回 nil，也就是「不知道」—— 余量闸门在不知道的时候放行，所以一段坏掉的
// JSON 只会让这台机器照常接单，不会让它凭空停掉。
func decodeUpstreamLeft(raw string) map[string]galaxy.UpstreamLeft {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var out map[string]galaxy.UpstreamLeft
	if err := json.Unmarshal([]byte(raw), &out); err != nil || len(out) == 0 {
		return nil
	}
	return out
}

func decodeSchedule(raw string) []galaxy.ScheduleWindow {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var out []galaxy.ScheduleWindow
	_ = json.Unmarshal([]byte(raw), &out)
	return out
}

func parseInt(value any) int64 {
	switch typed := value.(type) {
	case nil:
		return 0
	case int64:
		return typed
	case string:
		parsed, _ := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
		return parsed
	}
	return 0
}

func parseFloat(value string) float64 {
	parsed, _ := strconv.ParseFloat(strings.TrimSpace(value), 64)
	return parsed
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func toInt64(value any) int64 {
	if typed, ok := value.(int64); ok {
		return typed
	}
	return parseInt(value)
}

func toString(value any) string {
	if typed, ok := value.(string); ok {
		return typed
	}
	return ""
}

func sortUnits(units []contract.MeterUnit) {
	sort.Slice(units, func(i, j int) bool { return units[i] < units[j] })
}

// decodeSnapshot 把 contrib HASH 还原成放置算法要的快照。
//
// limit / used / left 是三组按单位展开的字段（limit:llm.output_tokens 之类）。
// 展开成字段而不是塞一个 JSON，是为了让 Lua 能用 HINCRBY 直接改单个维度 ——
// 放置与结算都要动它，读改写一个 JSON 串既不原子也更慢。
func decodeSnapshot(cid string, values map[string]string) galaxy.ContributionSnapshot {
	snapshot := galaxy.ContributionSnapshot{
		CID: cid, NodeID: values["nodeId"], OwnerUserID: values["ownerUserId"],
		Kind: values["kind"], KindVersion: int(parseInt(values["kindVersion"])), Provider: values["provider"],
		ModelsAllow: decodeStrings(values["modelsAllow"]), ModelsDeny: decodeStrings(values["modelsDeny"]),
		Groups: decodeStrings(values["groups"]),
		Seats:  int(parseInt(values["seats"])), SeatConcurrency: int(parseInt(values["seatConc"])),
		Inflight: int(parseInt(values["inflight"])),
		Schedule: decodeSchedule(values["schedule"]),
		// 余量下限解不动时回的是**默认那条**（剩 0% 才停），不是空 ——
		// 空等于「这条贡献不受保护」，而真相只是我们自己没读懂这一列。
		UpstreamFloors: galaxy.DecodeUpstreamFloors(values["upstreamFloor"]),
		UpstreamLeft:   decodeUpstreamLeft(values["upstreamLeft"]),
		Draining:       values["draining"] == "1",
		Paused:         values["paused"] == "1",
		UpstreamOK:     values["upstreamOK"] != "0",
		Reputation:     parseFloat(values["reputation"]),
		P50TTFBMs:      int(parseInt(values["p50Ttfb"])),
		QuotaLimit:     contract.Metering{}, QuotaUsed: contract.Metering{}, QuotaReserved: contract.Metering{},
		CachedArtifacts: decodeStrings(values["cachedArtifacts"]),
		Resources:       decodeObject(values["resources"]),
	}
	if beat := parseInt(values["lastBeat"]); beat > 0 {
		snapshot.LastBeatAt = time.UnixMilli(beat)
	}
	if bound := parseInt(values["lastBoundAt"]); bound > 0 {
		snapshot.LastBoundAt = time.UnixMilli(bound)
	}
	if throttled := parseInt(values["throttledUntil"]); throttled > 0 {
		snapshot.ThrottledUntil = time.UnixMilli(throttled)
	}
	for field, value := range values {
		switch {
		case strings.HasPrefix(field, "limit:"):
			snapshot.QuotaLimit[strings.TrimPrefix(field, "limit:")] = parseInt(value)
		case strings.HasPrefix(field, "used:"):
			snapshot.QuotaUsed[strings.TrimPrefix(field, "used:")] = parseInt(value)
		}
	}
	// QuotaLeft() 按 limit − used − reserved 算，而 left 是 Lua 维护的权威值，
	// 差额记在 reserved 上，两条路径得出的余量因此始终一致。
	for field, value := range values {
		if !strings.HasPrefix(field, "left:") {
			continue
		}
		unit := strings.TrimPrefix(field, "left:")
		snapshot.QuotaReserved[unit] = snapshot.QuotaLimit[unit] - snapshot.QuotaUsed[unit] - parseInt(value)
	}
	return snapshot
}
