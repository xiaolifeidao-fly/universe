package core_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"contract"
	corepkg "galaxy-hub-api/adapters/core"
	"service/galaxy"
	"service/galaxy/dto"
)

// session / job 的提交是异步的：一个回合可能跑几分钟，把它绑在一条消费者连接上，
// 用户切个网络就等于把活弄丢了。这组用例把「提交即返回、事件随时订阅、
// 消费者断开不影响单元」这三条钉死。

type stubGalaxy struct {
	galaxy.Service
	mu        sync.Mutex
	submitted chan contract.WorkUnit
	abandoned chan string
	events    []corepkg.JournalEvent
}

func (s *stubGalaxy) AuthenticateKey(context.Context, string) (dto.Caller, error) {
	return dto.Caller{KeyID: "ck_test"}, nil
}

func (s *stubGalaxy) Submit(_ context.Context, unit contract.WorkUnit) (galaxy.Placement, error) {
	s.submitted <- unit
	return galaxy.Placement{UnitID: unit.ID, CID: "c1", Attempt: unit.Attempt}, nil
}

func (s *stubGalaxy) FirstByte(context.Context, string) error { return nil }

func (s *stubGalaxy) Abandon(_ context.Context, unitID, _ string) error {
	s.abandoned <- unitID
	return nil
}

func (s *stubGalaxy) RecordHubResult(context.Context, string, contract.Metering, string) error {
	return nil
}

func (s *stubGalaxy) AppendUnitEvent(_ context.Context, _ string, seq int, kind string, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, corepkg.JournalEvent{Seq: seq, Kind: kind, Data: data})
	return nil
}

// sessionAdapter 是个只为测试存在的最小 session 适配器。
type sessionAdapter struct {
	deps *corepkg.Deps
}

func (a *sessionAdapter) Kind() contract.KindSpec {
	spec := contract.KindSpec{Kind: "test.session", Version: 1, Primitive: contract.PrimitiveSession, Providers: []string{"stub"}}
	spec.Metering.Units = []contract.MeterUnit{contract.UnitCalls}
	spec.Placement.Affinity = contract.AffinityHard
	return spec
}

func (a *sessionAdapter) Routes() []corepkg.Route {
	return []corepkg.Route{{Method: http.MethodPost, Path: "/test/turns"}}
}

func (a *sessionAdapter) Parse(ginContext *gin.Context) (corepkg.Input, error) {
	raw, _ := io.ReadAll(ginContext.Request.Body)
	return string(raw), nil
}

func (a *sessionAdapter) Route(context.Context, corepkg.Input) (contract.RouteKey, error) {
	return contract.RouteKey{Kind: "test.session", KindVersion: 1, Provider: "stub"}, nil
}

func (a *sessionAdapter) Estimate(corepkg.Input) contract.Metering {
	return contract.Metering{contract.UnitCalls: 1}
}

func (a *sessionAdapter) ToUnit(raw corepkg.Input, caller corepkg.Caller) contract.WorkUnit {
	body, _ := raw.(string)
	return contract.WorkUnit{
		Kind: "test.session", KindVersion: 1, Primitive: contract.PrimitiveSession,
		ConsumerKey: caller.KeyID, SID: "s_1", Op: contract.OpTurn, Seq: 1,
		Inputs: []contract.Payload{{Name: "turn", Inline: []byte(body)}},
	}
}

func (a *sessionAdapter) Writer(_ *gin.Context, _ corepkg.Input, unit contract.WorkUnit) corepkg.EventWriter {
	return corepkg.NewJournalWriter(a.deps.Journal, unit.ID)
}

func (a *sessionAdapter) ToError(_ corepkg.Input, status int, code, message string) any {
	return gin.H{"error": gin.H{"type": code, "message": message, "status": status}}
}

func newSessionHub(t *testing.T) (*httptest.Server, *stubGalaxy, *corepkg.Journal) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	service := &stubGalaxy{submitted: make(chan contract.WorkUnit, 4), abandoned: make(chan string, 4)}
	journal := corepkg.NewJournal(64, func(unitID string, event corepkg.JournalEvent) {
		_ = service.AppendUnitEvent(context.Background(), unitID, event.Seq, event.Kind, event.Data)
	})
	exchange := corepkg.NewExchange()
	deps := &corepkg.Deps{Galaxy: service, Exchange: exchange, Journal: journal}
	adapter := &sessionAdapter{deps: deps}

	engine := gin.New()
	group := engine.Group("/v1", corepkg.RequireConsumerKey(service))
	corepkg.Register(group, adapter, *deps)
	// 节点上行：直接用交汇点，不经过 agent 包，免得测试跨了两个模块。
	engine.POST("/node/:unitId/stream", func(ginContext *gin.Context) {
		session, err := exchange.Attach(ginContext.Param("unitId"))
		if err != nil {
			ginContext.JSON(http.StatusConflict, gin.H{"error": err.Error()})
			return
		}
		session.Head(200, map[string]string{"content-type": "application/x-ndjson"})
		body, _ := io.ReadAll(ginContext.Request.Body)
		if writeErr := session.Write(body); writeErr != nil {
			ginContext.JSON(http.StatusGone, gin.H{"error": writeErr.Error()})
			return
		}
		session.Finish(nil)
		exchange.Release(ginContext.Param("unitId"))
		ginContext.JSON(http.StatusOK, gin.H{"ok": true})
	})

	server := httptest.NewServer(engine)
	t.Cleanup(func() {
		server.CloseClientConnections()
		server.Close()
	})
	return server, service, journal
}

