package agent_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"contract"
	"galaxy-hub-api/pkg/agent"
	"service/galaxy"
	"service/galaxy/dto"
)

// bannedGalaxy 鉴权放行、hello 才认出被封的机器：解绑重配出来的新记录就是这个样子。
type bannedGalaxy struct {
	// 只实现 hello 这条路要用的。没实现的被调到会 panic。
	galaxy.Service
}

func (bannedGalaxy) Config() galaxy.Config { return galaxy.DefaultConfig() }

func (bannedGalaxy) AuthenticateNode(context.Context, string) (galaxy.NodeIdentity, error) {
	return galaxy.NodeIdentity{NodeID: "n_repaired", OwnerUserID: "u_1"}, nil
}

func (bannedGalaxy) Hello(context.Context, dto.HelloRequest) (dto.HelloResult, error) {
	return dto.HelloResult{}, contract.ErrNodeBanned
}

// TestHelloOnBannedMachineAnswersLikeTheAuthGate 被封的机器在 hello 被认出来时，回应要和鉴权拦下
// 封禁节点一模一样：401 node_unauthorized。落进兜底的 400「请求体不合法」的话，主人只会以为
// 是客户端版本不对，去升级、重装，而机器早就被封了。
func TestHelloOnBannedMachineAnswersLikeTheAuthGate(t *testing.T) {
	engine := gin.New()
	agent.NewHandler(bannedGalaxy{}, nil, nil, time.Second, nil).RegisterHandler(engine.Group("/agent/v1"))

	request := httptest.NewRequest(http.MethodPost, "/agent/v1/hello", strings.NewReader(`{"contract":1}`))
	request.Header.Set("Authorization", "Bearer gnt_repaired")
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)

	var body struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(recorder.Body.Bytes(), &body)
	if recorder.Code != http.StatusUnauthorized || body.Code != "node_unauthorized" {
		t.Fatalf("期望 401 node_unauthorized，实际 %d %s", recorder.Code, recorder.Body.String())
	}
	if body.Message != contract.ErrNodeBanned.Error() {
		t.Fatalf("要告诉主人是被平台停用了，实际 %q", body.Message)
	}
}
