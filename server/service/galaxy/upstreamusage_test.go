package galaxy

import (
	"encoding/json"
	"strings"
	"testing"

	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 上游余量是**节点自报的事实**。这一组盯住的是「不会被误读」——
// 它现在还多了一层利害：余量下限（upstreamfloor.go）拿它挡派单，
// 一次写坏的落库就是一台机器白白停止接单。
// 解不动时给 nil 而不是一份全 0 的快照，以及没报时不要把上一次的观测抹掉。

// TestDecodeUpstreamUsageReturnsNilOnGarbage 解不动就当没有。
//
// 这一列存的是上游说了算的形状：上游改一次头名、我们改一次结构，老行就可能解不动。
// 那时界面该显示「没有数据」，而不是一份数字全 0 的快照 —— 后者会被读成「用完了」。
func TestDecodeUpstreamUsageReturnsNilOnGarbage(t *testing.T) {
	for _, payload := range []string{"", "   ", "{", "not json", "[1,2,3]"} {
		if usage := decodeUpstreamUsage(payload); usage != nil {
			t.Fatalf("%q 应该解成 nil，得到 %+v", payload, usage)
		}
	}
}

// TestDecodeUpstreamUsageRoundTrips 正常的一份要原样解回来，包括原始头。
// raw 是事后补解析器时唯一能对照的真实报文，不能在存取之间丢掉。
func TestDecodeUpstreamUsageRoundTrips(t *testing.T) {
	limit, remaining := int64(1_000_000), int64(250_000)
	percent := 75.0
	source := dto.UpstreamUsage{
		Buckets: []dto.UsageBucket{{
			Bucket: "unified-5h", Window: "5h",
			Limit: &limit, Remaining: &remaining, UsedPercent: &percent,
			Reset: "2026-09-20T18:00:00Z", Status: "allowed_warning",
		}},
		Raw:        map[string]string{"anthropic-ratelimit-unified-5h-remaining": "250000"},
		ObservedAt: "2026-09-20T13:05:00Z",
		Source:     "headers",
	}
	payload, err := json.Marshal(source)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	decoded := decodeUpstreamUsage(string(payload))
	if decoded == nil {
		t.Fatal("应该解得出来")
	}
	if len(decoded.Buckets) != 1 || decoded.Buckets[0].Window != "5h" {
		t.Fatalf("桶丢了: %+v", decoded.Buckets)
	}
	if decoded.Buckets[0].Remaining == nil || *decoded.Buckets[0].Remaining != 250_000 {
		t.Fatalf("剩余错了: %+v", decoded.Buckets[0])
	}
	if decoded.Raw["anthropic-ratelimit-unified-5h-remaining"] != "250000" {
		t.Fatalf("原始头丢了: %+v", decoded.Raw)
	}
	if decoded.ObservedAt != source.ObservedAt || decoded.Source != "headers" {
		t.Fatalf("观测时刻或来源丢了: %+v", decoded)
	}
}

// TestUsageBucketKeepsMissingValuesNil 没报的项必须是 nil，不能落成 0。
//
// 「上游没告诉我们还剩多少」和「还剩 0」是完全不同的两件事，而指针是这份契约里
// 唯一能把它们分开的东西：换成 int64 的话，两者在界面上长得一模一样。
func TestUsageBucketKeepsMissingValuesNil(t *testing.T) {
	decoded := decodeUpstreamUsage(`{"buckets":[{"bucket":"unified","window":"5h"}],"raw":{},"observedAt":"x","source":"headers"}`)
	if decoded == nil || len(decoded.Buckets) != 1 {
		t.Fatalf("应该有一个桶: %+v", decoded)
	}
	bucket := decoded.Buckets[0]
	if bucket.Limit != nil || bucket.Remaining != nil || bucket.UsedPercent != nil {
		t.Fatalf("没报的项要留 nil: %+v", bucket)
	}
	// 序列化回去时这些字段整个不出现，前端才分得清「没有」和「0」。
	payload, _ := json.Marshal(bucket)
	for _, field := range []string{"limit", "remaining", "usedPercent"} {
		if strings.Contains(string(payload), `"`+field+`"`) {
			t.Fatalf("%s 不该出现在序列化结果里: %s", field, payload)
		}
	}
}

// ---------- 只在变了的时候才写 ----------

func usageOf(remaining int64, observedAt string) *dto.UpstreamUsage {
	value := remaining
	return &dto.UpstreamUsage{
		Buckets:    []dto.UsageBucket{{Bucket: "unified-5h", Window: "5h", Remaining: &value}},
		Raw:        map[string]string{"anthropic-ratelimit-unified-5h-remaining": "x"},
		ObservedAt: observedAt,
		Source:     "headers",
	}
}

func contributionRows(pairs map[string]string) map[string]*repository.GalaxyContribution {
	rows := map[string]*repository.GalaxyContribution{}
	for cid, stored := range pairs {
		rows[cid] = &repository.GalaxyContribution{CID: cid, UpstreamUsageJSON: stored}
	}
	return rows
}

// TestPendingUsageWritesSkipsUnchanged 心跳 15 秒一次，而这份数只在机器真跑了活
// 之后才变。不比就写 = 每台机器每天四千多次空 UPDATE，全落在派单路径要读的那张表上。
func TestPendingUsageWritesSkipsUnchanged(t *testing.T) {
	usage := usageOf(250_000, "2026-09-20T13:00:00Z")
	stored, err := json.Marshal(usage)
	if err != nil {
		t.Fatal(err)
	}
	rows := contributionRows(map[string]string{"n1:relay_claude": string(stored)})
	writes := pendingUsageWrites("n1", []dto.LaneInput{{CID: "relay_claude", Usage: usage}}, rows)
	if len(writes) != 0 {
		t.Fatalf("一模一样的一份不该落库: %+v", writes)
	}
}

// TestPendingUsageWritesTakesChanged 变了就写，而且要按**全名** cid 写：
// 心跳里的是去掉节点前缀的短名，库里那张表用的是全名。
func TestPendingUsageWritesTakesChanged(t *testing.T) {
	previous, _ := json.Marshal(usageOf(250_000, "2026-09-20T13:00:00Z"))
	rows := contributionRows(map[string]string{"n1:relay_claude": string(previous)})
	writes := pendingUsageWrites("n1", []dto.LaneInput{
		{CID: "relay_claude", Usage: usageOf(120_000, "2026-09-20T13:05:00Z")},
	}, rows)
	if len(writes) != 1 {
		t.Fatalf("变了就该写一条: %+v", writes)
	}
	if writes[0].CID != "n1:relay_claude" {
		t.Fatalf("要按全名写: %s", writes[0].CID)
	}
	if !strings.Contains(writes[0].Payload, "120000") {
		t.Fatalf("写的是新的那份: %s", writes[0].Payload)
	}
}

// TestPendingUsageWritesIgnoresMissing 没报的通道跳过。
//
// 老版本节点根本不带这个字段，一次中转都没跑过的机器也不带 —— 两种情况都不该
// 把上一次真实的观测抹成空。
func TestPendingUsageWritesIgnoresMissing(t *testing.T) {
	previous, _ := json.Marshal(usageOf(250_000, "2026-09-20T13:00:00Z"))
	rows := contributionRows(map[string]string{"n1:relay_claude": string(previous)})
	writes := pendingUsageWrites("n1", []dto.LaneInput{{CID: "relay_claude"}}, rows)
	if len(writes) != 0 {
		t.Fatalf("没报就该原样留着: %+v", writes)
	}
	if rows["n1:relay_claude"].UpstreamUsageJSON != string(previous) {
		t.Fatal("上一次的观测被抹掉了")
	}
}

// TestPendingUsageWritesIgnoresUnknownLane 报了一条库里没有的通道就跳过，
// 不去猜是哪一条 —— 猜错就是把 Claude 的余量写到 Codex 那一行上。
func TestPendingUsageWritesIgnoresUnknownLane(t *testing.T) {
	rows := contributionRows(map[string]string{"n1:relay_claude": ""})
	writes := pendingUsageWrites("n1", []dto.LaneInput{
		{CID: "relay_codex", Usage: usageOf(1, "2026-09-20T13:00:00Z")},
	}, rows)
	if len(writes) != 0 {
		t.Fatalf("对不上的通道不该写: %+v", writes)
	}
}

// TestPendingUsageWritesDropsOversized 超长的整条丢掉，不截断。
//
// 这份东西的长度是**上游说了算**的。截一半的 JSON 存进去，下次解不动就成了
// 「没有数据」，而且每次心跳都会重写一遍 —— 既看不到数又一直在写库。
func TestPendingUsageWritesDropsOversized(t *testing.T) {
	usage := usageOf(1, "2026-09-20T13:00:00Z")
	for index := 0; index < 200; index++ {
		usage.Raw[strings.Repeat("x", 30)+string(rune('a'+index%26))+string(rune('0'+index%10))+string(rune(index/10+'A'))] = strings.Repeat("y", 30)
	}
	rows := contributionRows(map[string]string{"n1:relay_claude": ""})
	writes := pendingUsageWrites("n1", []dto.LaneInput{{CID: "relay_claude", Usage: usage}}, rows)
	if len(writes) != 0 {
		t.Fatalf("超长的该整条丢掉: %d 条", len(writes))
	}
}
