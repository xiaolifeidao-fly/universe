package agent_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"galaxy-common/bootstrap"
	"galaxy-hub-api/pkg/agent"
	"service/galaxy"
	"service/galaxy/dto"
)

// drainGalaxy 只实现领活这条路要走的两个方法。Next 会一直挂着，
// 模拟真实的长轮询 —— 那正是优雅退出要处理的那种连接。
type drainGalaxy struct {
	galaxy.Service
	calls   atomic.Int32
	entered chan struct{}
}

func (d *drainGalaxy) Config() galaxy.Config { return galaxy.DefaultConfig() }

func (d *drainGalaxy) AuthenticateNode(context.Context, string) (galaxy.NodeIdentity, error) {
	return galaxy.NodeIdentity{NodeID: "n_test", OwnerUserID: "u_1"}, nil
}

func (d *drainGalaxy) Next(ctx context.Context, _ dto.NextRequest) (*dto.NextResult, error) {
	d.calls.Add(1)
	select {
	case d.entered <- struct{}{}:
	default:
	}
	<-ctx.Done()
	return nil, ctx.Err()
}

func drainEngine(t *testing.T) (*drainGalaxy, *bootstrap.Drain, *gin.Engine) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	service := &drainGalaxy{entered: make(chan struct{}, 1)}
	drain := bootstrap.NewDrain()
	engine := gin.New()
	agent.NewHandler(service, nil, nil, time.Second, nil, drain).RegisterHandler(engine.Group("/agent/v1"))
	return service, drain, engine
}

func nextRequest() *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/agent/v1/next", strings.NewReader(`{}`))
	request.Header.Set("Authorization", "Bearer gnt_test")
	request.Header.Set("Content-Type", "application/json")
	return request
}

// 退出已经开始时，领活要当场回 204，而且根本不该去碰控制面。
// 这一步是优雅退出里最要紧的那条：这时候还发活出去，节点领了却推不回来 ——
// 监听马上就关了 —— 对消费者就是一次白跑的失败请求。
func TestNextRefusesNewWorkWhileDraining(t *testing.T) {
	service, drain, engine := drainEngine(t)
	drain.Begin()

	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, nextRequest())

	if recorder.Code != http.StatusNoContent {
		t.Fatalf("领活应当回 204，实际 %d：%s", recorder.Code, recorder.Body.String())
	}
	if calls := service.calls.Load(); calls != 0 {
		t.Fatalf("退出期间不该再去控制面领活，实际调用 %d 次", calls)
	}
}

// 已经挂在长轮询上的那些也要被叫醒，而且收到的是 204 不是 500：
// 节点拿 500 会进重试退避，拿 204 则立刻换一台再来。
func TestNextWakesUpInFlightPollWithNoContent(t *testing.T) {
	service, drain, engine := drainEngine(t)

	recorder := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		engine.ServeHTTP(recorder, nextRequest())
	}()

	select {
	case <-service.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("长轮询没能挂到控制面上")
	}
	drain.Begin()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("退出开始后长轮询没有被叫醒")
	}
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("被叫醒的长轮询应当回 204，实际 %d：%s", recorder.Code, recorder.Body.String())
	}
}
