package agent_test

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
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"contract"
	corepkg "galaxy-api/adapters/core"
	"galaxy-api/adapters/relay"
	"galaxy-api/pkg/agent"
	"service/galaxy"
	"service/galaxy/dto"
)

// 三段链路的联调：消费者 → Hub → 节点 → Hub → 消费者。
// 它验证的是设计里最容易写错的那部分 —— 字节在 Hub 进程内直传、首字节语义、
// 消费者断开的传导，以及 Hub 侧从透传流里解析出的用量。

type fakeGalaxy struct {
	// 只实现测试要走的方法。没实现的被调到会 panic —— 这条路径本来就不该走到。
	galaxy.Service

	mu          sync.Mutex
	submitted   chan contract.WorkUnit
	firstByte   chan string
	hubUsage    chan contract.Metering
	abandoned   chan string
	failed      chan *contract.UnitError
	submitError error
	reassign    bool
	alive       bool
	signature   string
}

func newFakeGalaxy() *fakeGalaxy {
	return &fakeGalaxy{
		submitted: make(chan contract.WorkUnit, 4),
		firstByte: make(chan string, 4),
		hubUsage:  make(chan contract.Metering, 4),
		abandoned: make(chan string, 4),
		failed:    make(chan *contract.UnitError, 4),
		alive:     true,
	}
}

func (f *fakeGalaxy) Config() galaxy.Config { return galaxy.DefaultConfig() }

func (f *fakeGalaxy) AuthenticateKey(context.Context, string) (dto.Caller, error) {
	return dto.Caller{KeyID: "ck_test", Alias: "test"}, nil
}

// AuthenticateNode 让测试能扮演不同的节点：令牌形如 "gnt_<nodeId>"。
func (f *fakeGalaxy) AuthenticateNode(_ context.Context, token string) (galaxy.NodeIdentity, error) {
	nodeID := strings.TrimPrefix(strings.TrimPrefix(token, "Bearer "), "gnt_")
	if nodeID == "" {
		nodeID = "n_test"
	}
	return galaxy.NodeIdentity{NodeID: nodeID, OwnerUserID: "u_1"}, nil
}

// AuthorizeUnit 单元只属于放置时那个节点。真实实现查的是贡献所属节点，
// 这里用同一条语义：不是 n_test 就不该碰这个单元。
func (f *fakeGalaxy) AuthorizeUnit(_ context.Context, _ string, nodeID string) error {
	if nodeID != "n_test" {
		return contract.NewUnitError(contract.ErrorClassProtocol, contract.CodeLeaseInvalid, false, "该单元不在本节点上")
	}
	return nil
}

func (f *fakeGalaxy) Submit(_ context.Context, unit contract.WorkUnit) (galaxy.Placement, error) {
	f.mu.Lock()
	err := f.submitError
	f.mu.Unlock()
	if err != nil {
		return galaxy.Placement{}, err
	}
	f.submitted <- unit
	return galaxy.Placement{UnitID: unit.ID, CID: "n_test:claude-main", Attempt: unit.Attempt}, nil
}

func (f *fakeGalaxy) FirstByte(_ context.Context, unitID string) error {
	f.firstByte <- unitID
	return nil
}

func (f *fakeGalaxy) RecordHubResult(_ context.Context, _ string, usage contract.Metering, signature string) error {
	f.signature = signature
	f.hubUsage <- usage
	return nil
}

func (f *fakeGalaxy) Abandon(_ context.Context, unitID, _ string) error {
	f.abandoned <- unitID
	return nil
}

func (f *fakeGalaxy) FailUnit(_ context.Context, _ string, cause *contract.UnitError) error {
	select {
	case f.failed <- cause:
	default:
	}
	return nil
}

func (f *fakeGalaxy) ContributionAlive(context.Context, string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.alive
}

func (f *fakeGalaxy) Reassignable(context.Context, string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reassign
}

func (f *fakeGalaxy) RememberResponse(context.Context, string, string) error { return nil }

