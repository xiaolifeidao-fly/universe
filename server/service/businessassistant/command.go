package businessassistant

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"contract"
	businessdto "service/business/dto"
	"service/delivery"
	deliverydto "service/delivery/dto"
)

// BusinessCommandAssistant runs a business interview over the delivery command
// queue instead of an inbound HTTP call to a Kodes host.
//
// The HTTP transport requires the interview host to be reachable from this
// server, which forces every plugin machine to be publicly addressable. The
// command transport inverts that: the plugin's Worker long-polls this server,
// claims the turn and reports back, so the bridge only ever dials outward. The
// interview prompt, workspace naming and item key are shared with the HTTP
// client so switching transports cannot change what the assistant is asked.
type BusinessCommandAssistant struct {
	Service BusinessCommandPort
	// WorkerUserID pins interviews to one console user's Worker. Leave it empty
	// to route each project to whichever registered Worker is currently online
	// for it.
	WorkerUserID string
	// StartTimeout bounds how long Start waits for the claiming Worker to report
	// the Codex thread it opened. The browser is already polling by then, so a
	// timeout here fails one turn rather than the conversation.
	StartTimeout    time.Duration
	Model           string
	ReasoningEffort string
}

// BusinessCommandPort is the slice of the delivery command service a business
// interview needs. Naming it here keeps the dependency honest — an interview
// never touches the board — and lets the transport be tested without standing up
// the whole delivery service.
type BusinessCommandPort interface {
	ResolveProgramBizLine(context.Context, int64) (contract.BizLine, error)
	ResolveCommandWorkerUser(context.Context, contract.BizLine, int64) (string, error)
	SubmitCommand(context.Context, deliverydto.SubmitCommandRequest) (deliverydto.CommandView, error)
	GetCommand(context.Context, contract.BizLine, string, string) (deliverydto.CommandView, error)
	LatestCommandActivity(context.Context, contract.BizLine, string, string) (deliverydto.CommandEventView, error)
	SaveCommandAttachments(context.Context, deliverydto.SaveCommandAttachmentsRequest) ([]deliverydto.CommandAttachmentView, error)
	GetCommandAttachment(context.Context, contract.BizLine, string, int64, string) (deliverydto.CommandAttachmentContent, error)
}

// businessCommandType is the single command a business interview raises. It is
// deliberately not one of the task.* types: an interview has no delivery item,
// and its workspace is a logical business path the Worker resolves under its own
// controlled root, never a mapped project directory.
const businessCommandType = "business.conversation"

const (
	defaultBusinessStartTimeout = 60 * time.Second
	businessStartPollInterval   = 300 * time.Millisecond
	maxBusinessReplyRunes       = 64000
)

