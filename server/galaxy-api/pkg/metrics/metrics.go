// Package metrics 是一个够用的进程内指标注册表，外加 Prometheus 文本格式的输出。
//
// 不引 prometheus 客户端库：这里只需要计数器、瞬时值与固定分桶直方图三种语义，
// 加一个依赖换不来什么，反而让 service 层有了被拖进具体实现的风险 ——
// 领域包只认 galaxy.Metrics 这个接口。
package metrics

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"

	"service/galaxy"
)

// buckets 毫秒级延迟的分桶。覆盖「同机房附加延迟 ≤150ms」到「长任务几十秒」这个跨度。
var buckets = []float64{5, 10, 25, 50, 100, 150, 250, 500, 1000, 2500, 5000, 10000, 30000}

type series struct {
	name   string
	labels string

	counter float64
	gauge   float64
	// hist 各桶的累计计数，最后一格是 +Inf。
	hist  []float64
	sum   float64
	count float64
	kind  string
}

type Registry struct {
	mu   sync.Mutex
	data map[string]*series
}

func New() *Registry {
	return &Registry{data: map[string]*series{}}
}

func (r *Registry) at(name, kind string, labels map[string]string) *series {
	encoded := encodeLabels(labels)
	key := name + "{" + encoded + "}"
	existing, ok := r.data[key]
	if !ok {
		existing = &series{name: name, labels: encoded, kind: kind, hist: make([]float64, len(buckets)+1)}
		r.data[key] = existing
	}
	return existing
}

func (r *Registry) Count(name string, labels map[string]string, delta float64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.at(name, "counter", labels).counter += delta
}

func (r *Registry) Gauge(name string, labels map[string]string, value float64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.at(name, "gauge", labels).gauge = value
}

func (r *Registry) Observe(name string, labels map[string]string, value float64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	target := r.at(name, "histogram", labels)
	target.sum += value
	target.count++
	for index, bound := range buckets {
		if value <= bound {
			target.hist[index]++
		}
	}
	target.hist[len(buckets)]++
}

// Expose 输出 Prometheus 文本格式。
func (r *Registry) Expose() string {
	r.mu.Lock()
	snapshot := make([]*series, 0, len(r.data))
	for _, item := range r.data {
		copied := *item
		copied.hist = append([]float64(nil), item.hist...)
		snapshot = append(snapshot, &copied)
	}
	r.mu.Unlock()

	sort.Slice(snapshot, func(i, j int) bool {
		if snapshot[i].name == snapshot[j].name {
			return snapshot[i].labels < snapshot[j].labels
		}
		return snapshot[i].name < snapshot[j].name
	})

	var builder strings.Builder
	lastName := ""
	for _, item := range snapshot {
		if item.name != lastName {
			builder.WriteString("# TYPE " + item.name + " " + item.kind + "\n")
			lastName = item.name
		}
		switch item.kind {
		case "counter":
			writeSample(&builder, item.name, item.labels, "", item.counter)
		case "gauge":
			writeSample(&builder, item.name, item.labels, "", item.gauge)
		case "histogram":
			for index, bound := range buckets {
				writeSample(&builder, item.name+"_bucket", item.labels,
					"le=\""+strconv.FormatFloat(bound, 'f', -1, 64)+"\"", item.hist[index])
			}
			writeSample(&builder, item.name+"_bucket", item.labels, "le=\"+Inf\"", item.hist[len(buckets)])
			writeSample(&builder, item.name+"_sum", item.labels, "", item.sum)
			writeSample(&builder, item.name+"_count", item.labels, "", item.count)
		}
	}
	return builder.String()
}

func writeSample(builder *strings.Builder, name, labels, extra string, value float64) {
	all := labels
	if extra != "" {
		if all == "" {
			all = extra
		} else {
			all += "," + extra
		}
	}
	if all == "" {
		fmt.Fprintf(builder, "%s %s\n", name, strconv.FormatFloat(value, 'f', -1, 64))
		return
	}
	fmt.Fprintf(builder, "%s{%s} %s\n", name, all, strconv.FormatFloat(value, 'f', -1, 64))
}

// encodeLabels 标签按名排序后编码：同一组标签必须映射到同一个 series，
// 否则 map 的遍历顺序会让同一个指标裂成好几条。
func encodeLabels(labels map[string]string) string {
	if len(labels) == 0 {
		return ""
	}
	keys := make([]string, 0, len(labels))
	for key := range labels {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		value := labels[key]
		if value == "" {
			continue
		}
		parts = append(parts, key+"=\""+escape(value)+"\"")
	}
	return strings.Join(parts, ",")
}

func escape(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`)
	return replacer.Replace(value)
}

// Handler 暴露 /metrics。不挂鉴权中间件：谁能访问由部署侧决定
// （通常只在内网监听，或放在网关后面）。指标里没有任何业务内容。
func (r *Registry) Handler() gin.HandlerFunc {
	return func(context *gin.Context) {
		context.Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		context.String(200, r.Expose())
	}
}

var _ galaxy.Metrics = (*Registry)(nil)
