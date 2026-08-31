// Package remote contains server-side clients for external services.
package remote

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
	"time"

	"service/business/dto"
)

const (
	kodesConversationPath = "/v1/codex/conversation"
	kodesAttachmentsPath  = "/v1/codex/business-attachments"
	kodesAttachmentPath   = "/v1/codex/business-attachment"
	// 业务访谈默认走中等推理强度：业务方说的是原始诉求，追问和澄清足够用，
	// 不配置也不该退化成远端 Codex 当时的默认值。
	defaultReasoningEffort = "medium"
)

// BusinessAssistant adapts the remote Kodes conversation protocol for the
// business-intake domain. Kodes has the same route and payload shape as the
// local delivery plugin; only the target is a configured remote URL.
//
// workspace is an identifier understood by remote Kodes. The business service
// builds it from the authenticated business user and project, never from a
// browser or local machine path.
type BusinessAssistant struct {
	baseURL         string
	model           string
	reasoningEffort string
	timeout         time.Duration
	client          *http.Client
}

func NewBusinessAssistant(baseURL, model, reasoningEffort string, timeout time.Duration) *BusinessAssistant {
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	reasoningEffort = strings.TrimSpace(reasoningEffort)
	if reasoningEffort == "" {
		reasoningEffort = defaultReasoningEffort
	}
	return &BusinessAssistant{
		baseURL:         strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		model:           strings.TrimSpace(model),
		reasoningEffort: reasoningEffort,
		timeout:         timeout,
		client:          &http.Client{Timeout: timeout},
	}
}

type kodesAttachmentsResponse struct {
	Attachments []kodesAttachment `json:"attachments"`
	Error       json.RawMessage   `json:"error"`
}

type kodesAttachment struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	ContentType string `json:"contentType"`
	Size        int64  `json:"size"`
	IsImage     bool   `json:"isImage"`
}

type kodesConversationRequest struct {
	ProgramID       int64    `json:"programId"`
	ItemKey         string   `json:"itemKey"`
	Message         string   `json:"message"`
	ThreadID        string   `json:"threadId,omitempty"`
	AttachmentIDs   []string `json:"attachmentIds,omitempty"`
	BusinessIntake  bool     `json:"businessIntake"`
	Provider        string   `json:"provider"`
	Workspace       string   `json:"workspace"`
	Model           string   `json:"model,omitempty"`
	ReasoningEffort string   `json:"reasoningEffort,omitempty"`
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
	ID      string `json:"id"`
	Type    string `json:"type"`
	Text    string `json:"text"`
	Content string `json:"content"`
	Summary string `json:"summary"`
	Action  string `json:"action"`
	Target  string `json:"target"`
	Status  string `json:"status"`
	Phase   string `json:"phase"`
}

type kodesErrorResponse struct {
	Error json.RawMessage `json:"error"`
}

// Start mirrors the local Bridge's POST behaviour: create or continue a turn
// and return its cursor immediately. The business domain persists the user's
// statement before calling here, so a remote failure never loses that input.
func (assistant *BusinessAssistant) Start(ctx context.Context, req dto.ConversationStartRequest) (dto.ConversationAction, error) {
	if assistant.baseURL == "" {
		return dto.ConversationAction{}, errors.New("未配置远端 Kodes 业务访谈服务")
	}
	workspace := strings.TrimSpace(req.Workspace)
	if workspace == "" {
		return dto.ConversationAction{}, errors.New("缺少远端 Kodes 业务工作目录")
	}
	if req.RequirementID <= 0 {
		return dto.ConversationAction{}, errors.New("业务需求标识无效")
	}
	message := businessConversationMessage(req.Program, req.History, req.References)
	if message == "" {
		return dto.ConversationAction{}, errors.New("缺少业务方消息")
	}

	requestContext, cancel := context.WithTimeout(ctx, assistant.timeout)
	defer cancel()
	itemKey := businessItemKey(req.RequirementID)
	action, err := assistant.startConversation(requestContext, kodesConversationRequest{
		ProgramID:       req.Program.ProgramID,
		ItemKey:         itemKey,
		Message:         message,
		ThreadID:        strings.TrimSpace(req.ThreadID),
		AttachmentIDs:   req.AttachmentIDs,
		BusinessIntake:  true,
		Provider:        "codex",
		Workspace:       workspace,
		Model:           assistant.model,
		ReasoningEffort: assistant.reasoningEffort,
	})
	if err != nil {
		return dto.ConversationAction{}, err
	}
	if !action.Accepted {
		return dto.ConversationAction{}, errors.New("远端 Kodes 未接受业务访谈请求")
	}
	return dto.ConversationAction{
		ThreadID: strings.TrimSpace(action.ThreadID),
		TurnID:   strings.TrimSpace(action.TurnID),
		Active:   action.Active,
	}, nil
}