func (f *fakeGalaxy) LookupResponseContribution(context.Context, string) (string, bool) {
	return "", false
}

func (f *fakeGalaxy) Complete(context.Context, dto.CompleteRequest) (dto.CompleteResult, error) {
	return dto.CompleteResult{}, nil
}

func newHub(t *testing.T) (*httptest.Server, *fakeGalaxy) {
	return newHubWith(t, nil)
}

// newHubWith 让用例调 relay 的等待时限。默认那几个是按真实上游的节奏定的
// （认领 30 秒、探心跳 10 秒），跑在用例里只会让测试等满。
func newHubWith(t *testing.T, tune func(*corepkg.Deps)) (*httptest.Server, *fakeGalaxy) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	service := newFakeGalaxy()
	exchange := corepkg.NewExchange()
	deps := &corepkg.Deps{Galaxy: service, Exchange: exchange}
	if tune != nil {
		tune(deps)
	}
	adapter := relay.New(deps, relay.Options{})

	engine := gin.New()
	consumer := engine.Group("/v1", corepkg.RequireConsumerKey(service))
	corepkg.Register(consumer, adapter, *deps)
	agent.NewHandler(service, exchange, corepkg.NewJournal(64, nil), 2*time.Second, nil).RegisterHandler(engine.Group("/agent/v1"))

	server := httptest.NewServer(engine)
	// 先断开客户端连接再 Close：这些用例里消费者连接本来就挂着等节点，
	// 断言一失败 Close 就会卡到测试超时，真正的失败原因反而看不见了。
	t.Cleanup(func() {
		server.CloseClientConnections()
		server.Close()
	})
	return server, service
}

const anthropicStream = "event: message_start\n" +
	`data: {"type":"message_start","message":{"usage":{"input_tokens":120,"output_tokens":1}}}` + "\n\n" +
	"event: content_block_delta\n" +
	`data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}` + "\n\n" +
	"event: message_delta\n" +
	`data: {"type":"message_delta","usage":{"output_tokens":42}}` + "\n\n"

