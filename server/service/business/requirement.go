package business

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"contract"
	"service/business/dto"
	"service/business/internal/repository"
)

const untitledRequirement = "未命名业务诉求"

// 两种文档标题：一份是访谈过程中每轮自动沉淀的整理，一份是业务方点「确认文档」
// 后产出的正式诉求文档。它们共用同一条版本线，靠标题区分，翻版本时一眼能认出
// 哪一版是业务方自己确认要落地的那份。
const (
	interviewDocumentTitlePrefix = "AI 访谈整理 · "
	confirmedDocumentTitlePrefix = "业务诉求文档 · "
)

// 业务方点「确认文档」时替他说的那句话。它照常落成一条 user 消息：对话里必须
// 看得出这一版文档是谁、在哪一步要求产出的，否则文档会像凭空冒出来。
const confirmDocumentStatement = "【确认文档】请不要再追问，基于目前对话把我的业务诉求整理成一份完整的文档。"

const (
	// 与远端桥的上限保持一致：桥按同样的数量和大小拒收，服务端先挡一道，
	// 免得把注定失败的上传原样转发出去。
	maxMessageAttachments = 5
	maxAttachmentBytes    = 20 * 1024 * 1024
	// 一条消息里能 @ 的历史文档数。整篇文档都会进提示词，引多了会把业务方
	// 本轮真正想说的话淹没在旧材料里。
	maxMessageReferences = 5
)

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
	return dto.RequirementPage{Total: total, Data: s.withProgramNames(ctx, query.BizLine, views)}, nil
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
	return dto.RequirementPage{Total: total, Data: s.withProgramNames(ctx, query.BizLine, views)}, nil
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
	program, err := s.programs.GetProgramContext(ctx, bizLine, req.ProgramID)
	if err != nil {
		return dto.RequirementView{}, err
	}
	workspace, err := businessWorkspace(req.CreatorUsername, program)
	if err != nil {
		return dto.RequirementView{}, err
	}
	row := &repository.BusinessRequirement{
		BizLine:         bizLine.String(),
		ProgramID:       req.ProgramID,
		Title:           untitledRequirement,
		Detail:          "",
		Status:          RequirementStatusSubmitted,
		CreatedBy:       creatorID,
		CreatedByName:   strings.TrimSpace(req.CreatorName),
		RemoteWorkspace: workspace,
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
	return s.conversation(ctx, requirement, program)
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
	return s.conversation(ctx, requirement, program)
}

// ListDocumentReferences offers the business user the interview documents that
// already exist in the same project, so a new conversation can point at earlier
// conclusions with @ instead of restating them.
func (s *service) ListDocumentReferences(ctx context.Context, query dto.DocumentReferenceQuery) ([]dto.DocumentReferenceView, error) {
	if !query.BizLine.Valid() {
		return nil, contract.ErrBizLineRequired
	}
	if query.RequirementID <= 0 || strings.TrimSpace(query.CreatorID) == "" {
		return nil, errors.New("缺少业务需求标识或提交人")
	}
	requirement, err := s.repo.FindRequirement(ctx, query.BizLine.String(), query.RequirementID, strings.TrimSpace(query.CreatorID))
	if err != nil {
		return nil, err
	}
	rows, err := s.repo.ListProgramDocuments(ctx, repository.ProgramDocumentQuery{
		BizLine: query.BizLine.String(), ProgramID: requirement.ProgramID, CreatorID: requirement.CreatedBy,
		ExcludeRequirementID: requirement.ID, Keyword: strings.TrimSpace(query.Keyword),
	})
	if err != nil {
		return nil, err
	}
	views := make([]dto.DocumentReferenceView, 0, len(rows))
	for _, row := range rows {
		views = append(views, dto.DocumentReferenceView{
			DocumentID: row.ID, RequirementID: row.RequirementID, RequirementTitle: row.RequirementTitle,
			Title: row.Title, Version: row.Version, CreatedAt: timePtr(row.CreatedTime),
		})
	}
	return views, nil
}