func post(t *testing.T, url, body string) *http.Response {
	t.Helper()
	request, _ := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer sk-galaxy-test")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	return response
}

func TestSessionSubmitReturnsImmediately(t *testing.T) {
	server, service, _ := newSessionHub(t)

	done := make(chan int, 1)
	go func() {
		response := post(t, server.URL+"/v1/test/turns", `{"text":"hi"}`)
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, response.Body)
		done <- response.StatusCode
	}()

	unit := <-service.submitted
	if unit.Op != contract.OpTurn || unit.SID != "s_1" {
		t.Fatalf("会话字段没带上: %+v", unit)
	}
	select {
	case status := <-done:
		// 202：提交即返回，不等节点跑完。这正是 relay 与 session 的分水岭。
		if status != http.StatusAccepted {
			t.Fatalf("session 提交应立刻返回 202，实际 %d", status)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("session 提交不该等节点跑完")
	}
}

// 消费者断开不影响单元：节点照样能把事件推完，事件也照样进日志。
func TestSessionSurvivesConsumerDisconnect(t *testing.T) {
	server, service, journal := newSessionHub(t)

	response := post(t, server.URL+"/v1/test/turns", `{"text":"hi"}`)
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
	unit := <-service.submitted

	// 提交那条连接已经关了。节点这时才开始推事件。
	stream := post(t, server.URL+"/node/"+unit.ID+"/stream",
		`{"kind":"text","data":{"v":1}}`+"\n"+`{"kind":"done","usage":{"llm.calls":1}}`+"\n")
	defer stream.Body.Close()
	if stream.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(stream.Body)
		t.Fatalf("节点上行不该被拒: %d %s", stream.StatusCode, body)
	}

	replay, _, cancel := journal.Subscribe(unit.ID, 0)
	defer cancel()
	if len(replay) < 2 {
		t.Fatalf("事件应进日志: %+v", replay)
	}
	if replay[0].Kind != "text" {
		t.Fatalf("第一条应是业务事件: %+v", replay[0])
	}
	// 消费者早就走了，但没人被判成「取消」—— 这是 session 与 relay 的关键区别。
	select {
	case unitID := <-service.abandoned:
		t.Fatalf("session 不该因为消费者断开就取消: %s", unitID)
	default:
	}

	service.mu.Lock()
	persisted := len(service.events)
	service.mu.Unlock()
	if persisted < 2 {
		t.Fatalf("事件应同时落库供断线重连回放，实际 %d 条", persisted)
	}
}

func TestSessionAcceptedBodyCarriesUnitID(t *testing.T) {
	server, service, _ := newSessionHub(t)
	response := post(t, server.URL+"/v1/test/turns", `{"text":"hi"}`)
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	unit := <-service.submitted

	var payload struct {
		UnitID string `json:"unitId"`
		State  string `json:"state"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("回执不是 JSON: %s", body)
	}
	// 消费者拿这个 id 去订阅事件流，没有它这套异步模型就断了。
	if payload.UnitID != unit.ID || payload.State != string(contract.UnitPlaced) {
		t.Fatalf("回执应带上单元 id 与状态: %s", body)
	}
}

// 节点完全不推流、直接报完成也是合法的（一个没有任何输出的回合）。
// 那种情况下事件日志必须照样收尾，否则订阅它的 SSE 会永远挂着。
func TestSessionFinishesJournalWhenNodeNeverStreams(t *testing.T) {
	_, _, journal := newSessionHub(t)
	exchange := corepkg.NewExchange()
	writer := corepkg.NewJournalWriter(journal, "u_silent")
	exchange.Open("u_silent", writer, nil)

	// 模拟 complete 的收尾：Attach 成功说明确实没人收过尾。
	session, err := exchange.Attach("u_silent")
	if err != nil {
		t.Fatalf("应能认领: %v", err)
	}
	session.Finish(nil)
	exchange.Release("u_silent")

	replay, live, cancel := journal.Subscribe("u_silent", 0)
	defer cancel()
	if len(replay) == 0 || !replay[len(replay)-1].Terminal {
		t.Fatalf("日志必须有终态事件: %+v", replay)
	}
	select {
	case _, ok := <-live:
		if ok {
			t.Fatal("已收尾的日志不该再有事件")
		}
	case <-time.After(time.Second):
		t.Fatal("已收尾的日志，订阅拿到的应是一条关好的通道")
	}
}

// TestResponseCarriesRequestID 消费者手里得有那一次执行的 id。
//
// 没有它，出了问题就只能描述「昨天下午那次」——申诉接口要的是 unitId，
// 排障要的也是它（设计文档 13 节：requestId 消费者 ← Hub ← 节点三段同值）。
func TestResponseCarriesRequestID(t *testing.T) {
	server, service, _ := newSessionHub(t)
	response := post(t, server.URL+"/v1/test/turns", `{"text":"hi"}`)
	defer response.Body.Close()
	unit := <-service.submitted

	if got := response.Header.Get(corepkg.RequestIDHeader); got != unit.ID {
		t.Fatalf("响应头应带上这次执行的 id：期望 %s，实际 %q", unit.ID, got)
	}
}