func upstreamHeaders(t *testing.T, headers map[string]string) string {
	t.Helper()
	raw, err := json.Marshal(headers)
	if err != nil {
		t.Fatalf("编码上游头失败: %v", err)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

func TestRelayEndToEnd(t *testing.T) {
	server, service := newHub(t)

	type consumerResult struct {
		status int
		body   string
		header http.Header
		err    error
	}
	done := make(chan consumerResult, 1)
	go func() {
		request, _ := http.NewRequest(http.MethodPost, server.URL+"/v1/messages",
			strings.NewReader(`{"model":"claude-sonnet-4-5","stream":true,"max_tokens":1024,"messages":[]}`))
		request.Header.Set("Authorization", "Bearer sk-galaxy-test")
		request.Header.Set("anthropic-version", "2023-06-01")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			done <- consumerResult{err: err}
			return
		}
		defer response.Body.Close()
		body, _ := io.ReadAll(response.Body)
		done <- consumerResult{status: response.StatusCode, body: string(body), header: response.Header}
	}()

	unit := <-service.submitted
	if unit.Model != "claude-sonnet-4-5" || unit.Family != relay.FamilyAnthropic {
		t.Fatalf("路由键解析错误: model=%s family=%s", unit.Model, unit.Family)
	}
	if unit.Provider != "claude_oauth" {
		t.Fatalf("provider 应由协议族推出: %s", unit.Provider)
	}
	// 客户端的协议头要带给节点，否则上游行为与直连不一致。
	headers := map[string]string{}
	raw, _ := unit.InlineInput("headers")
	_ = json.Unmarshal(raw, &headers)
	if headers["anthropic-version"] != "2023-06-01" {
		t.Fatalf("客户端协议头没有转发: %v", headers)
	}
	// 预估：max_tokens 决定输出预留（设计文档 5.5）。
	if unit.Metering.Estimate[contract.UnitOutputTokens] != 1024 {
		t.Fatalf("输出预估应取 max_tokens: %v", unit.Metering.Estimate)
	}

	// 节点上行：把上游字节原样推给 Hub。
	streamRequest, _ := http.NewRequest(http.MethodPost,
		server.URL+"/agent/v1/units/"+unit.ID+"/stream", strings.NewReader(anthropicStream))
	streamRequest.Header.Set("Authorization", "Bearer gnt_n_test")
	streamRequest.Header.Set("X-Galaxy-Upstream-Status", "200")
	streamRequest.Header.Set("X-Galaxy-Upstream-Headers", upstreamHeaders(t, map[string]string{
		"content-type":                         "text/event-stream",
		"anthropic-ratelimit-tokens-remaining": "9000",
		"set-cookie":                           "should-not-leak",
	}))
	streamResponse, err := http.DefaultClient.Do(streamRequest)
	if err != nil {
		t.Fatalf("上行失败: %v", err)
	}
	defer streamResponse.Body.Close()
	if streamResponse.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(streamResponse.Body)
		t.Fatalf("上行被拒: %d %s", streamResponse.StatusCode, body)
	}

	result := <-done
	if result.err != nil {
		t.Fatalf("消费者请求失败: %v", result.err)
	}
	if result.status != http.StatusOK {
		t.Fatalf("状态码应原样透传: %d", result.status)
	}
	// 逐字节比对：中转站的语义就是「与直连一致」。
	if result.body != anthropicStream {
		t.Fatalf("响应字节与上游不一致:\n got=%q\nwant=%q", result.body, anthropicStream)
	}
	if result.header.Get("anthropic-ratelimit-tokens-remaining") != "9000" {
		t.Fatal("限流头应原样带回")
	}
	if result.header.Get("set-cookie") != "" {
		t.Fatal("白名单之外的上游头不该带给消费者")
	}

	if id := <-service.firstByte; id != unit.ID {
		t.Fatalf("首字节记在了别的单元上: %s", id)
	}
	// Hub 从透传的流里自己解析用量，不看节点自报（S-04）。
	usage := <-service.hubUsage
	if usage[contract.UnitInputTokens] != 120 || usage[contract.UnitOutputTokens] != 42 {
		t.Fatalf("Hub 侧解析出的用量不对: %v", usage)
	}
	// 结构签名只记事件名与量级，不含任何响应内容 —— 它要能安全地留在抽检表里。
	service.mu.Lock()
	signature := service.signature
	service.mu.Unlock()
	if !strings.Contains(signature, "message_start") || !strings.Contains(signature, "message_delta") {
		t.Fatalf("响应签名应记下事件序列: %q", signature)
	}
	if strings.Contains(signature, "hi") {
		t.Fatalf("签名不该含响应内容: %q", signature)
	}
}

// 节点令牌只证明「你是某个节点」，不证明「这个单元派给了你」。
// 少了这一关，任何在线节点都能往别人的消费者连接里灌字节。
func TestStreamRejectedForForeignNode(t *testing.T) {
	server, service := newHub(t)
	// 消费者这条连接会一直挂着等节点。测试结束前必须主动断开，
	// 否则 httptest.Server.Close 会等它等到超时。
	consumerCtx, closeConsumer := context.WithCancel(context.Background())
	defer closeConsumer()
	go func() {
		request, _ := http.NewRequestWithContext(consumerCtx, http.MethodPost, server.URL+"/v1/messages",
			strings.NewReader(`{"model":"claude-sonnet-4-5","messages":[]}`))
		request.Header.Set("Authorization", "Bearer sk-galaxy-test")
		if response, err := http.DefaultClient.Do(request); err == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
		}
	}()
	unit := <-service.submitted

	request, _ := http.NewRequest(http.MethodPost,
		server.URL+"/agent/v1/units/"+unit.ID+"/stream", strings.NewReader("data: x\n\n"))
	request.Header.Set("Authorization", "Bearer gnt_n_attacker")
	request.Header.Set("X-Galaxy-Upstream-Status", "200")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)
	// 归属校验失败按协议映射到 409（lease_invalid）。
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("别的节点推流应被拒（409），实际 %d", response.StatusCode)
	}
}