// referencesFor resolves @-attached documents into prompt context. Unknown or
// out-of-project ids are dropped rather than rejected: the picker is a
// convenience, and a stale id must not block the business user's message.
func (s *service) referencesFor(ctx context.Context, bizLine string, programID int64, creatorID string, ids []int64) ([]dto.DocumentReference, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	if len(ids) > maxMessageReferences {
		return nil, fmt.Errorf("一条消息最多引用 %d 份文档", maxMessageReferences)
	}
	rows, err := s.repo.FindProgramDocuments(ctx, bizLine, programID, creatorID, ids)
	if err != nil {
		return nil, err
	}
	references := make([]dto.DocumentReference, 0, len(rows))
	for _, row := range rows {
		references = append(references, dto.DocumentReference{
			RequirementID: row.RequirementID, RequirementTitle: row.RequirementTitle,
			Title: row.Title, Version: row.Version, Content: row.Content,
		})
	}
	return references, nil
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
	mode, err := conversationModeOf(req.Mode)
	if err != nil {
		return dto.SendMessageResult{}, err
	}
	content := strings.TrimSpace(req.Content)
	if content == "" && mode != dto.ConversationModeDocument {
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
	if requirement.RemoteStatus == "running" {
		return dto.SendMessageResult{}, errors.New("AI 正在整理上一条业务诉求，请稍候")
	}
	if mode == dto.ConversationModeDocument {
		// 一句话都还没说就确认文档，AI 只能凭空编：先要求业务方把诉求讲出来。
		spoken, err := s.repo.ListMessages(ctx, req.BizLine.String(), requirement.ID)
		if err != nil {
			return dto.SendMessageResult{}, err
		}
		if !containsUserMessage(spoken) {
			return dto.SendMessageResult{}, errors.New("还没有可整理的内容，请先说明你的业务诉求")
		}
		content = confirmDocumentStatement + supplementOf(content)
	}
	program, err := s.programs.GetProgramContext(ctx, req.BizLine, requirement.ProgramID)
	if err != nil {
		return dto.SendMessageResult{}, err
	}
	attachmentIDs := trimmedIDs(req.AttachmentIDs)
	if len(attachmentIDs) > maxMessageAttachments {
		return dto.SendMessageResult{}, fmt.Errorf("一条消息最多携带 %d 个附件", maxMessageAttachments)
	}
	userRow := &repository.BusinessRequirementMessage{
		BizLine: req.BizLine.String(), RequirementID: requirement.ID, Role: "user", Content: content,
	}
	if err := s.repo.CreateMessage(ctx, userRow); err != nil {
		return dto.SendMessageResult{}, err
	}
	// Bind before the remote call: an attachment that cannot be bound is not
	// this user's to send, and the turn must not start with it.
	if err := s.repo.BindAttachmentsToMessage(ctx, req.BizLine.String(), requirement.ID, userRow.ID, attachmentIDs); err != nil {
		return dto.SendMessageResult{}, err
	}
	messages, err := s.repo.ListMessages(ctx, req.BizLine.String(), requirement.ID)
	if err != nil {
		return dto.SendMessageResult{}, err
	}
	workspace, err := s.requirementWorkspace(ctx, requirement, program, req.CreatorUsername)
	if err != nil {
		return dto.SendMessageResult{}, err
	}
	references, err := s.referencesFor(ctx, req.BizLine.String(), requirement.ProgramID, requirement.CreatedBy, req.ReferenceDocumentIDs)
	if err != nil {
		return dto.SendMessageResult{}, err
	}
	action, err := s.assistant.Start(ctx, dto.ConversationStartRequest{
		Program: program, RequirementID: requirement.ID, History: toMessageViews(messages),
		ThreadID: requirement.RemoteThreadID, Workspace: workspace,
		AttachmentIDs: attachmentIDs, References: references, Mode: mode,
	})
	if err != nil {
		// The business statement is already stored. Record the remote failure so
		// the next conversation read can show a useful recovery hint instead of
		// making the submitted statement look as if it disappeared.
		_ = s.repo.UpdateRemoteConversation(ctx, requirement.ID, requirement.RemoteThreadID, requirement.RemoteTurnID, "failed", err.Error())
		return dto.SendMessageResult{}, err
	}
	if action.ThreadID == "" || action.TurnID == "" {
		return dto.SendMessageResult{}, errors.New("远端 Kodes 未返回会话标识")
	}
	if err := s.repo.StartRemoteConversation(ctx, requirement.ID, action.ThreadID, action.TurnID, mode); err != nil {
		return dto.SendMessageResult{}, err
	}
	sent := toMessageView(userRow)
	if len(attachmentIDs) > 0 {
		attachments, listErr := s.repo.ListAttachments(ctx, req.BizLine.String(), requirement.ID)
		if listErr != nil {
			return dto.SendMessageResult{}, listErr
		}
		sent.Attachments = attachmentViewsFor(attachments, userRow.ID)
	}
	return dto.SendMessageResult{
		UserMessage: sent, ThreadID: action.ThreadID, TurnID: action.TurnID, Active: action.Active,
	}, nil
}

// conversation is the local API equivalent of a local plugin's GET
// /v1/codex/conversation: every read refreshes the running remote turn once,
// then returns the server-persisted business records.
func (s *service) conversation(ctx context.Context, requirement *repository.BusinessRequirement, program dto.ProgramContext) (dto.ConversationView, error) {
	streamingReply, activities, err := s.refreshRemoteConversation(ctx, requirement, program)
	if err != nil {
		// The original business statement is already durable. Keep the chat
		// readable and expose the remote failure in its snapshot rather than
		// turning every subsequent GET into an opaque HTTP error.
		requirement.RemoteStatus = "failed"
		requirement.RemoteError = err.Error()
	}
	messages, err := s.repo.ListMessages(ctx, requirement.BizLine, requirement.ID)
	if err != nil {
		return dto.ConversationView{}, err
	}
	documents, err := s.repo.ListDocuments(ctx, requirement.BizLine, requirement.ID)
	if err != nil {
		return dto.ConversationView{}, err
	}
	attachments, err := s.repo.ListAttachments(ctx, requirement.BizLine, requirement.ID)
	if err != nil {
		return dto.ConversationView{}, err
	}
	messageViews := toMessageViews(messages)
	for index := range messageViews {
		messageViews[index].Attachments = attachmentViewsFor(attachments, messageViews[index].ID)
	}
	// The browser reads these three as arrays on every poll. A nil Go slice
	// marshals to JSON null, so keep them empty rather than absent.
	if messageViews == nil {
		messageViews = []dto.MessageView{}
	}
	documentViews := toDocumentViews(documents)
	if documentViews == nil {
		documentViews = []dto.DocumentView{}
	}
	if activities == nil {
		activities = []dto.ConversationActivity{}
	}
	return dto.ConversationView{
		Requirement: toRequirementView(requirement), Program: program,
		Messages: messageViews, Documents: documentViews,
		Active: requirement.RemoteStatus == "running", ThreadID: requirement.RemoteThreadID,
		TurnID: requirement.RemoteTurnID, StreamingReply: streamingReply, StreamingActivities: activities,
		RemoteError: requirement.RemoteError,
	}, nil
}

func (s *service) refreshRemoteConversation(ctx context.Context, requirement *repository.BusinessRequirement, program dto.ProgramContext) (string, []dto.ConversationActivity, error) {
	if requirement.RemoteStatus != "running" {
		return "", nil, nil
	}
	if s.assistant == nil {
		return "", nil, s.failRemoteConversation(ctx, requirement, "远端业务访谈服务尚未初始化")
	}
	workspace := strings.TrimSpace(requirement.RemoteWorkspace)
	if workspace == "" {
		return "", nil, s.failRemoteConversation(ctx, requirement, "业务诉求缺少远端工作目录，请由原业务方重新提交")
	}
	state, err := s.assistant.Poll(ctx, program.ProgramID, requirement.ID, requirement.RemoteThreadID, requirement.RemoteTurnID, workspace)
	if err != nil {
		return "", nil, s.failRemoteConversation(ctx, requirement, err.Error())
	}
	threadID := strings.TrimSpace(state.ThreadID)
	if threadID == "" {
		threadID = requirement.RemoteThreadID
	}
	if state.Active || !state.Finished {
		if threadID != requirement.RemoteThreadID {
			if err := s.repo.UpdateRemoteConversation(ctx, requirement.ID, threadID, requirement.RemoteTurnID, "running", ""); err != nil {
				return "", nil, err
			}
			requirement.RemoteThreadID = threadID
		}
		return strings.TrimSpace(state.Reply), state.Activities, nil
	}
	if state.Failed {
		return "", nil, s.failRemoteConversation(ctx, requirement, "远端 Kodes 未能完成业务访谈")
	}
	reply := strings.TrimSpace(state.Reply)
	if reply == "" {
		return "", nil, s.failRemoteConversation(ctx, requirement, "远端 Kodes 已结束但没有返回可用内容")
	}
	if len([]rune(reply)) > 64000 {
		return "", nil, s.failRemoteConversation(ctx, requirement, "远端 AI 返回内容过长")
	}
	title := requirement.Title
	if title == untitledRequirement {
		userMessages, listErr := s.repo.ListMessages(ctx, requirement.BizLine, requirement.ID)
		if listErr != nil {
			return "", nil, listErr
		}
		for _, message := range userMessages {
			if message.Role == "user" {
				title = titleFromMessage(message.Content)
				break
			}
		}
	}
	documentTitle := interviewDocumentTitlePrefix + title
	if requirement.RemoteMode == dto.ConversationModeDocument {
		documentTitle = confirmedDocumentTitlePrefix + title
	}
	finalized, err := s.repo.FinalizeRemoteConversation(ctx, repository.RemoteConversationFinalization{
		BizLine: requirement.BizLine, RequirementID: requirement.ID, ExpectedThreadID: requirement.RemoteThreadID,
		ThreadID: threadID, TurnID: requirement.RemoteTurnID, Title: title, Reply: reply,
		DocumentTitle: documentTitle,
	})
	if err != nil {
		return "", nil, err
	}
	if !finalized {
		// Another request completed this same turn while this poll was in
		// flight. Refresh the canonical row so this response does not report a
		// stale active state or re-attempt the document write.
		refreshed, err := s.repo.FindCollectedRequirement(ctx, requirement.BizLine, requirement.ID)
		if err != nil {
			return "", nil, err
		}
		*requirement = *refreshed
		return "", nil, nil
	}
	requirement.Title = title
	requirement.Detail = reply
	requirement.RemoteThreadID = threadID
	requirement.RemoteStatus = "idle"
	requirement.RemoteError = ""
	requirement.RemoteMode = ""
	return "", nil, nil
}

func (s *service) failRemoteConversation(ctx context.Context, requirement *repository.BusinessRequirement, message string) error {
	message = strings.TrimSpace(message)
	if message == "" {
		message = "远端 Kodes 业务访谈失败"
	}
	updated, err := s.repo.FailRunningRemoteConversation(ctx, requirement.ID, requirement.RemoteThreadID, requirement.RemoteTurnID, message)
	if err != nil {
		return err
	}
	if !updated {
		refreshed, err := s.repo.FindCollectedRequirement(ctx, requirement.BizLine, requirement.ID)
		if err != nil {
			return err
		}
		*requirement = *refreshed
		if requirement.RemoteStatus != "failed" {
			return nil
		}
		if strings.TrimSpace(requirement.RemoteError) != "" {
			return errors.New(requirement.RemoteError)
		}
	}
	requirement.RemoteStatus = "failed"
	requirement.RemoteError = message
	return errors.New(message)
}

// requirementWorkspace keeps the remote workspace stable after a business
// submission. Legacy rows created before this field existed receive a
// best-effort migration when their original business user sends the next turn.
func (s *service) requirementWorkspace(ctx context.Context, requirement *repository.BusinessRequirement, program dto.ProgramContext, username string) (string, error) {
	if workspace := strings.TrimSpace(requirement.RemoteWorkspace); workspace != "" {
		return workspace, nil
	}
	workspace, err := businessWorkspace(username, program)
	if err != nil {
		return "", err
	}
	if err := s.repo.UpdateRemoteWorkspace(ctx, requirement.ID, workspace); err != nil {
		return "", err
	}
	requirement.RemoteWorkspace = workspace
	return workspace, nil
}

// businessWorkspace is a logical path, not an absolute server path. The
// remote Kodes plugin resolves it beneath its configured business workspace
// root and creates the directory when necessary.
func businessWorkspace(username string, program dto.ProgramContext) (string, error) {
	username = strings.TrimSpace(username)
	if username == "" {
		return "", errors.New("缺少业务方用户名，无法创建远端工作目录")
	}
	owner, err := businessWorkspaceSegment(username, "用户")
	if err != nil {
		return "", fmt.Errorf("业务方用户名不能作为工作目录：%w", err)
	}
	projectName := strings.TrimSpace(program.Name)
	if projectName == "" {
		projectName = strings.TrimSpace(program.ProgramCode)
	}
	project, err := businessWorkspaceSegment(projectName, "项目")
	if err != nil {
		return "", fmt.Errorf("项目名称不能作为工作目录：%w", err)
	}
	return owner + "/业务空间/" + project, nil
}

func businessWorkspaceSegment(value, fallback string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		value = fallback
	}
	if strings.ContainsAny(value, "/\\") || value == "." || value == ".." {
		return "", errors.New("不能包含路径分隔符或相对路径")
	}
	var builder strings.Builder
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			builder.WriteRune('_')
			continue
		}
		builder.WriteRune(character)
	}
	value = strings.Trim(strings.TrimSpace(builder.String()), ".")
	if value == "" || value == "." || value == ".." {
		return "", errors.New("目录名称无效")
	}
	if len([]rune(value)) > 120 {
		value = string([]rune(value)[:120])
	}
	return value, nil
}

