package exportdispatch

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"contract"
	corepkg "galaxy-hub-api/adapters/core"
	"service/galaxy"
	"service/galaxy/dto"
)

// 回连派单这一段守着三条边界，每条都对应一个真实的事故形态：
//   · 自证头不对的响应一个字节都不进消费者连接（SSRF）
//   · 派不出去要立刻收掉交汇点，而不是让消费者干等 30 秒的 attach 时限
//   · 回连结论不变就不写库，否则每个请求一条 UPDATE 打在节点表上

type fakeGalaxy struct {
	// 只实现派单器会调的方法。别的被调到会 panic —— 那条路径本来就不该走到。
	galaxy.Service

	mu        sync.Mutex
	failed    []*contract.UnitError
	health    []string
	results   int
	abandoned []string
}

func (f *fakeGalaxy) Config() galaxy.Config { return galaxy.DefaultConfig() }

func (f *fakeGalaxy) FailUnit(_ context.Context, _ string, cause *contract.UnitError) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failed = append(f.failed, cause)
	return nil
}

func (f *fakeGalaxy) RecordEndpointHealth(_ context.Context, _ string, status, detail string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.health = append(f.health, status+"|"+detail)
	return nil
}

func (f *fakeGalaxy) RecordHubResult(context.Context, string, contract.Metering, string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.results++
	return nil
}

func (f *fakeGalaxy) Abandon(_ context.Context, unitID, _ string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.abandoned = append(f.abandoned, unitID)
	return nil
}

// recordingWriter 扮演消费者那一端：记下写到它身上的一切。
type recordingWriter struct {
	status  int
	body    bytes.Buffer
	ended   bool
	aborted error
}

func (w *recordingWriter) Head(status int, _ map[string]string) { w.status = status }
func (w *recordingWriter) Write(chunk []byte) error             { w.body.Write(chunk); return nil }
func (w *recordingWriter) End()                                 { w.ended = true }
func (w *recordingWriter) Abort(err error)                      { w.aborted = err }
func (w *recordingWriter) Usage() contract.Metering             { return contract.Metering{} }

const secret = "export-secret-0123456789-abcdef"

func startNode(t *testing.T, handler http.HandlerFunc) galaxy.ExportTarget {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return galaxy.ExportTarget{NodeID: "n_export", BaseURL: server.URL, Secret: secret}
}

func claimed(unitID string) *dto.NextResult {
	return &dto.NextResult{Unit: map[string]any{"id": unitID}, Lease: dto.LeaseView{Token: "lt_1", RenewSec: 60}}
}

func TestPushRelaysTheNodeResponseToTheConsumer(t *testing.T) {
	service := &fakeGalaxy{}
	exchange := corepkg.NewExchange()
	writer := &recordingWriter{}
	exchange.Open("u_1", writer, nil)

	var authorization string
	var request executeRequest
	target := startNode(t, func(w http.ResponseWriter, r *http.Request) {
		authorization = r.Header.Get("authorization")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &request)
		headers, _ := json.Marshal(map[string]string{"content-type": "text/event-stream"})
		w.Header().Set("X-Galaxy-Node", "n_export")
		w.Header().Set("X-Galaxy-Upstream-Status", "201")
		w.Header().Set("X-Galaxy-Upstream-Headers", base64.StdEncoding.EncodeToString(headers))
		_, _ = w.Write([]byte("data: hello\n\n"))
	})

	New(service, exchange, nil).push(context.Background(), target, claimed("u_1"))

	if authorization != "Bearer "+secret {
		t.Fatalf("回连要出示回连密钥，实际 %q", authorization)
	}
	if request.Unit["id"] != "u_1" || request.Lease.Token != "lt_1" {
		t.Fatalf("推给节点的单元不对：%+v", request)
	}
	if writer.status != 201 || writer.body.String() != "data: hello\n\n" || !writer.ended {
		t.Fatalf("消费者该原样拿到上游状态码与字节：status=%d body=%q ended=%v", writer.status, writer.body.String(), writer.ended)
	}
	if service.results != 1 || len(service.failed) != 0 {
		t.Fatalf("正常写完要记 Hub 侧用量、不判失败：results=%d failed=%v", service.results, service.failed)
	}
	if strings.Join(service.health, ",") != "ok|" {
		t.Fatalf("回连成功要记一次 ok：%v", service.health)
	}
}