func TestStreamRejectedWhenNoConsumerWaiting(t *testing.T) {
	server, _ := newHub(t)
	request, _ := http.NewRequest(http.MethodPost, server.URL+"/agent/v1/units/u_missing/stream", strings.NewReader("x"))
	request.Header.Set("Authorization", "Bearer gnt_n_test")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer response.Body.Close()
	// 没有等待中的消费者：告诉节点这条上行没有意义，别再推了。
	if response.StatusCode != http.StatusConflict {
		t.Fatalf("应返回 409，实际 %d", response.StatusCode)
	}
}

func TestConsumerDisconnectStopsNodeStream(t *testing.T) {
	server, service := newHub(t)

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		request, _ := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/v1/messages",
			strings.NewReader(`{"model":"claude-sonnet-4-5","stream":true,"messages":[]}`))
		request.Header.Set("Authorization", "Bearer sk-galaxy-test")
		response, err := http.DefaultClient.Do(request)
		if err == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
		}
	}()

	unit := <-service.submitted
	cancel() // 消费者走了

	// 节点还在推：Hub 必须以 410 打断它，节点据此 abort 上游。
	deadline := time.Now().Add(3 * time.Second)
	for {
		request, _ := http.NewRequest(http.MethodPost,
			server.URL+"/agent/v1/units/"+unit.ID+"/stream", bytes.NewReader([]byte("data: x\n\n")))
		request.Header.Set("Authorization", "Bearer gnt_n_test")
		request.Header.Set("X-Galaxy-Upstream-Status", "200")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatalf("上行请求失败: %v", err)
		}
		status := response.StatusCode
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		if status == http.StatusGone || status == http.StatusConflict {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("消费者断开后上行仍被接受: %d", status)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestNoCapacityRendersOfficialErrorShape(t *testing.T) {
	server, service := newHub(t)
	service.mu.Lock()
	service.submitError = contract.NewUnitError(contract.ErrorClassHub, contract.CodeNoCapacity, true, "共享池暂无可用算力")
	service.mu.Unlock()

	request, _ := http.NewRequest(http.MethodPost, server.URL+"/v1/messages",
		strings.NewReader(`{"model":"claude-sonnet-4-5","messages":[]}`))
	request.Header.Set("Authorization", "Bearer sk-galaxy-test")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("无候选应返回 503，实际 %d", response.StatusCode)
	}
	if response.Header.Get("retry-after") == "" {
		t.Fatal("503 要带 retry-after，客户端才知道多久后重试")
	}
	body, _ := io.ReadAll(response.Body)
	var payload struct {
		Type  string `json:"type"`
		Error struct {
			Type string `json:"type"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("错误体不是 JSON: %s", body)
	}
	// Anthropic 族的错误体形态必须与官方一致，否则 SDK 解析不了。
	if payload.Type != "error" || payload.Error.Type != contract.CodeNoCapacity {
		t.Fatalf("错误体形态不对: %s", body)
	}
}

func TestOpenAIErrorShape(t *testing.T) {
	server, service := newHub(t)
	service.mu.Lock()
	service.submitError = contract.NewUnitError(contract.ErrorClassHub, contract.CodeNoCapacity, true, "共享池暂无可用算力")
	service.mu.Unlock()

	request, _ := http.NewRequest(http.MethodPost, server.URL+"/v1/responses",
		strings.NewReader(`{"model":"gpt-5","input":"hi"}`))
	request.Header.Set("Authorization", "Bearer sk-galaxy-test")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	var payload struct {
		Error struct {
			Message string `json:"message"`
			Type    string `json:"type"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("错误体不是 JSON: %s", body)
	}
	if payload.Error.Type != contract.CodeNoCapacity || payload.Error.Message == "" {
		t.Fatalf("OpenAI 族错误体形态不对: %s", body)
	}
}

func TestInvalidBodyIsRejectedBeforePlacement(t *testing.T) {
	server, service := newHub(t)
	request, _ := http.NewRequest(http.MethodPost, server.URL+"/v1/messages", strings.NewReader(`{"messages":[]}`))
	request.Header.Set("Authorization", "Bearer sk-galaxy-test")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("缺 model 应 400，实际 %d", response.StatusCode)
	}
	select {
	case unit := <-service.submitted:
		t.Fatalf("入参非法不该派单: %s", unit.ID)
	default:
	}
}

