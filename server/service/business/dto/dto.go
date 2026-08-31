// Package dto contains the request and response shapes of the business-demand domain.
package dto

import (
	"time"

	"contract"
)

type Page struct {
	PageIndex int `json:"pageIndex" form:"pageIndex"`
	PageSize  int `json:"pageSize" form:"pageSize"`
}

func (p Page) Offset() int {
	if p.PageIndex <= 1 {
		return 0
	}
	return (p.PageIndex - 1) * p.Limit()
}

func (p Page) Limit() int {
	if p.PageSize <= 0 {
		return 20
	}
	if p.PageSize > 100 {
		return 100
	}
	return p.PageSize
}

// RequirementQuery only returns the current business user's own submissions.
// The actor fields are set by the HTTP layer and are never accepted from the browser.
type RequirementQuery struct {
	Page
	BizLine   contract.BizLine
	CreatorID string
}

type RequirementPage struct {
	Total int64             `json:"total"`
	Data  []RequirementView `json:"data"`
}

// CollectedRequirementQuery is the product/research view of one business
// line's intake pool. Unlike RequirementQuery it is intentionally not scoped
// to one creator: product/research needs the complete business-side context
// before it decides whether and how to groom a demand.
type CollectedRequirementQuery struct {
	Page
	BizLine contract.BizLine
}

// RequirementView is intentionally separate from delivery.RequirementView.
// A business requirement is raw intake, not a requirement that has entered
// product/research grooming, task decomposition, or delivery workflow.
type RequirementView struct {
	ID      int64  `json:"id"`
	BizLine string `json:"bizLine"`
	// ProgramID stays the canonical reference; ProgramName and ProgramCode are
	// resolved for display so a list does not have to show a bare "#15".
	ProgramID     int64      `json:"programId"`
	ProgramName   string     `json:"programName"`
	ProgramCode   string     `json:"programCode"`
	Title         string     `json:"title"`
	Detail        string     `json:"detail"`
	Status        string     `json:"status"`
	CreatedBy     string     `json:"createdBy"`
	CreatedByName string     `json:"createdByName"`
	CreatedAt     *time.Time `json:"createdAt"`
	UpdatedAt     *time.Time `json:"updatedAt"`
}

type CreateRequirementRequest struct {
	ProgramID int64 `json:"programId"`

	CreatorID          string   `json:"-"`
	CreatorUsername    string   `json:"-"`
	CreatorName        string   `json:"-"`
	AccessibleBizLines []string `json:"-"`
}

// ProgramContext is the minimum project description a business user and the
// remote AI both need before discussing a need. It deliberately does not
// disclose repository, branch, or local-workspace information.
type ProgramContext struct {
	ProgramID   int64  `json:"programId"`
	BizLine     string `json:"bizLine"`
	ProgramCode string `json:"programCode"`
	Name        string `json:"name"`
	Summary     string `json:"summary"`
}

type MessageView struct {
	ID      int64  `json:"id"`
	Role    string `json:"role"`
	Content string `json:"content"`
	// Attachments are the files the business user sent with this message.
	// They live in the remote business workspace; only their manifest is
	// persisted here so the console can list and preview them later.
	Attachments []AttachmentView `json:"attachments"`
	CreatedAt   *time.Time       `json:"createdAt"`
}

// AttachmentView is one stored business-intake file as the console sees it.
type AttachmentView struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	ContentType string     `json:"contentType"`
	Size        int64      `json:"size"`
	IsImage     bool       `json:"isImage"`
	CreatedAt   *time.Time `json:"createdAt"`
}

// AttachmentUpload is one browser-provided file on its way to remote Kodes.
type AttachmentUpload struct {
	Name        string
	ContentType string
	Data        []byte
}

// AttachmentContent is a stored file read back from remote Kodes for preview
// or download. Business attachments are capped at 10 MB by the bridge, so the
// body is carried in memory rather than streamed.
type AttachmentContent struct {
	Name        string
	ContentType string
	Data        []byte
}

