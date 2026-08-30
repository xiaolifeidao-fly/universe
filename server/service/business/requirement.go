package business

import (
	"context"
	"errors"
	"strings"
	"time"

	"contract"
	"service/business/dto"
	"service/business/internal/repository"
)

const untitledRequirement = "未命名业务诉求"

// ListPrograms returns the deliberately small project context that a business
// user needs before starting a conversation. It does not disclose delivery
// configuration such as repositories, branches, or cloud-sync settings.
func (s *service) ListPrograms(ctx context.Context, bizLine contract.BizLine) ([]dto.ProgramContext, error) {
	if !bizLine.Valid() {
		return nil, contract.ErrBizLineRequired
	}
	if s.programs == nil {
		return nil, errors.New("项目校验服务尚未初始化")
	}
	return s.programs.ListProgramContexts(ctx, bizLine)
}

func (s *service) ListRequirements(ctx context.Context, query dto.RequirementQuery) (dto.RequirementPage, error) {
	if !query.BizLine.Valid() {
		return dto.RequirementPage{}, contract.ErrBizLineRequired
	}
	if strings.TrimSpace(query.CreatorID) == "" {
		return dto.RequirementPage{}, errors.New("缺少业务需求提交人")
	}
	rows, total, err := s.repo.ListRequirements(ctx, repository.RequirementQuery{
		BizLine: query.BizLine.String(), CreatorID: strings.TrimSpace(query.CreatorID), Offset: query.Offset(), Limit: query.Limit(),
	})
	if err != nil {
		return dto.RequirementPage{}, err
	}
	views := make([]dto.RequirementView, 0, len(rows))
	for _, row := range rows {
		views = append(views, toRequirementView(row))
	}
	return dto.RequirementPage{Total: total, Data: views}, nil
}

func (s *service) ListCollectedRequirements(ctx context.Context, query dto.CollectedRequirementQuery) (dto.RequirementPage, error) {
	if !query.BizLine.Valid() {
		return dto.RequirementPage{}, contract.ErrBizLineRequired
	}
	rows, total, err := s.repo.ListCollectedRequirements(ctx, repository.CollectedRequirementQuery{
		BizLine: query.BizLine.String(), Offset: query.Offset(), Limit: query.Limit(),
	})
	if err != nil {
		return dto.RequirementPage{}, err
	}
	views := make([]dto.RequirementView, 0, len(rows))
	for _, row := range rows {
		views = append(views, toRequirementView(row))
	}
	return dto.RequirementPage{Total: total, Data: views}, nil
}

func (s *service) CreateRequirement(ctx context.Context, req dto.CreateRequirementRequest) (dto.RequirementView, error) {
	if req.ProgramID <= 0 {
		return dto.RequirementView{}, errors.New("请选择要提交需求的项目")
	}
	creatorID := strings.TrimSpace(req.CreatorID)
	if creatorID == "" {
		return dto.RequirementView{}, errors.New("缺少业务需求提交人")
	}
	if s.programs == nil {
		return dto.RequirementView{}, errors.New("项目校验服务尚未初始化")
	}
	bizLine, err := s.programs.ResolveProgramBizLine(ctx, req.ProgramID)
	if err != nil {
		return dto.RequirementView{}, err
	}
	if !containsBizLine(req.AccessibleBizLines, bizLine.String()) {
		return dto.RequirementView{}, errors.New("无权向该项目提交业务需求")
	}
	row := &repository.BusinessRequirement{
		BizLine:       bizLine.String(),
		ProgramID:     req.ProgramID,
		Title:         untitledRequirement,
		Detail:        "",
		Status:        RequirementStatusSubmitted,
		CreatedBy:     creatorID,
		CreatedByName: strings.TrimSpace(req.CreatorName),
	}
	if err := s.repo.CreateRequirement(ctx, row); err != nil {
		return dto.RequirementView{}, err
	}
	return toRequirementView(row), nil
}

