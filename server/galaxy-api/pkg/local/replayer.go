package local

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"service/galaxy"
)

// ShadowReplayer 用 Hub 自己的 API key 把一次请求原样重放一遍，供抽检比对。
//
// 用的必须是平台自己的账号：拿被查那个提供者的凭据去重放，等于让被查的人自证清白。
// 没配 Hub 账号时构造函数返回 nil，抽检整体关闭 —— 宁可不查，也不能查出个假结论。
type ShadowReplayer struct {
	anthropic upstream
	openai    upstream
	client    *http.Client
}

type upstream struct {
	baseURL string
	apiKey  string
	// version 是 Anthropic 要求的 anthropic-version 头。
	version string
}

// NewShadowReplayer 读 Hub 自有账号配置。property 是 httpx.Property。
func NewShadowReplayer(property func(string) string) *ShadowReplayer {
	replayer := &ShadowReplayer{
		anthropic: upstream{
			baseURL: strings.TrimRight(defaultString(property("galaxy.audit.anthropic_base_url"), "https://api.anthropic.com/v1"), "/"),
			apiKey:  strings.TrimSpace(property("galaxy.audit.anthropic_api_key")),
			version: defaultString(property("galaxy.audit.anthropic_version"), "2023-06-01"),
		},
		openai: upstream{
			baseURL: strings.TrimRight(defaultString(property("galaxy.audit.openai_base_url"), "https://api.openai.com/v1"), "/"),
			apiKey:  strings.TrimSpace(property("galaxy.audit.openai_api_key")),
		},
		// 重放不该无限期挂着：它是后台任务，卡住一条就少查一条，比拖住整批强。
		client: &http.Client{Timeout: 3 * time.Minute},
	}
	if replayer.anthropic.apiKey == "" && replayer.openai.apiKey == "" {
		return nil
	}
	return replayer
}

func (r *ShadowReplayer) Replay(ctx context.Context, family, path string, body []byte) ([]byte, error) {
	target := r.anthropic
	if family == "openai" {
		target = r.openai
	}
	if target.apiKey == "" {
		return nil, fmt.Errorf("没有配置 %s 的 Hub 自有账号，跳过这次抽检", family)
	}
	if path == "" {
		path = "/v1/messages"
	}
	url := target.baseURL + strings.TrimPrefix(path, "/v1")

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("accept", "text/event-stream")
	if family == "openai" {
		request.Header.Set("authorization", "Bearer "+target.apiKey)
	} else {
		request.Header.Set("x-api-key", target.apiKey)
		request.Header.Set("anthropic-version", target.version)
	}

	response, err := r.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer func() { _ = response.Body.Close() }()
	// 只读前几百 KB：抽检比的是结构，整段读回来既没必要也可能很大。
	raw, err := io.ReadAll(io.LimitReader(response.Body, 512<<10))
	if err != nil {
		return nil, err
	}
	if response.StatusCode >= 400 {
		return nil, fmt.Errorf("重放被上游拒绝：%d", response.StatusCode)
	}
	return raw, nil
}

func defaultString(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

var _ galaxy.ShadowReplayer = (*ShadowReplayer)(nil)