// Poll mirrors the local Bridge's GET behaviour. It reads one snapshot only;
// browser-driven polling decides when the next request should happen.
func (assistant *BusinessAssistant) Poll(ctx context.Context, programID, requirementID int64, threadID, turnID, workspace string) (dto.ConversationState, error) {
	if assistant.baseURL == "" {
		return dto.ConversationState{}, errors.New("未配置远端 Kodes 业务访谈服务")
	}
	workspace = strings.TrimSpace(workspace)
	if workspace == "" {
		return dto.ConversationState{}, errors.New("缺少远端 Kodes 业务工作目录")
	}
	if programID <= 0 || requirementID <= 0 || strings.TrimSpace(threadID) == "" || strings.TrimSpace(turnID) == "" {
		return dto.ConversationState{}, errors.New("远端业务访谈会话标识无效")
	}
	requestContext, cancel := context.WithTimeout(ctx, assistant.timeout)
	defer cancel()
	conversation, err := assistant.getConversation(requestContext, programID, businessItemKey(requirementID), strings.TrimSpace(threadID), workspace)
	if err != nil {
		return dto.ConversationState{}, err
	}
	state := conversation.stateFor(strings.TrimSpace(turnID))
	if state.ThreadID == "" {
		state.ThreadID = strings.TrimSpace(threadID)
	}
	return state, nil
}

// UploadAttachments stores browser files in the requirement's remote business
// workspace and returns the manifests remote Kodes assigned to them.
func (assistant *BusinessAssistant) UploadAttachments(ctx context.Context, programID, requirementID int64, workspace string, files []dto.AttachmentUpload) ([]dto.AttachmentView, error) {
	if assistant.baseURL == "" {
		return nil, errors.New("未配置远端 Kodes 业务访谈服务")
	}
	workspace = strings.TrimSpace(workspace)
	if workspace == "" {
		return nil, errors.New("缺少远端 Kodes 业务工作目录")
	}
	if len(files) == 0 {
		return nil, errors.New("没有待上传的文件")
	}
	body := &bytes.Buffer{}
	form := multipart.NewWriter(body)
	fields := map[string]string{
		"programId": fmt.Sprintf("%d", programID),
		"itemKey":   businessItemKey(requirementID),
		"workspace": workspace,
	}
	for name, value := range fields {
		if err := form.WriteField(name, value); err != nil {
			return nil, err
		}
	}
	for _, file := range files {
		part, err := form.CreateFormFile("files", file.Name)
		if err != nil {
			return nil, err
		}
		if _, err := part.Write(file.Data); err != nil {
			return nil, err
		}
	}
	if err := form.Close(); err != nil {
		return nil, err
	}
	requestContext, cancel := context.WithTimeout(ctx, assistant.timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, http.MethodPost, assistant.baseURL+kodesAttachmentsPath, body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", form.FormDataContentType())
	response, err := assistant.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("远端 Kodes 业务访谈服务不可用: %w", err)
	}
	defer response.Body.Close()
	content, err := readKodesResponse(response)
	if err != nil {
		return nil, err
	}
	var uploaded kodesAttachmentsResponse
	if err := json.Unmarshal(content, &uploaded); err != nil {
		return nil, fmt.Errorf("远端 Kodes 附件返回格式无效: %w", err)
	}
	if message := errorMessage(uploaded.Error); message != "" {
		return nil, fmt.Errorf("远端 Kodes 请求失败: %s", message)
	}
	views := make([]dto.AttachmentView, 0, len(uploaded.Attachments))
	for _, attachment := range uploaded.Attachments {
		id := strings.TrimSpace(attachment.ID)
		if id == "" {
			return nil, errors.New("远端 Kodes 未返回附件标识")
		}
		views = append(views, dto.AttachmentView{
			ID: id, Name: attachment.Name, ContentType: attachment.ContentType,
			Size: attachment.Size, IsImage: attachment.IsImage,
		})
	}
	return views, nil
}