func containsBizLine(values []string, target string) bool {
	for _, value := range values {
		if strings.TrimSpace(value) == target {
			return true
		}
	}
	return false
}

// withProgramNames fills the display fields of a requirement page. Both intake
// lists are small pages over one business line, so one project lookup per page
// is cheaper and simpler than joining the delivery-owned project table here.
func (s *service) withProgramNames(ctx context.Context, bizLine contract.BizLine, views []dto.RequirementView) []dto.RequirementView {
	if len(views) == 0 || s.programs == nil {
		return views
	}
	programs, err := s.programs.ListProgramContexts(ctx, bizLine)
	if err != nil {
		// A naming lookup must never fail the list itself: the caller still
		// gets every requirement, just without the resolved project name.
		return views
	}
	byID := make(map[int64]dto.ProgramContext, len(programs))
	for _, program := range programs {
		byID[program.ProgramID] = program
	}
	for index := range views {
		program, ok := byID[views[index].ProgramID]
		if !ok {
			continue
		}
		views[index].ProgramName = program.Name
		views[index].ProgramCode = program.ProgramCode
	}
	return views
}

func toRequirementView(row *repository.BusinessRequirement) dto.RequirementView {
	return dto.RequirementView{
		ID: row.ID, BizLine: row.BizLine, ProgramID: row.ProgramID, Title: row.Title, Detail: row.Detail,
		Status: row.Status, CreatedBy: row.CreatedBy, CreatedByName: row.CreatedByName,
		CreatedAt: timePtr(row.CreatedTime), UpdatedAt: timePtr(row.UpdatedTime),
	}
}

