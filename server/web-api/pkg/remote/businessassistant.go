// Package remote contains server-side clients for external services.
package remote

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"service/business/dto"
)

const (
	kodesConversationPath = "/v1/codex/conversation"
	pollInterval          = 500 * time.Millisecond
)

// BusinessAssistant adapts the remote Kodes conversation protocol for the
// business-intake domain. Kodes has the same route and payload shape as the
// local delivery plugin; only the target is a configured remote URL.
//
// workspace is an identifier understood by remote Kodes. It is deliberately
// supplied from server configuration rather than a browser or local machine.
type BusinessAssistant struct {
	baseURL         string
	token           string
	workspace       string
	model           string
	reasoningEffort string
	timeout         time.Duration
	client          *http.Client
}

func NewBusinessAssistant(baseURL, token, workspace, model, reasoningEffort string, timeout time.Duration) *BusinessAssistant {
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	return &BusinessAssistant{
		baseURL:         strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		token:           strings.TrimSpace(token),
		workspace:       strings.TrimSpace(workspace),
		model:           strings.TrimSpace(model),
		reasoningEffort: strings.TrimSpace(reasoningEffort),
		timeout:         timeout,
		client:          &http.Client{Timeout: timeout},
	}
}

type kodesConversationRequest struct {
	ProgramID       int64  `json:"programId"`
	ItemKey         string `json:"itemKey"`
	Message         string `json:"message"`
	Provider        string `json:"provider"`
	Workspace       string `json:"workspace"`
	Model           string `json:"model,omitempty"`
	ReasoningEffort string `json:"reasoningEffort,omitempty"`
}

type kodesConversationAction struct {
	Accepted  bool   `json:"accepted"`
	ProgramID int64  `json:"programId"`
	ItemKey   string `json:"itemKey"`
	ThreadID  string `json:"threadId"`
	TurnID    string `json:"turnId"`
	Active    bool   `json:"active"`
}

type kodesConversation struct {
	ThreadID string          `json:"threadId"`
	Active   bool            `json:"active"`
	Turns    []kodesTurn     `json:"turns"`
	Error    json.RawMessage `json:"error"`
}

type kodesTurn struct {
	ID     string      `json:"id"`
	Status string      `json:"status"`
	Items  []kodesItem `json:"items"`
}

type kodesItem struct {
	Type    string `json:"type"`
	Text    string `json:"text"`
	Content string `json:"content"`
	Summary string `json:"summary"`
	Phase   string `json:"phase"`
}

type kodesErrorResponse struct {
	Error json.RawMessage `json:"error"`
}

// Reply starts a Kodes conversation turn, then reads the same conversation
// endpoint until the remote turn has completed. The business message remains
// stored locally before this call, so a remote failure never drops user input.
func (assistant *BusinessAssistant) Reply(ctx context.Context, program dto.ProgramContext, requirementID int64, history []dto.MessageView) (string, error) {
	if assistant.baseURL == "" {
		return "", errors.New("未配置远端 Kodes 业务访谈服务")
	}
	if assistant.workspace == "" {
		return "", errors.New("未配置远端 Kodes 工作区标识")
	}
	if requirementID <= 0 {
		return "", errors.New("业务需求标识无效")
	}
	message := businessConversationMessage(program, history)
	if message == "" {
		return "", errors.New("缺少业务方消息")
	}

	requestContext, cancel := context.WithTimeout(ctx, assistant.timeout)
	defer cancel()
	itemKey := fmt.Sprintf("business-requirement-%d", requirementID)
	action, err := assistant.startConversation(requestContext, kodesConversationRequest{
		ProgramID:       program.ProgramID,
		ItemKey:         itemKey,
		Message:         message,
		Provider:        "codex",
		Workspace:       assistant.workspace,
		Model:           assistant.model,
		ReasoningEffort: assistant.reasoningEffort,
	})
	if err != nil {
		return "", err
	}
	if !action.Accepted {
		return "", errors.New("远端 Kodes 未接受业务访谈请求")
	}
	threadID := strings.TrimSpace(action.ThreadID)
	for {
		conversation, err := assistant.getConversation(requestContext, program.ProgramID, itemKey, threadID)
		if err != nil {
			return "", err
		}
		if strings.TrimSpace(conversation.ThreadID) != "" {
			threadID = strings.TrimSpace(conversation.ThreadID)
		}
		if response, failed := conversation.replyFor(action.TurnID); response != "" && !conversation.Active {
			return response, nil
		} else if failed && !conversation.Active {
			return "", errors.New("远端 Kodes 未能完成业务访谈")
		}
		select {
		case <-requestContext.Done():
			return "", fmt.Errorf("等待远端 Kodes 业务访谈超时: %w", requestContext.Err())
		case <-time.After(pollInterval):
		}
	}
}

