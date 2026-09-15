package core

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"contract"
	"service/galaxy"
	"service/galaxy/dto"
)

// keyRecorder 只实现鉴权：记下 Hub 最终拿去校验的那个串。
type keyRecorder struct {
	galaxy.Service
	secret string
}

func (k *keyRecorder) AuthenticateKey(_ context.Context, secret string) (dto.Caller, error) {
	k.secret = strings.TrimPrefix(strings.TrimSpace(secret), "Bearer ")
	if !strings.HasPrefix(k.secret, consumerKeyPrefix) {
		return dto.Caller{}, contract.NewUnitError(contract.ErrorClassBilling, contract.CodeKeyInvalid, false, "密钥不存在或已吊销")
	}
	return dto.Caller{KeyID: "ck_test"}, nil
}

func consumerProbe(t *testing.T, headers map[string]string) (*keyRecorder, int) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := &keyRecorder{}
	engine := gin.New()
	engine.POST("/v1/messages", RequireConsumerKey(recorder), func(context *gin.Context) {
		context.String(http.StatusOK, CallerFrom(context).KeyID)
	})
	request := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, request)
	return recorder, response.Code
}

// 已登录的 Claude Code 会用自己的 OAuth token 占住 Authorization，算力密钥只能借
// ANTHROPIC_CUSTOM_HEADERS 从自定义头带过来。这时 Hub 必须认自定义头里的那把。
func TestConsumerKeyPrefersGalaxyKeyOverForeignBearer(t *testing.T) {
	recorder, status := consumerProbe(t, map[string]string{
		"Authorization": "Bearer sk-ant-oat01-claude-code-own-token",
		"X-Galaxy-Key":  "sk-galaxy-from-custom-header",
	})
	if status != http.StatusOK || recorder.secret != "sk-galaxy-from-custom-header" {
		t.Fatalf("应采用 X-Galaxy-Key 里的算力密钥: status=%d secret=%q", status, recorder.secret)
	}
}

// 官方 SDK 发的是 x-api-key；Authorization 缺席时也要能用。
func TestConsumerKeyAcceptsXAPIKey(t *testing.T) {
	recorder, status := consumerProbe(t, map[string]string{"x-api-key": "sk-galaxy-from-sdk"})
	if status != http.StatusOK || recorder.secret != "sk-galaxy-from-sdk" {
		t.Fatalf("应采用 x-api-key: status=%d secret=%q", status, recorder.secret)
	}
}

// 原有写法不变：Authorization: Bearer sk-galaxy-…。
func TestConsumerKeyStillAcceptsBearer(t *testing.T) {
	recorder, status := consumerProbe(t, map[string]string{"Authorization": "Bearer sk-galaxy-plain"})
	if status != http.StatusOK || recorder.secret != "sk-galaxy-plain" {
		t.Fatalf("Bearer 写法应照常可用: status=%d secret=%q", status, recorder.secret)
	}
}

// 一个都不像算力密钥：把第一个非空的交给校验，得到「密钥不存在」而不是「缺少密钥」。
func TestConsumerKeyFallsBackToFirstCandidate(t *testing.T) {
	recorder, status := consumerProbe(t, map[string]string{"Authorization": "Bearer sk-ant-only"})
	if status != http.StatusUnauthorized || recorder.secret != "sk-ant-only" {
		t.Fatalf("不像算力密钥时应交给校验并被拒: status=%d secret=%q", status, recorder.secret)
	}
	_, status = consumerProbe(t, nil)
	if status == http.StatusOK {
		t.Fatal("没有任何密钥不该放行")
	}
}