// UploadAttachments stores the business user's files in the requirement's own
// remote workspace and records their manifests. Files are uploaded before the
// message that carries them, exactly as the delivery console does.
func (s *service) UploadAttachments(ctx context.Context, req dto.UploadAttachmentsRequest) ([]dto.AttachmentView, error) {
	if !req.BizLine.Valid() {
		return nil, contract.ErrBizLineRequired
	}
	if req.RequirementID <= 0 || strings.TrimSpace(req.CreatorID) == "" {
		return nil, errors.New("缺少业务需求标识或提交人")
	}
	if len(req.Files) == 0 {
		return nil, errors.New("请选择要上传的文件")
	}
	if len(req.Files) > maxMessageAttachments {
		return nil, fmt.Errorf("一次最多上传 %d 个附件", maxMessageAttachments)
	}
	for _, file := range req.Files {
		if len(file.Data) == 0 {
			return nil, fmt.Errorf("附件 %s 为空", file.Name)
		}
		if len(file.Data) > maxAttachmentBytes {
			return nil, fmt.Errorf("附件 %s 超过 20 MB", file.Name)
		}
	}
	if s.programs == nil || s.assistant == nil {
		return nil, errors.New("远端业务访谈服务尚未初始化")
	}
	requirement, err := s.repo.FindRequirement(ctx, req.BizLine.String(), req.RequirementID, strings.TrimSpace(req.CreatorID))
	if err != nil {
		return nil, err
	}
	program, err := s.programs.GetProgramContext(ctx, req.BizLine, requirement.ProgramID)
	if err != nil {
		return nil, err
	}
	// The very first message may already carry files, so resolve the workspace
	// here exactly as sending does instead of demanding a message first.
	workspace, err := s.requirementWorkspace(ctx, requirement, program, req.CreatorUsername)
	if err != nil {
		return nil, err
	}
	uploaded, err := s.assistant.UploadAttachments(ctx, requirement.ProgramID, requirement.ID, workspace, req.Files)
	if err != nil {
		return nil, err
	}
	rows := make([]*repository.BusinessRequirementAttachment, 0, len(uploaded))
	for _, attachment := range uploaded {
		rows = append(rows, &repository.BusinessRequirementAttachment{
			BizLine: req.BizLine.String(), RequirementID: requirement.ID, RemoteID: attachment.ID,
			Name: attachment.Name, ContentType: attachment.ContentType, Size: attachment.Size,
			IsImage: attachment.IsImage, CreatedBy: strings.TrimSpace(req.CreatorID),
		})
	}
	if err := s.repo.CreateAttachments(ctx, rows); err != nil {
		return nil, err
	}
	views := make([]dto.AttachmentView, 0, len(rows))
	for _, row := range rows {
		views = append(views, toAttachmentView(row))
	}
	return views, nil
}