// SSRF 的闸：回连地址是提供者自己填的，填成一个「随便什么都回 200」的内网地址时，
// 那条响应里的东西一个字节都不能到消费者手上。
func TestPushRefusesAResponseThatDoesNotIdentifyTheNode(t *testing.T) {
	service := &fakeGalaxy{}
	exchange := corepkg.NewExchange()
	writer := &recordingWriter{}
	exchange.Open("u_1", writer, nil)
	target := startNode(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"AccessKeyId":"ASIA...","SecretAccessKey":"..."}`))
	})

	New(service, exchange, nil).push(context.Background(), target, claimed("u_1"))

	if writer.body.Len() != 0 || writer.status != 0 {
		t.Fatalf("没有自证头的响应不该写给消费者：status=%d body=%q", writer.status, writer.body.String())
	}
	if writer.aborted == nil {
		t.Fatal("交汇点要立刻收掉，消费者不该干等 attach 时限")
	}
	if len(service.failed) != 1 || !service.failed[0].Retryable {
		t.Fatalf("要判成可改派的节点故障：%v", service.failed)
	}
	if len(service.health) != 1 || !strings.HasPrefix(service.health[0], "unreachable|") {
		t.Fatalf("要把「地址后面不是本机节点」记给主人看：%v", service.health)
	}
}

// 节点拒单的状态码决定能不能改派：409 是「这台现在接不了，换一台」，
// 422 是「这个单元本身有问题」，换台机器也一样失败。
func TestPushTranslatesNodeRejectionsIntoReassignability(t *testing.T) {
	for _, item := range []struct {
		status    int
		retryable bool
	}{{http.StatusConflict, true}, {http.StatusBadGateway, true}, {http.StatusUnprocessableEntity, false}} {
		service := &fakeGalaxy{}
		exchange := corepkg.NewExchange()
		writer := &recordingWriter{}
		exchange.Open("u_1", writer, nil)
		target := startNode(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("X-Galaxy-Node", "n_export")
			w.WriteHeader(item.status)
			_, _ = w.Write([]byte(`{"type":"error","error":{"type":"capability_mismatch","message":"通道已满"}}`))
		})

		New(service, exchange, nil).push(context.Background(), target, claimed("u_1"))

		if len(service.failed) != 1 || service.failed[0].Retryable != item.retryable || service.failed[0].Message != "通道已满" {
			t.Fatalf("状态 %d：失败原因或可改派性不对：%+v", item.status, service.failed)
		}
		if writer.aborted == nil || writer.body.Len() != 0 {
			t.Fatalf("状态 %d：交汇点要收掉且不写任何字节", item.status)
		}
	}
}

// 消费者连在别的实例上时，回流的字节交不出去 —— 不去敲节点的门，直接判可改派。
func TestPushDoesNotContactTheNodeWhenTheConsumerIsNotHere(t *testing.T) {
	service := &fakeGalaxy{}
	var calls atomic.Int32
	target := startNode(t, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.Header().Set("X-Galaxy-Node", "n_export")
	})

	New(service, corepkg.NewExchange(), nil).push(context.Background(), target, claimed("u_elsewhere"))

	if calls.Load() != 0 {
		t.Fatal("交汇点不在本实例时不该回连节点")
	}
	if len(service.failed) != 1 || !service.failed[0].Retryable {
		t.Fatalf("要判成可改派：%v", service.failed)
	}
}

func TestRecordHealthOnlyWritesWhenTheVerdictChanges(t *testing.T) {
	service := &fakeGalaxy{}
	dispatcher := New(service, corepkg.NewExchange(), nil)
	ctx := context.Background()

	dispatcher.recordHealth(ctx, "n_1", "ok", "", false)
	dispatcher.recordHealth(ctx, "n_1", "ok", "", false)
	dispatcher.recordHealth(ctx, "n_1", "unreachable", "连不上", false)
	dispatcher.recordHealth(ctx, "n_1", "unreachable", "连不上", false)
	// 探测走 force：它负责刷新「最近一次探测时刻」，结论没变也要写。
	dispatcher.recordHealth(ctx, "n_1", "unreachable", "连不上", true)

	want := "ok|,unreachable|连不上,unreachable|连不上"
	if got := strings.Join(service.health, ","); got != want {
		t.Fatalf("写库次数不对：\n got  %s\n want %s", got, want)
	}
}
