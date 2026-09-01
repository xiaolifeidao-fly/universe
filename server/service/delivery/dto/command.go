package dto

import (
	"encoding/json"
	"time"

	"contract"
)

// SubmitCommandRequest is created by a user-facing client. User identity is always
// filled from the authenticated request and is never accepted from JSON.
type SubmitCommandRequest struct {
	BizLine        contract.BizLine `json:"-"`
	ProgramID      int64            `json:"programId"`
	CommandType    string           `json:"commandType"`
	Input          json.RawMessage  `json:"input"`
	IdempotencyKey string           `json:"idempotencyKey"`
	UserID         string           `json:"-"`
	UserName       string           `json:"-"`
}

type CommandQuery struct {
	Page
	BizLine   contract.BizLine `form:"-"`
	UserID    string           `form:"-"`
	ProgramID int64            `form:"programId"`
	State     string           `form:"state"`
}

type CommandView struct {
	CommandID       string          `json:"commandId"`
	BizLine         string          `json:"bizLine"`
	ProgramID       int64           `json:"programId"`
	UserID          string          `json:"userId"`
	CommandType     string          `json:"commandType"`
	Input           json.RawMessage `json:"input"`
	Result          json.RawMessage `json:"result"`
	ErrorMessage    string          `json:"errorMessage"`
	State           string          `json:"state"`
	Progress        int             `json:"progress"`
	CancelRequested bool            `json:"cancelRequested"`
	LeaseWorkerID   string          `json:"leaseWorkerId"`
	LeaseExpiresAt  *time.Time      `json:"leaseExpiresAt"`
	DispatchCount   int             `json:"dispatchCount"`
	AttemptCount    int             `json:"attemptCount"`
	StartedAt       *time.Time      `json:"startedAt"`
	FinishedAt      *time.Time      `json:"finishedAt"`
	CreatedAt       time.Time       `json:"createdAt"`
	UpdatedAt       time.Time       `json:"updatedAt"`
}

type CommandPage struct {
	Total int64         `json:"total"`
	Data  []CommandView `json:"data"`
}

type CancelCommandRequest struct {
	BizLine   contract.BizLine `json:"-"`
	CommandID string           `json:"-"`
	UserID    string           `json:"-"`
	Message   string           `json:"message"`
}

type RegisterCommandWorkerRequest struct {
	BizLine      contract.BizLine `json:"-"`
	UserID       string           `json:"-"`
	WorkerID     string           `json:"workerId"`
	DisplayName  string           `json:"displayName"`
	Capabilities []string         `json:"capabilities"`
	ProgramIDs   []int64          `json:"programIds"`
}

type CommandWorkerView struct {
	BizLine         string    `json:"bizLine"`
	WorkerID        string    `json:"workerId"`
	DisplayName     string    `json:"displayName"`
	Capabilities    []string  `json:"capabilities"`
	ProgramIDs      []int64   `json:"programIds"`
	LastHeartbeatAt time.Time `json:"lastHeartbeatAt"`
}

type WorkerHeartbeatRequest struct {
	BizLine  contract.BizLine `json:"-"`
	UserID   string           `json:"-"`
	WorkerID string           `json:"workerId"`
}

type ClaimCommandRequest struct {
	UserID   string `json:"-"`
	WorkerID string `json:"workerId"`
}

type ClaimedCommand struct {
	Command    CommandView `json:"command"`
	LeaseToken string      `json:"leaseToken"`
}

type RenewCommandLeaseRequest struct {
	BizLine    contract.BizLine `json:"-"`
	UserID     string           `json:"-"`
	WorkerID   string           `json:"workerId"`
	CommandID  string           `json:"-"`
	LeaseToken string           `json:"leaseToken"`
}

type ReportCommandActivityRequest struct {
	BizLine    contract.BizLine `json:"-"`
	UserID     string           `json:"-"`
	WorkerID   string           `json:"workerId"`
	CommandID  string           `json:"-"`
	LeaseToken string           `json:"leaseToken"`
	Message    string           `json:"message"`
	Progress   *int             `json:"progress"`
	Data       json.RawMessage  `json:"data"`
}

type CompleteCommandRequest struct {
	BizLine      contract.BizLine `json:"-"`
	UserID       string           `json:"-"`
	WorkerID     string           `json:"workerId"`
	CommandID    string           `json:"-"`
	LeaseToken   string           `json:"leaseToken"`
	State        string           `json:"state"`
	Result       json.RawMessage  `json:"result"`
	ErrorMessage string           `json:"errorMessage"`
}

type CommandEventQuery struct {
	BizLine   contract.BizLine `form:"-"`
	UserID    string           `form:"-"`
	CommandID string           `form:"-"`
	AfterID   int64            `form:"afterId"`
	Limit     int              `form:"limit"`
}

type CommandEventView struct {
	ID        int64           `json:"id"`
	Kind      string          `json:"kind"`
	State     string          `json:"state"`
	Message   string          `json:"message"`
	Data      json.RawMessage `json:"data"`
	CreatedAt time.Time       `json:"createdAt"`
}

// SaveCommandAttachmentsRequest keeps conversation uploads at the command
// boundary. The browser never sends these bytes to a local Worker directly.
type SaveCommandAttachmentsRequest struct {
	BizLine   contract.BizLine          `json:"-"`
	ProgramID int64                     `json:"-"`
	ItemKey   string                    `json:"-"`
	UserID    string                    `json:"-"`
	Uploads   []CommandAttachmentUpload `json:"-"`
}

type CommandAttachmentUpload struct {
	Name        string
	ContentType string
	Content     []byte
}

type CommandAttachmentView struct {
	AttachmentID string    `json:"attachmentId"`
	ProgramID    int64     `json:"programId"`
	ItemKey      string    `json:"itemKey"`
	Name         string    `json:"name"`
	ContentType  string    `json:"contentType"`
	Size         int64     `json:"size"`
	CreatedAt    time.Time `json:"createdAt"`
}

// CommandAttachmentContent is server/Worker-only. Content is intentionally
// absent from the PWA response model and never included in command results.
type CommandAttachmentContent struct {
	CommandAttachmentView
	Content []byte `json:"-"`
}