// GetAttachment reads one stored file back so the console can preview or
// download it without reaching remote Kodes from the browser.
func (s *service) GetAttachment(ctx context.Context, query dto.AttachmentQuery) (dto.AttachmentContent, error) {
	if !query.BizLine.Valid() {
		return dto.AttachmentContent{}, contract.ErrBizLineRequired
	}
	if query.RequirementID <= 0 || strings.TrimSpace(query.AttachmentID) == "" {
		return dto.AttachmentContent{}, errors.New("附件标识无效")
	}
	if s.assistant == nil {
		return dto.AttachmentContent{}, errors.New("远端业务访谈服务尚未初始化")
	}
	requirement, err := s.repo.FindRequirement(ctx, query.BizLine.String(), query.RequirementID, strings.TrimSpace(query.CreatorID))
	if err != nil {
		return dto.AttachmentContent{}, err
	}
	row, err := s.repo.FindAttachment(ctx, query.BizLine.String(), requirement.ID, strings.TrimSpace(query.AttachmentID))
	if err != nil {
		return dto.AttachmentContent{}, err
	}
	content, err := s.assistant.DownloadAttachment(ctx, requirement.ProgramID, requirement.ID, requirement.RemoteWorkspace, row.RemoteID)
	if err != nil {
		return dto.AttachmentContent{}, err
	}
	// The stored manifest is the authority on how this file is presented: the
	// remote read only proves the bytes are still there.
	content.Name = row.Name
	if strings.TrimSpace(row.ContentType) != "" {
		content.ContentType = row.ContentType
	}
	return content, nil
}