// 这两条守的是同一个故障：中转站把活派出去之后，那台机器没了。
//
// 现实里最常见的形态是共享者重启 Nova 或者进程被 kill —— 节点已经领走单元、
// 正在打上游，首字节还没回来。这一段 Hub 完全看不见：没有 stream 的 EOF，
// 也不会有 complete。少了时限，消费者的 codex 就一直转下去。

func TestConsumerGetsErrorWhenNodeNeverAttaches(t *testing.T) {
	server, service := newHubWith(t, func(deps *corepkg.Deps) {
		deps.AttachTimeout = 120 * time.Millisecond
	})

	done := make(chan *http.Response, 1)
	go func() {
		request, _ := http.NewRequest(http.MethodPost, server.URL+"/v1/messages",
			strings.NewReader(`{"model":"claude-sonnet-4-5","stream":true,"max_tokens":16,"messages":[]}`))
		request.Header.Set("Authorization", "Bearer sk-galaxy-test")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Errorf("消费者请求失败: %v", err)
			close(done)
			return
		}
		done <- response
	}()

	unit := <-service.submitted
	// 节点领走了活，然后就没有然后了。

	select {
	case response := <-done:
		if response == nil {
			t.Fatal("消费者没拿到响应")
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusBadGateway {
			t.Fatalf("节点失联应给 502，实际 %d", response.StatusCode)
		}
		body, _ := io.ReadAll(response.Body)
		if !strings.Contains(string(body), contract.CodeNodeOffline) {
			t.Fatalf("错误体要说清是节点掉线: %s", body)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("消费者被挂死了 —— 这正是这条用例要防的")
	}

	// 预留的额度与并发得还回去。少了这一步，那台机器每失联一次
	// 就永久少一个并发位，最后谁都派不进去。
	select {
	case cause := <-service.failed:
		if cause == nil || cause.Code != contract.CodeNodeOffline {
			t.Fatalf("应以节点掉线收口: %+v", cause)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Hub 判定的失败没有 FailUnit，预留没人还")
	}
	select {
	case abandoned := <-service.abandoned:
		if abandoned != unit.ID {
			t.Fatalf("cancel 下发错了单元: %s", abandoned)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("节点可能只是慢，cancel 要发出去让它别再烧上游额度")
	}
}

func TestConsumerGetsErrorWhenNodeGoesOfflineBeforeFirstByte(t *testing.T) {
	server, service := newHubWith(t, func(deps *corepkg.Deps) {
		deps.AttachTimeout = time.Hour // 只测心跳这条路
		deps.NodeProbeInterval = 30 * time.Millisecond
	})

	done := make(chan *http.Response, 1)
	go func() {
		request, _ := http.NewRequest(http.MethodPost, server.URL+"/v1/messages",
			strings.NewReader(`{"model":"claude-sonnet-4-5","stream":true,"max_tokens":16,"messages":[]}`))
		request.Header.Set("Authorization", "Bearer sk-galaxy-test")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Errorf("消费者请求失败: %v", err)
			close(done)
			return
		}
		done <- response
	}()

	<-service.submitted
	// 机器断网：TCP 上没有任何动静，先断的是心跳。
	service.mu.Lock()
	service.alive = false
	service.mu.Unlock()

	select {
	case response := <-done:
		if response == nil {
			t.Fatal("消费者没拿到响应")
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusBadGateway {
			t.Fatalf("节点失联应给 502，实际 %d", response.StatusCode)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("心跳断了消费者仍被挂死")
	}
}
