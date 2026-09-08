package metrics

import (
	"strings"
	"testing"
)

func TestCounterAndGauge(t *testing.T) {
	registry := New()
	registry.Count("galaxy_unit_total", map[string]string{"kind": "llm.chat", "state": "completed"}, 1)
	registry.Count("galaxy_unit_total", map[string]string{"kind": "llm.chat", "state": "completed"}, 2)
	registry.Gauge("galaxy_lane_inflight", map[string]string{"cid": "c1"}, 4)
	registry.Gauge("galaxy_lane_inflight", map[string]string{"cid": "c1"}, 7)

	output := registry.Expose()
	if !strings.Contains(output, `galaxy_unit_total{kind="llm.chat",state="completed"} 3`) {
		t.Fatalf("计数器应累加:\n%s", output)
	}
	// 瞬时值取最新，不累加 —— 在跑的请求数是「现在几个」，不是「一共几个」。
	if !strings.Contains(output, `galaxy_lane_inflight{cid="c1"} 7`) {
		t.Fatalf("瞬时值应取最后一次:\n%s", output)
	}
}

// 标签顺序不能影响归属：map 的遍历顺序每次都不一样，
// 不排序的话同一个指标会裂成好几条 series。
func TestLabelOrderDoesNotSplitSeries(t *testing.T) {
	registry := New()
	registry.Count("galaxy_place_redis_ops", map[string]string{"kind": "llm.chat", "path": "bound"}, 1)
	registry.Count("galaxy_place_redis_ops", map[string]string{"path": "bound", "kind": "llm.chat"}, 1)
	if count := strings.Count(registry.Expose(), "galaxy_place_redis_ops{"); count != 1 {
		t.Fatalf("同一组标签应归到同一条 series，实际 %d 条", count)
	}
}

func TestHistogramBucketsAreCumulative(t *testing.T) {
	registry := New()
	for _, value := range []float64{3, 30, 300, 3000} {
		registry.Observe("galaxy_ttfb_ms", map[string]string{"kind": "llm.chat"}, value)
	}
	output := registry.Expose()
	// Prometheus 的直方图桶是累计的：le=50 那一格要包含 3 和 30 两个样本。
	if !strings.Contains(output, `galaxy_ttfb_ms_bucket{kind="llm.chat",le="50"} 2`) {
		t.Fatalf("桶应累计:\n%s", output)
	}
	if !strings.Contains(output, `galaxy_ttfb_ms_bucket{kind="llm.chat",le="+Inf"} 4`) {
		t.Fatalf("+Inf 桶应含全部样本:\n%s", output)
	}
	if !strings.Contains(output, `galaxy_ttfb_ms_count{kind="llm.chat"} 4`) ||
		!strings.Contains(output, `galaxy_ttfb_ms_sum{kind="llm.chat"} 3333`) {
		t.Fatalf("sum / count 不对:\n%s", output)
	}
}

func TestEmptyLabelValuesAreDropped(t *testing.T) {
	registry := New()
	// error_class 在成功路径上是空的。空标签值写进去只会让查询里多一堆 ="" 噪声。
	registry.Count("galaxy_unit_total", map[string]string{"kind": "llm.chat", "error_class": ""}, 1)
	output := registry.Expose()
	if strings.Contains(output, `error_class=""`) {
		t.Fatalf("空标签值不该出现:\n%s", output)
	}
}

func TestLabelValuesAreEscaped(t *testing.T) {
	registry := New()
	registry.Count("galaxy_unit_total", map[string]string{"kind": `a"b`}, 1)
	if !strings.Contains(registry.Expose(), `kind="a\"b"`) {
		t.Fatal("标签值里的引号要转义，否则输出不是合法的 exposition 格式")
	}
}

func TestConcurrentUpdatesDoNotRace(t *testing.T) {
	registry := New()
	done := make(chan struct{})
	for worker := 0; worker < 8; worker++ {
		go func() {
			for i := 0; i < 200; i++ {
				registry.Count("galaxy_unit_total", map[string]string{"kind": "llm.chat"}, 1)
				registry.Observe("galaxy_ttfb_ms", map[string]string{"kind": "llm.chat"}, float64(i))
				registry.Gauge("galaxy_lane_inflight", map[string]string{"cid": "c1"}, float64(i))
			}
			done <- struct{}{}
		}()
	}
	for worker := 0; worker < 8; worker++ {
		<-done
	}
	if !strings.Contains(registry.Expose(), `galaxy_unit_total{kind="llm.chat"} 1600`) {
		t.Fatal("并发累加丢数了")
	}
}
