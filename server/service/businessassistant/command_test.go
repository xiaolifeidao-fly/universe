package businessassistant

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"contract"
	businessdto "service/business/dto"
	"service/delivery"
	deliverydto "service/delivery/dto"
)

// stubCommandPort is a scripted command queue. Each GetCommand call advances one
// step, which lets a test drive a turn from pending through to its terminal state.
type stubCommandPort struct {
	submitted  []deliverydto.SubmitCommandRequest
	steps      []deliverydto.CommandView
	activities []deliverydto.CommandEventView
	reads      int
	workerUser string
	attachment deliverydto.CommandAttachmentContent
}

func (port *stubCommandPort) ResolveProgramBizLine(context.Context, int64) (contract.BizLine, error) {
	return contract.BizLine("indonesia"), nil
}

func (port *stubCommandPort) ResolveCommandWorkerUser(context.Context, contract.BizLine, int64) (string, error) {
	return port.workerUser, nil
}

func (port *stubCommandPort) SubmitCommand(_ context.Context, req deliverydto.SubmitCommandRequest) (deliverydto.CommandView, error) {
	port.submitted = append(port.submitted, req)
	return deliverydto.CommandView{CommandID: "cmd-1", State: delivery.CommandStatePending}, nil
}

func (port *stubCommandPort) GetCommand(context.Context, contract.BizLine, string, string) (deliverydto.CommandView, error) {
	step := port.steps[min(port.reads, len(port.steps)-1)]
	port.reads++
	return step, nil
}

func (port *stubCommandPort) LatestCommandActivity(context.Context, contract.BizLine, string, string) (deliverydto.CommandEventView, error) {
	if len(port.activities) == 0 {
		return deliverydto.CommandEventView{}, nil
	}
	return port.activities[min(port.reads-1, len(port.activities)-1)], nil
}

func (port *stubCommandPort) SaveCommandAttachments(_ context.Context, req deliverydto.SaveCommandAttachmentsRequest) ([]deliverydto.CommandAttachmentView, error) {
	views := make([]deliverydto.CommandAttachmentView, 0, len(req.Uploads))
	for _, upload := range req.Uploads {
		views = append(views, deliverydto.CommandAttachmentView{
			AttachmentID: "attachment-1", ItemKey: req.ItemKey, Name: upload.Name,
			ContentType: upload.ContentType, Size: int64(len(upload.Content)),
		})
	}
	return views, nil
}

func (port *stubCommandPort) GetCommandAttachment(context.Context, contract.BizLine, string, int64, string) (deliverydto.CommandAttachmentContent, error) {
	return port.attachment, nil
}

func activityWith(threadID, turnID string, conversation string) deliverydto.CommandEventView {
	data, _ := json.Marshal(map[string]any{
		"threadId": threadID, "turnId": turnID, "conversation": json.RawMessage(conversation),
	})
	return deliverydto.CommandEventView{Kind: "activity", Data: data}
}

func startRequest() businessdto.ConversationStartRequest {
	return businessdto.ConversationStartRequest{
		Program:       businessdto.ProgramContext{ProgramID: 7, BizLine: "indonesia", Name: "业务项目"},
		RequirementID: 42,
		History:       []businessdto.MessageView{{ID: 3, Role: "user", Content: "这次想做直播"}},
		Workspace:     "alice/业务空间/业务项目",
		Mode:          businessdto.ConversationModeStatement,
	}
}

// A turn is addressed by its command id, so the business domain can poll without
// the Worker being reachable. The thread id must be the one the Worker opened.
func TestStartReturnsCommandCursorAndWorkerThread(t *testing.T) {
	port := &stubCommandPort{
		workerUser: "user-9",
		steps: []deliverydto.CommandView{
			{CommandID: "cmd-1", State: delivery.CommandStatePending},
			{CommandID: "cmd-1", State: delivery.CommandStateRunning},
		},
		activities: []deliverydto.CommandEventView{
			{}, activityWith("thread-77", "turn-1", `{"threadId":"thread-77","active":true,"turns":[]}`),
		},
	}
	assistant := &BusinessCommandAssistant{Service: port, StartTimeout: 2 * time.Second}
	action, err := assistant.Start(context.Background(), startRequest())
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if action.TurnID != "cmd-1" || action.ThreadID != "thread-77" || !action.Active {
		t.Fatalf("unexpected action: %+v", action)
	}
	if len(port.submitted) != 1 {
		t.Fatalf("expected one submitted command, got %d", len(port.submitted))
	}
	submitted := port.submitted[0]
	if submitted.CommandType != businessCommandType || submitted.UserID != "user-9" || submitted.ProgramID != 7 {
		t.Fatalf("unexpected submission: %+v", submitted)
	}
	var input businessCommandInput
	if err := json.Unmarshal(submitted.Input, &input); err != nil {
		t.Fatalf("input: %v", err)
	}
	if !input.BusinessIntake || input.Workspace != "alice/业务空间/业务项目" || input.ItemKey != "business-requirement-42" {
		t.Fatalf("unexpected input: %+v", input)
	}
	if !strings.Contains(input.Message, "这次想做直播") {
		t.Fatalf("interview prompt lost the statement: %s", input.Message)
	}
}