// businessCommandInput is what the Worker receives. It mirrors the JSON body the
// loopback bridge accepts on POST /v1/codex/conversation with businessIntake set,
// so the Worker can hand it to the existing business-intake entry point unchanged.
type businessCommandInput struct {
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

// businessCommandSnapshot is the shape the Worker reports as activity data while
// a turn runs, and as the command result once it finishes.
//
// Conversation is the bridge's own conversation snapshot, forwarded untouched.
// Projecting it into a reply and its progress steps stays on this side so both
// transports share one set of rules.
type businessCommandSnapshot struct {
	ThreadID     string          `json:"threadId"`
	TurnID       string          `json:"turnId"`
	Conversation json.RawMessage `json:"conversation"`
}

func (assistant *BusinessCommandAssistant) startTimeout() time.Duration {
	if assistant.StartTimeout > 0 {
		return assistant.StartTimeout
	}
	return defaultBusinessStartTimeout
}

// owner resolves which console user's command queue this project's interviews go
// into. A configured user keeps a dedicated interview host authoritative; without
// one the routing follows whichever Worker is live for the project.
func (assistant *BusinessCommandAssistant) owner(ctx context.Context, bizLine contract.BizLine, programID int64) (string, error) {
	if pinned := strings.TrimSpace(assistant.WorkerUserID); pinned != "" {
		return pinned, nil
	}
	return assistant.Service.ResolveCommandWorkerUser(ctx, bizLine, programID)
}

// context resolves the business line and command owner for one requirement. Poll
// and DownloadAttachment only receive a project id, so the business line is read
// back from the project rather than trusted from the caller.
func (assistant *BusinessCommandAssistant) context(ctx context.Context, programID int64) (contract.BizLine, string, error) {
	bizLine, err := assistant.Service.ResolveProgramBizLine(ctx, programID)
	if err != nil {
		return "", "", err
	}
	userID, err := assistant.owner(ctx, bizLine, programID)
	if err != nil {
		return "", "", err
	}
	return bizLine, userID, nil
}

// Start submits one interview turn and waits for the claiming Worker to report
// the Codex thread it opened.
//
// The returned TurnID is the command id: the business domain treats it as an
// opaque cursor and hands it straight back to Poll, which lets a poll be a local
// database read instead of another round trip to the Worker.
func (assistant *BusinessCommandAssistant) Start(ctx context.Context, req businessdto.ConversationStartRequest) (businessdto.ConversationAction, error) {
	workspace := strings.TrimSpace(req.Workspace)
	if workspace == "" {
		return businessdto.ConversationAction{}, errors.New("缺少业务访谈工作目录")
	}
	if req.RequirementID <= 0 {
		return businessdto.ConversationAction{}, errors.New("业务需求标识无效")
	}
	bizLine := contract.BizLine(strings.TrimSpace(req.Program.BizLine))
	if !bizLine.Valid() {
		return businessdto.ConversationAction{}, contract.ErrBizLineRequired
	}
	message := businessConversationMessage(req.Program, req.History, req.References, req.Mode)
	if message == "" {
		return businessdto.ConversationAction{}, errors.New("缺少业务方消息")
	}
	userID, err := assistant.owner(ctx, bizLine, req.Program.ProgramID)
	if err != nil {
		return businessdto.ConversationAction{}, err
	}
	input, err := json.Marshal(businessCommandInput{
		ProgramID: req.Program.ProgramID, ItemKey: businessItemKey(req.RequirementID),
		Message: message, ThreadID: strings.TrimSpace(req.ThreadID), AttachmentIDs: req.AttachmentIDs,
		BusinessIntake: true, Provider: "codex", Workspace: workspace,
		Model: strings.TrimSpace(assistant.Model), ReasoningEffort: strings.TrimSpace(assistant.ReasoningEffort),
	})
	if err != nil {
		return businessdto.ConversationAction{}, err
	}
	command, err := assistant.Service.SubmitCommand(ctx, deliverydto.SubmitCommandRequest{
		BizLine: bizLine, ProgramID: req.Program.ProgramID, UserID: userID,
		CommandType: businessCommandType, Input: input,
		IdempotencyKey: businessIdempotencyKey(req.RequirementID, req.History, req.Mode),
	})
	if err != nil {
		return businessdto.ConversationAction{}, err
	}
	threadID, err := assistant.awaitThread(ctx, bizLine, userID, command.CommandID, strings.TrimSpace(req.ThreadID))
	if err != nil {
		return businessdto.ConversationAction{}, err
	}
	return businessdto.ConversationAction{ThreadID: threadID, TurnID: command.CommandID, Active: true}, nil
}

// awaitThread blocks until the Worker reports the thread it is running the turn
// in. The business domain persists that id and sends it back on the next turn to
// continue the same Codex thread, so returning a placeholder here would silently
// fork the conversation.
func (assistant *BusinessCommandAssistant) awaitThread(ctx context.Context, bizLine contract.BizLine, userID, commandID, requested string) (string, error) {
	deadline := time.Now().Add(assistant.startTimeout())
	for {
		snapshot, state, errorMessage, err := assistant.snapshotOf(ctx, bizLine, userID, commandID)
		if err != nil {
			return "", err
		}
		if threadID := strings.TrimSpace(snapshot.ThreadID); threadID != "" {
			return threadID, nil
		}
		switch state {
		case delivery.CommandStateFailed, delivery.CommandStateCancelled, delivery.CommandStateTimedOut:
			if errorMessage == "" {
				errorMessage = "本机插件未能开始业务访谈"
			}
			return "", errors.New(errorMessage)
		case delivery.CommandStateSucceeded:
			// A turn that finished without ever naming a thread still continues
			// the requested one; only a first turn has nothing to fall back to.
			if requested != "" {
				return requested, nil
			}
			return "", errors.New("本机插件未返回业务访谈会话标识")
		}
		if time.Now().After(deadline) {
			if requested != "" {
				return requested, nil
			}
			return "", errors.New("本机插件未在超时时间内领取业务访谈，请确认插件桥接已启动")
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(businessStartPollInterval):
		}
	}
}

// Poll reads the turn's current state without contacting the Worker: the Worker
// pushes each snapshot as command activity, and the terminal one as the command
// result.
func (assistant *BusinessCommandAssistant) Poll(ctx context.Context, programID, requirementID int64, threadID, turnID, workspace string) (businessdto.ConversationState, error) {
	commandID := strings.TrimSpace(turnID)
	if programID <= 0 || requirementID <= 0 || commandID == "" {
		return businessdto.ConversationState{}, errors.New("业务访谈会话标识无效")
	}
	bizLine, userID, err := assistant.context(ctx, programID)
	if err != nil {
		return businessdto.ConversationState{}, err
	}
	snapshot, state, errorMessage, err := assistant.snapshotOf(ctx, bizLine, userID, commandID)
	if err != nil {
		return businessdto.ConversationState{}, err
	}
	result := businessdto.ConversationState{ThreadID: strings.TrimSpace(snapshot.ThreadID)}
	if len(snapshot.Conversation) > 0 {
		projected, projectErr := businessConversationState(snapshot.Conversation, snapshot.TurnID)
		if projectErr != nil {
			return businessdto.ConversationState{}, projectErr
		}
		result = projected
	}
	if strings.TrimSpace(result.ThreadID) == "" {
		result.ThreadID = strings.TrimSpace(threadID)
	}
	// The command's own state is authoritative about the turn ending. A Worker
	// that dies mid-turn stops publishing snapshots, and the lease recovery would
	// otherwise leave this conversation reading "running" forever.
	switch state {
	case delivery.CommandStateSucceeded:
		result.Active = false
		result.Finished = true
	case delivery.CommandStateFailed, delivery.CommandStateCancelled, delivery.CommandStateTimedOut:
		result.Active = false
		result.Finished = true
		result.Failed = true
		if errorMessage != "" {
			return result, fmt.Errorf("本机插件未能完成业务访谈：%s", errorMessage)
		}
	default:
		if !result.Finished {
			result.Active = true
		}
	}
	if len([]rune(result.Reply)) > maxBusinessReplyRunes {
		return result, errors.New("业务访谈返回内容过长")
	}
	return result, nil
}

// snapshotOf reads the newest snapshot the Worker published for one command:
// the command result once it has finished, otherwise its latest activity.
func (assistant *BusinessCommandAssistant) snapshotOf(
	ctx context.Context, bizLine contract.BizLine, userID, commandID string,
) (businessCommandSnapshot, string, string, error) {
	command, err := assistant.Service.GetCommand(ctx, bizLine, userID, commandID)
	if err != nil {
		return businessCommandSnapshot{}, "", "", err
	}
	snapshot := decodeBusinessSnapshot(command.Result)
	if snapshot.isEmpty() {
		activity, err := assistant.Service.LatestCommandActivity(ctx, bizLine, userID, commandID)
		if err != nil {
			return businessCommandSnapshot{}, "", "", err
		}
		snapshot = decodeBusinessSnapshot(activity.Data)
	}
	return snapshot, command.State, strings.TrimSpace(command.ErrorMessage), nil
}

// UploadAttachments keeps business files at the command boundary. The bytes stay
// on this server and the Worker fetches them when it claims the turn, so an
// upload no longer depends on the interview host being reachable.
func (assistant *BusinessCommandAssistant) UploadAttachments(
	ctx context.Context, programID, requirementID int64, workspace string, files []businessdto.AttachmentUpload,
) ([]businessdto.AttachmentView, error) {
	if len(files) == 0 {
		return nil, errors.New("没有待上传的文件")
	}
	bizLine, userID, err := assistant.context(ctx, programID)
	if err != nil {
		return nil, err
	}
	uploads := make([]deliverydto.CommandAttachmentUpload, 0, len(files))
	for _, file := range files {
		uploads = append(uploads, deliverydto.CommandAttachmentUpload{
			Name: file.Name, ContentType: file.ContentType, Content: file.Data,
		})
	}
	saved, err := assistant.Service.SaveCommandAttachments(ctx, deliverydto.SaveCommandAttachmentsRequest{
		BizLine: bizLine, ProgramID: programID, ItemKey: businessItemKey(requirementID),
		UserID: userID, Uploads: uploads,
	})
	if err != nil {
		return nil, err
	}
	views := make([]businessdto.AttachmentView, 0, len(saved))
	for _, attachment := range saved {
		created := attachment.CreatedAt
		views = append(views, businessdto.AttachmentView{
			ID: attachment.AttachmentID, Name: attachment.Name, ContentType: attachment.ContentType,
			Size: attachment.Size, IsImage: strings.HasPrefix(strings.ToLower(attachment.ContentType), "image/"),
			CreatedAt: &created,
		})
	}
	return views, nil
}

func (assistant *BusinessCommandAssistant) DownloadAttachment(
	ctx context.Context, programID, requirementID int64, workspace, attachmentID string,
) (businessdto.AttachmentContent, error) {
	attachmentID = strings.TrimSpace(attachmentID)
	if attachmentID == "" {
		return businessdto.AttachmentContent{}, errors.New("业务访谈附件标识无效")
	}
	bizLine, userID, err := assistant.context(ctx, programID)
	if err != nil {
		return businessdto.AttachmentContent{}, err
	}
	stored, err := assistant.Service.GetCommandAttachment(ctx, bizLine, userID, programID, attachmentID)
	if err != nil {
		return businessdto.AttachmentContent{}, err
	}
	if stored.ItemKey != businessItemKey(requirementID) {
		return businessdto.AttachmentContent{}, errors.New("附件不属于当前业务诉求")
	}
	return businessdto.AttachmentContent{
		Name: stored.Name, ContentType: stored.ContentType, Data: stored.Content,
	}, nil
}

func (snapshot businessCommandSnapshot) isEmpty() bool {
	return strings.TrimSpace(snapshot.ThreadID) == "" && len(snapshot.Conversation) == 0
}

func decodeBusinessSnapshot(raw json.RawMessage) businessCommandSnapshot {
	var snapshot businessCommandSnapshot
	if len(raw) == 0 {
		return snapshot
	}
	// Activity payloads carry Worker progress fields this snapshot does not model.
	// A decode failure means there is nothing to show yet, not a broken turn.
	_ = json.Unmarshal(raw, &snapshot)
	return snapshot
}

// businessIdempotencyKey ties one turn to the business message that triggered it.
// The statement is persisted before the turn starts, so a retried submit converges
// on the running command instead of starting a second interview on the same input.
func businessIdempotencyKey(requirementID int64, history []businessdto.MessageView, mode string) string {
	var lastMessageID int64
	if len(history) > 0 {
		lastMessageID = history[len(history)-1].ID
	}
	return fmt.Sprintf("business-%d-%d-%s", requirementID, lastMessageID, strings.TrimSpace(mode))
}