func (s *service) GetConversation(ctx context.Context, query dto.ConversationQuery) (dto.ConversationView, error) {
	if !query.BizLine.Valid() {
		return dto.ConversationView{}, contract.ErrBizLineRequired
	}
	if query.RequirementID <= 0 || strings.TrimSpace(query.CreatorID) == "" {
		return dto.ConversationView{}, errors.New("缺少业务需求标识或提交人")
	}
	requirement, err := s.repo.FindRequirement(ctx, query.BizLine.String(), query.RequirementID, strings.TrimSpace(query.CreatorID))
	if err != nil {
		return dto.ConversationView{}, err
	}
	if s.programs == nil {
		return dto.ConversationView{}, errors.New("项目校验服务尚未初始化")
	}
	program, err := s.programs.GetProgramContext(ctx, query.BizLine, requirement.ProgramID)
	if err != nil {
		return dto.ConversationView{}, err
	}
	messages, err := s.repo.ListMessages(ctx, query.BizLine.String(), query.RequirementID)
	if err != nil {
		return dto.ConversationView{}, err
	}
	documents, err := s.repo.ListDocuments(ctx, query.BizLine.String(), query.RequirementID)
	if err != nil {
		return dto.ConversationView{}, err
	}
	return dto.ConversationView{
		Requirement: toRequirementView(requirement), Program: program,
		Messages: toMessageViews(messages), Documents: toDocumentViews(documents),
	}, nil
}

// GetCollectedConversation exposes the business user's raw viewpoint,
// interview messages, and AI documents to product/research. It deliberately
// does not modify the business intake or create a delivery requirement.
func (s *service) GetCollectedConversation(ctx context.Context, query dto.CollectedConversationQuery) (dto.ConversationView, error) {
	if !query.BizLine.Valid() {
		return dto.ConversationView{}, contract.ErrBizLineRequired
	}
	if query.RequirementID <= 0 {
		return dto.ConversationView{}, errors.New("缺少业务需求标识")
	}
	requirement, err := s.repo.FindCollectedRequirement(ctx, query.BizLine.String(), query.RequirementID)
	if err != nil {
		return dto.ConversationView{}, err
	}
	if s.programs == nil {
		return dto.ConversationView{}, errors.New("项目校验服务尚未初始化")
	}
	program, err := s.programs.GetProgramContext(ctx, query.BizLine, requirement.ProgramID)
	if err != nil {
		return dto.ConversationView{}, err
	}
	messages, err := s.repo.ListMessages(ctx, query.BizLine.String(), query.RequirementID)
	if err != nil {
		return dto.ConversationView{}, err
	}
	documents, err := s.repo.ListDocuments(ctx, query.BizLine.String(), query.RequirementID)
	if err != nil {
		return dto.ConversationView{}, err
	}
	return dto.ConversationView{
		Requirement: toRequirementView(requirement), Program: program,
		Messages: toMessageViews(messages), Documents: toDocumentViews(documents),
	}, nil
}