// Retrying the same statement must converge on the running interview rather than
// starting a second one, so the idempotency key is tied to that statement.
func TestIdempotencyKeyFollowsTheTriggeringStatement(t *testing.T) {
	history := []businessdto.MessageView{{ID: 3}, {ID: 8}}
	first := businessIdempotencyKey(42, history, businessdto.ConversationModeStatement)
	if first != businessIdempotencyKey(42, history, businessdto.ConversationModeStatement) {
		t.Fatal("same statement must produce the same key")
	}
	if first == businessIdempotencyKey(42, append(history, businessdto.MessageView{ID: 9}), businessdto.ConversationModeStatement) {
		t.Fatal("a new statement must produce a new key")
	}
	if first == businessIdempotencyKey(42, history, businessdto.ConversationModeDocument) {
		t.Fatal("confirming the document is a different turn on the same statement")
	}
}

func TestPollProjectsWorkerSnapshot(t *testing.T) {
	conversation := `{"threadId":"thread-77","active":true,"turns":[{"id":"turn-1","status":"running",` +
		`"items":[{"id":"i1","type":"reasoning","summary":"正在梳理"},{"id":"i2","type":"agentMessage","text":"想先确认投放预算"}]}]}`
	port := &stubCommandPort{
		steps:      []deliverydto.CommandView{{CommandID: "cmd-1", State: delivery.CommandStateRunning}},
		activities: []deliverydto.CommandEventView{activityWith("thread-77", "turn-1", conversation)},
	}
	assistant := &BusinessCommandAssistant{Service: port}
	state, err := assistant.Poll(context.Background(), 7, 42, "", "cmd-1", "alice/业务空间/业务项目")
	if err != nil {
		t.Fatalf("poll: %v", err)
	}
	if !state.Active || state.Finished || state.Failed {
		t.Fatalf("a running command must read as active: %+v", state)
	}
	if state.ThreadID != "thread-77" || state.Reply != "想先确认投放预算" {
		t.Fatalf("unexpected state: %+v", state)
	}
	if len(state.Activities) != 1 || state.Activities[0].Text != "正在梳理" {
		t.Fatalf("progress steps lost: %+v", state.Activities)
	}
}

// A Worker that dies mid-turn stops publishing snapshots. The command's own
// terminal state has to end the conversation, otherwise it reads "running" until
// someone notices.
func TestPollEndsTheTurnWhenTheCommandFails(t *testing.T) {
	conversation := `{"threadId":"thread-77","active":true,"turns":[{"id":"turn-1","status":"running","items":[]}]}`
	port := &stubCommandPort{
		steps: []deliverydto.CommandView{{
			CommandID: "cmd-1", State: delivery.CommandStateFailed, ErrorMessage: "本机插件已退出",
		}},
		activities: []deliverydto.CommandEventView{activityWith("thread-77", "turn-1", conversation)},
	}
	assistant := &BusinessCommandAssistant{Service: port}
	state, err := assistant.Poll(context.Background(), 7, 42, "", "cmd-1", "alice/业务空间/业务项目")
	if err == nil {
		t.Fatal("a failed command must surface its error")
	}
	if !state.Failed || !state.Finished || state.Active {
		t.Fatalf("a failed command must end the turn: %+v", state)
	}
}

func TestUploadAttachmentsStayAtTheCommandBoundary(t *testing.T) {
	port := &stubCommandPort{workerUser: "user-9"}
	assistant := &BusinessCommandAssistant{Service: port}
	views, err := assistant.UploadAttachments(context.Background(), 7, 42, "alice/业务空间/业务项目",
		[]businessdto.AttachmentUpload{{Name: "投放.png", ContentType: "image/png", Data: []byte("binary")}})
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	if len(views) != 1 || views[0].ID != "attachment-1" || !views[0].IsImage {
		t.Fatalf("unexpected views: %+v", views)
	}
}

func TestDownloadAttachmentRejectsAnotherRequirementsFile(t *testing.T) {
	port := &stubCommandPort{attachment: deliverydto.CommandAttachmentContent{
		CommandAttachmentView: deliverydto.CommandAttachmentView{ItemKey: "business-requirement-999", Name: "别人的.png"},
	}}
	assistant := &BusinessCommandAssistant{Service: port}
	if _, err := assistant.DownloadAttachment(context.Background(), 7, 42, "alice/业务空间/业务项目", "attachment-1"); err == nil {
		t.Fatal("an attachment from another requirement must be refused")
	}
}