// UploadAttachmentsRequest carries browser uploads for one business intake
// conversation. Only the requirement's own creator may add files to it.
type UploadAttachmentsRequest struct {
	RequirementID int64
	Files         []AttachmentUpload

	BizLine         contract.BizLine
	CreatorID       string
	CreatorUsername string
}

// AttachmentQuery reads one stored attachment back for the console.
type AttachmentQuery struct {
	RequirementID int64
	AttachmentID  string

	BizLine   contract.BizLine
	CreatorID string
}

type DocumentView struct {
	ID        int64      `json:"id"`
	Type      string     `json:"type"`
	Title     string     `json:"title"`
	Content   string     `json:"content"`
	Version   int        `json:"version"`
	CreatedAt *time.Time `json:"createdAt"`
}

type ConversationQuery struct {
	BizLine       contract.BizLine
	RequirementID int64
	CreatorID     string
}

// CollectedConversationQuery is the read-only product/research view of a
// business intake conversation.
type CollectedConversationQuery struct {
	BizLine       contract.BizLine
	RequirementID int64
}

// ConversationActivity is one visible step of a running remote turn: a
// reasoning summary, a command the assistant ran, or a file it touched. It is
// display-only progress, never persisted as a business message.
type ConversationActivity struct {
	ID     string `json:"id"`
	Type   string `json:"type"`
	Text   string `json:"text"`
	Action string `json:"action"`
	Target string `json:"target"`
	Status string `json:"status"`
	Phase  string `json:"phase"`
}

type ConversationView struct {
	Requirement RequirementView `json:"requirement"`
	Program     ProgramContext  `json:"program"`
	Messages    []MessageView   `json:"messages"`
	Documents   []DocumentView  `json:"documents"`
	// Active mirrors the remote Bridge turn. The browser polls this API while
	// it is true, exactly as it does for a local delivery Bridge conversation.
	Active   bool   `json:"active"`
	ThreadID string `json:"threadId"`
	TurnID   string `json:"turnId"`
	// StreamingReply is the latest, not-yet-final remote response. It is
	// intentionally transient: only the terminal AI response is persisted as
	// a business message and an intake document.
	StreamingReply string `json:"streamingReply"`
	// StreamingActivities is what the remote assistant has been doing during
	// the running turn. It is as transient as StreamingReply: every poll
	// replaces it, and nothing here survives the turn.
	StreamingActivities []ConversationActivity `json:"streamingActivities"`
	RemoteError         string                 `json:"remoteError"`
}

type SendMessageRequest struct {
	RequirementID int64  `json:"requirementId"`
	Content       string `json:"content"`
	// AttachmentIDs are files already uploaded for this requirement. They are
	// bound to the message this request creates.
	AttachmentIDs []string `json:"attachmentIds"`

	BizLine         contract.BizLine `json:"-"`
	CreatorID       string           `json:"-"`
	CreatorUsername string           `json:"-"`
}

type SendMessageResult struct {
	UserMessage MessageView `json:"userMessage"`
	ThreadID    string      `json:"threadId"`
	TurnID      string      `json:"turnId"`
	Active      bool        `json:"active"`
}

// ConversationAction is the asynchronous acknowledgement returned by the
// remote Kodes Bridge after POST /v1/codex/conversation.
type ConversationAction struct {
	ThreadID string
	TurnID   string
	Active   bool
}

// ConversationState is the latest snapshot read from the remote Kodes
// Bridge. Reply may be a current incremental response while the turn is
// active, or the terminal response once it has finished.
type ConversationState struct {
	ThreadID string
	Active   bool
	Finished bool
	Failed   bool
	Reply    string
	// Activities are the turn's progress steps in the order the remote
	// assistant produced them, excluding the item reported as Reply.
	Activities []ConversationActivity
}