// SendMessage persists the business user's statement before making the remote
// call. A temporary remote outage therefore never loses the user's input.
func (s *service) SendMessage(ctx context.Context, req dto.SendMessageRequest) (dto.SendMessageResult, error) {
	if !req.BizLine.Valid() {
		return dto.SendMessageResult{}, contract.ErrBizLineRequired
	}
	if req.RequirementID <= 0 || strings.TrimSpace(req.CreatorID) == "" {
		return dto.SendMessageResult{}, errors.New("缺少业务需求标识或提交人")
	}
	content := strings.TrimSpace(req.Content)
	if content == "" {
		return dto.SendMessageResult{}, errors.New("请输入想法或问题")
	}
	if len([]rune(content)) > 16000 {
		return dto.SendMessageResult{}, errors.New("单条消息不能超过 16000 个字符")
	}
	if s.programs == nil || s.assistant == nil {
		return dto.SendMessageResult{}, errors.New("远端业务访谈服务尚未初始化")
	}
	requirement, err := s.repo.FindRequirement(ctx, req.BizLine.String(), req.RequirementID, strings.TrimSpace(req.CreatorID))
	if err != nil {
		return dto.SendMessageResult{}, err
	}
	program, err := s.programs.GetProgramContext(ctx, req.BizLine, requirement.ProgramID)
	if err != nil {
		return dto.SendMessageResult{}, err
	}
	userRow := &repository.BusinessRequirementMessage{
		BizLine: req.BizLine.String(), RequirementID: requirement.ID, Role: "user", Content: content,
	}
	if err := s.repo.CreateMessage(ctx, userRow); err != nil {
		return dto.SendMessageResult{}, err
	}
	messages, err := s.repo.ListMessages(ctx, req.BizLine.String(), requirement.ID)
	if err != nil {
		return dto.SendMessageResult{}, err
	}
	reply, err := s.assistant.Reply(ctx, program, requirement.ID, toMessageViews(messages))
	if err != nil {
		return dto.SendMessageResult{}, err
	}
	reply = strings.TrimSpace(reply)
	if reply == "" {
		return dto.SendMessageResult{}, errors.New("远端 AI 没有返回可用内容")
	}
	if len([]rune(reply)) > 64000 {
		return dto.SendMessageResult{}, errors.New("远端 AI 返回内容过长")
	}
	assistantRow := &repository.BusinessRequirementMessage{
		BizLine: req.BizLine.String(), RequirementID: requirement.ID, Role: "assistant", Content: reply,
	}
	if err := s.repo.CreateMessage(ctx, assistantRow); err != nil {
		return dto.SendMessageResult{}, err
	}
	documents, err := s.repo.ListDocuments(ctx, req.BizLine.String(), requirement.ID)
	if err != nil {
		return dto.SendMessageResult{}, err
	}
	version := 1
	if len(documents) > 0 {
		version = documents[0].Version + 1
	}
	title := requirement.Title
	if title == untitledRequirement {
		title = titleFromMessage(content)
	}
	documentRow := &repository.BusinessRequirementDocument{
		BizLine: req.BizLine.String(), RequirementID: requirement.ID, Type: "ai_intake",
		Title: "AI 访谈整理 · " + title, Content: reply, Version: version,
	}
	if err := s.repo.CreateDocument(ctx, documentRow); err != nil {
		return dto.SendMessageResult{}, err
	}
	if err := s.repo.UpdateRequirementSummary(ctx, requirement.ID, title, reply); err != nil {
		return dto.SendMessageResult{}, err
	}
	return dto.SendMessageResult{
		UserMessage: toMessageView(userRow), AssistantMessage: toMessageView(assistantRow), Document: toDocumentView(documentRow),
	}, nil
}

func containsBizLine(values []string, target string) bool {
	for _, value := range values {
		if strings.TrimSpace(value) == target {
			return true
		}
	}
	return false
}

func toRequirementView(row *repository.BusinessRequirement) dto.RequirementView {
	return dto.RequirementView{
		ID: row.ID, BizLine: row.BizLine, ProgramID: row.ProgramID, Title: row.Title, Detail: row.Detail,
		Status: row.Status, CreatedBy: row.CreatedBy, CreatedByName: row.CreatedByName,
		CreatedAt: timePtr(row.CreatedTime), UpdatedAt: timePtr(row.UpdatedTime),
	}
}

func toMessageViews(rows []*repository.BusinessRequirementMessage) []dto.MessageView {
	views := make([]dto.MessageView, 0, len(rows))
	for _, row := range rows {
		views = append(views, toMessageView(row))
	}
	return views
}

func toMessageView(row *repository.BusinessRequirementMessage) dto.MessageView {
	return dto.MessageView{ID: row.ID, Role: row.Role, Content: row.Content, CreatedAt: timePtr(row.CreatedTime)}
}

func toDocumentViews(rows []*repository.BusinessRequirementDocument) []dto.DocumentView {
	views := make([]dto.DocumentView, 0, len(rows))
	for _, row := range rows {
		views = append(views, toDocumentView(row))
	}
	return views
}

func toDocumentView(row *repository.BusinessRequirementDocument) dto.DocumentView {
	return dto.DocumentView{
		ID: row.ID, Type: row.Type, Title: row.Title, Content: row.Content, Version: row.Version, CreatedAt: timePtr(row.CreatedTime),
	}
}

func titleFromMessage(value string) string {
	value = strings.TrimSpace(strings.Split(value, "\n")[0])
	runes := []rune(value)
	if len(runes) > 60 {
		return string(runes[:60]) + "…"
	}
	if value == "" {
		return untitledRequirement
	}
	return value
}

func timePtr(value time.Time) *time.Time { return &value }
