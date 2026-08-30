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
	ID            int64      `json:"id"`
	BizLine       string     `json:"bizLine"`
	ProgramID     int64      `json:"programId"`
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
	ID        int64      `json:"id"`
	Role      string     `json:"role"`
	Content   string     `json:"content"`
	CreatedAt *time.Time `json:"createdAt"`
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

type ConversationView struct {
	Requirement RequirementView `json:"requirement"`
	Program     ProgramContext  `json:"program"`
	Messages    []MessageView   `json:"messages"`
	Documents   []DocumentView  `json:"documents"`
}

type SendMessageRequest struct {
	RequirementID int64  `json:"requirementId"`
	Content       string `json:"content"`

	BizLine   contract.BizLine `json:"-"`
	CreatorID string           `json:"-"`
}

type SendMessageResult struct {
	UserMessage      MessageView  `json:"userMessage"`
	AssistantMessage MessageView  `json:"assistantMessage"`
	Document         DocumentView `json:"document"`
}