func (assistant *BusinessAssistant) startConversation(ctx context.Context, payload kodesConversationRequest) (kodesConversationAction, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return kodesConversationAction{}, err
	}
	response, err := assistant.request(ctx, http.MethodPost, assistant.conversationURL(), bytes.NewReader(body))
	if err != nil {
		return kodesConversationAction{}, err
	}
	defer response.Body.Close()
	content, err := readKodesResponse(response)
	if err != nil {
		return kodesConversationAction{}, err
	}
	var action kodesConversationAction
	if err := json.Unmarshal(content, &action); err != nil {
		return kodesConversationAction{}, fmt.Errorf("远端 Kodes 创建会话返回格式无效: %w", err)
	}
	return action, nil
}

func (assistant *BusinessAssistant) getConversation(ctx context.Context, programID int64, itemKey, threadID string) (kodesConversation, error) {
	query := url.Values{
		"programId": {fmt.Sprintf("%d", programID)},
		"itemKey":   {itemKey},
		"provider":  {"codex"},
		"workspace": {assistant.workspace},
	}
	if threadID != "" {
		query.Set("threadId", threadID)
	}
	endpoint := assistant.conversationURL() + "?" + query.Encode()
	response, err := assistant.request(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return kodesConversation{}, err
	}
	defer response.Body.Close()
	content, err := readKodesResponse(response)
	if err != nil {
		return kodesConversation{}, err
	}
	var conversation kodesConversation
	if err := json.Unmarshal(content, &conversation); err != nil {
		return kodesConversation{}, fmt.Errorf("远端 Kodes 会话返回格式无效: %w", err)
	}
	if message := errorMessage(conversation.Error); message != "" {
		return kodesConversation{}, fmt.Errorf("远端 Kodes 请求失败: %s", message)
	}
	return conversation, nil
}

func (assistant *BusinessAssistant) request(ctx context.Context, method, endpoint string, body io.Reader) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return nil, err
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if assistant.token != "" {
		// The local delivery Bridge uses this header too. It is an access token
		// for remote Kodes, not an end-user token forwarded from the browser.
		request.Header.Set("token", assistant.token)
	}
	response, err := assistant.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("远端 Kodes 业务访谈服务不可用: %w", err)
	}
	return response, nil
}

func (assistant *BusinessAssistant) conversationURL() string {
	if strings.HasSuffix(assistant.baseURL, kodesConversationPath) {
		return assistant.baseURL
	}
	return assistant.baseURL + kodesConversationPath
}

func readKodesResponse(response *http.Response) ([]byte, error) {
	content, err := io.ReadAll(io.LimitReader(response.Body, 2*1024*1024))
	if err != nil {
		return nil, err
	}
	if response.StatusCode >= http.StatusOK && response.StatusCode < http.StatusMultipleChoices {
		return content, nil
	}
	var failed kodesErrorResponse
	if err := json.Unmarshal(content, &failed); err == nil {
		if message := errorMessage(failed.Error); message != "" {
			return nil, fmt.Errorf("远端 Kodes 请求失败: %s", message)
		}
	}
	return nil, fmt.Errorf("远端 Kodes 请求失败: HTTP %d", response.StatusCode)
}

func (conversation kodesConversation) replyFor(turnID string) (string, bool) {
	for index := len(conversation.Turns) - 1; index >= 0; index-- {
		turn := conversation.Turns[index]
		if turnID != "" && turn.ID != turnID {
			continue
		}
		if strings.EqualFold(turn.Status, "failed") {
			return "", true
		}
		for itemIndex := len(turn.Items) - 1; itemIndex >= 0; itemIndex-- {
			item := turn.Items[itemIndex]
			if item.Type != "agentMessage" && item.Type != "plan" {
				continue
			}
			content := strings.TrimSpace(firstNonEmpty(item.Text, item.Content, item.Summary))
			if content == "" {
				continue
			}
			return content, false
		}
		if turnID != "" {
			return "", false
		}
	}
	return "", false
}

func businessConversationMessage(program dto.ProgramContext, history []dto.MessageView) string {
	for index := len(history) - 1; index >= 0; index-- {
		if history[index].Role != "user" || strings.TrimSpace(history[index].Content) == "" {
			continue
		}
		return businessSystemPrompt(program) + "\n\n业务方本轮输入：\n" + strings.TrimSpace(history[index].Content)
	}
	return ""
}

func errorMessage(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var message string
	if json.Unmarshal(raw, &message) == nil {
		return strings.TrimSpace(message)
	}
	var object struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &object) == nil {
		return strings.TrimSpace(object.Message)
	}
	return ""
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func businessSystemPrompt(program dto.ProgramContext) string {
	return fmt.Sprintf(`你是一位面向业务方的需求访谈顾问。用户不需要懂产品、研发或技术实现；请用清楚、友好的中文帮助其表达观点。

当前项目：%s（%s）
项目说明：%s

请围绕该项目理解用户的业务背景、问题、目标、受影响对象和预期结果。每次回答都先回应用户，再给出可执行的初步整理；信息不足时提出少量具体问题。可使用“已了解”“初步需求点”“待澄清”等简短小节。不要编造事实、不要承诺研发排期，也不要把内容写成产研任务或技术方案。你的回复会作为业务方原始观点的服务端文档，供后续产品产研继续梳理。`, program.Name, program.ProgramCode, program.Summary)
}