func trimmedIDs(values []string) []string {
	ids := make([]string, 0, len(values))
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			ids = append(ids, trimmed)
		}
	}
	return ids
}

func attachmentViewsFor(rows []*repository.BusinessRequirementAttachment, messageID int64) []dto.AttachmentView {
	var views []dto.AttachmentView
	for _, row := range rows {
		if row.MessageID == messageID {
			views = append(views, toAttachmentView(row))
		}
	}
	return views
}

func toAttachmentView(row *repository.BusinessRequirementAttachment) dto.AttachmentView {
	return dto.AttachmentView{
		ID: row.RemoteID, Name: row.Name, ContentType: row.ContentType,
		Size: row.Size, IsImage: row.IsImage, CreatedAt: timePtr(row.CreatedTime),
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
		ID: row.ID, Type: row.Type, Title: row.Title, Content: row.Content, Version: row.Version,
		// 标题就是这两类文档的分界线，写入时由本包决定，这里按同一个常量读回来。
		Confirmed: strings.HasPrefix(row.Title, confirmedDocumentTitlePrefix),
		CreatedAt: timePtr(row.CreatedTime),
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

// conversationModeOf normalises what the browser asked this turn to do. An
// empty mode stays an ordinary statement so older clients keep working.
func conversationModeOf(value string) (string, error) {
	switch strings.TrimSpace(value) {
	case "", dto.ConversationModeStatement:
		return dto.ConversationModeStatement, nil
	case dto.ConversationModeDocument:
		return dto.ConversationModeDocument, nil
	default:
		return "", errors.New("未知的业务访谈动作")
	}
}

func containsUserMessage(rows []*repository.BusinessRequirementMessage) bool {
	for _, row := range rows {
		if row.Role == "user" && strings.TrimSpace(row.Content) != "" {
			return true
		}
	}
	return false
}

// supplementOf appends whatever the business user typed next to 「确认文档」.
// It is written as a supplement rather than as this turn's whole input: the
// button already carries the instruction, and the box is usually empty.
func supplementOf(content string) string {
	if content = strings.TrimSpace(content); content == "" {
		return ""
	}
	return "\n\n补充说明：\n" + content
}

func timePtr(value time.Time) *time.Time { return &value }