// DownloadAttachment reads one stored file back for the console preview.
func (assistant *BusinessAssistant) DownloadAttachment(ctx context.Context, programID, requirementID int64, workspace, attachmentID string) (dto.AttachmentContent, error) {
	if assistant.baseURL == "" {
		return dto.AttachmentContent{}, errors.New("未配置远端 Kodes 业务访谈服务")
	}
	workspace = strings.TrimSpace(workspace)
	attachmentID = strings.TrimSpace(attachmentID)
	if workspace == "" || attachmentID == "" {
		return dto.AttachmentContent{}, errors.New("远端业务访谈附件标识无效")
	}
	query := url.Values{
		"programId":    {fmt.Sprintf("%d", programID)},
		"itemKey":      {businessItemKey(requirementID)},
		"workspace":    {workspace},
		"attachmentId": {attachmentID},
	}
	requestContext, cancel := context.WithTimeout(ctx, assistant.timeout)
	defer cancel()
	response, err := assistant.request(requestContext, http.MethodGet, assistant.baseURL+kodesAttachmentPath+"?"+query.Encode(), nil)
	if err != nil {
		return dto.AttachmentContent{}, err
	}
	defer response.Body.Close()
	content, err := readKodesResponse(response)
	if err != nil {
		return dto.AttachmentContent{}, err
	}
	return dto.AttachmentContent{
		ContentType: strings.TrimSpace(response.Header.Get("Content-Type")),
		Data:        content,
	}, nil
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

func (assistant *BusinessAssistant) getConversation(ctx context.Context, programID int64, itemKey, threadID, workspace string) (kodesConversation, error) {
	query := url.Values{
		"programId":      {fmt.Sprintf("%d", programID)},
		"itemKey":        {itemKey},
		"provider":       {"codex"},
		"workspace":      {workspace},
		"businessIntake": {"true"},
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

func (conversation kodesConversation) stateFor(turnID string) dto.ConversationState {
	state := dto.ConversationState{ThreadID: strings.TrimSpace(conversation.ThreadID), Active: conversation.Active}
	for index := len(conversation.Turns) - 1; index >= 0; index-- {
		turn := conversation.Turns[index]
		if turnID != "" && turn.ID != turnID {
			continue
		}
		if strings.EqualFold(turn.Status, "failed") {
			state.Finished = true
			state.Failed = true
			return state
		}
		replyIndex := -1
		for itemIndex := len(turn.Items) - 1; itemIndex >= 0; itemIndex-- {
			item := turn.Items[itemIndex]
			if item.Type != "agentMessage" && item.Type != "plan" {
				continue
			}
			content := strings.TrimSpace(firstNonEmpty(item.Text, item.Content, item.Summary))
			if content == "" {
				continue
			}
			state.Reply = content
			state.Finished = !conversation.Active
			replyIndex = itemIndex
			break
		}
		// Progress is read from the same snapshot as the reply: the business
		// browser polls this API while the turn runs and has no other way to
		// see what the remote assistant is doing.
		state.Activities = turn.activities(replyIndex)
		if replyIndex >= 0 {
			return state
		}
		if !conversation.Active && (strings.EqualFold(turn.Status, "completed") || strings.EqualFold(turn.Status, "cancelled") || strings.EqualFold(turn.Status, "interrupted")) {
			state.Finished = true
			state.Failed = !strings.EqualFold(turn.Status, "completed")
		}
		return state
	}
	return state
}

// activities projects the turn's items into display-only progress steps,
// skipping the business user's own message and the item already reported as
// the reply.
func (turn kodesTurn) activities(replyIndex int) []dto.ConversationActivity {
	activities := make([]dto.ConversationActivity, 0, len(turn.Items))
	for index, item := range turn.Items {
		if index == replyIndex || item.Type == "userMessage" || item.Type == "" {
			continue
		}
		text := strings.TrimSpace(firstNonEmpty(item.Text, item.Content, item.Summary))
		if text == "" && strings.TrimSpace(item.Action) == "" {
			continue
		}
		activities = append(activities, dto.ConversationActivity{
			ID:     strings.TrimSpace(item.ID),
			Type:   item.Type,
			Text:   text,
			Action: strings.TrimSpace(item.Action),
			Target: strings.TrimSpace(item.Target),
			Status: strings.TrimSpace(item.Status),
			Phase:  strings.TrimSpace(item.Phase),
		})
	}
	if len(activities) == 0 {
		return nil
	}
	return activities
}

func businessConversationMessage(program dto.ProgramContext, history []dto.MessageView, references []dto.DocumentReference) string {
	for index := len(history) - 1; index >= 0; index-- {
		if history[index].Role != "user" || strings.TrimSpace(history[index].Content) == "" {
			continue
		}
		return businessSystemPrompt(program) + businessReferenceBlock(references) +
			"\n\n业务方本轮输入：\n" + strings.TrimSpace(history[index].Content)
	}
	return ""
}

// 一份被 @ 引用的文档整篇进提示词的上限。历史访谈整理通常几千字，
// 截断点放在这里，既保得住结论，也不会把单轮提示词撑爆。
const maxReferenceRunes = 8000

// businessReferenceBlock renders the documents the business user attached with
// @. They are explicitly labelled as reference material from other interviews
// so the assistant cites them instead of treating them as this turn's input.
func businessReferenceBlock(references []dto.DocumentReference) string {
	if len(references) == 0 {
		return ""
	}
	var builder strings.Builder
	builder.WriteString("\n\n业务方引用的既有资料（来自本项目其它访谈，仅供参考，不要当成本轮诉求）：")
	for _, reference := range references {
		content := strings.TrimSpace(reference.Content)
		if runes := []rune(content); len(runes) > maxReferenceRunes {
			content = string(runes[:maxReferenceRunes]) + "\n……（内容过长已截断）"
		}
		if content == "" {
			continue
		}
		builder.WriteString(fmt.Sprintf(
			"\n\n【%s · %s（第 %d 版）】\n%s",
			strings.TrimSpace(reference.RequirementTitle), strings.TrimSpace(reference.Title), reference.Version, content,
		))
	}
	return builder.String()
}

// businessItemKey is the conversation identity remote Kodes stores a business
// intake thread and its attachments under.
func businessItemKey(requirementID int64) string {
	return fmt.Sprintf("business-requirement-%d", requirementID)
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
