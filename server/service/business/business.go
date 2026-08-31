// Package business owns the business-side requirement intake.
//
// It deliberately does not reuse service/delivery's requirement model: a
// business submission remains raw input until a later product/research process
// explicitly decides how it should be assessed or transformed.
package business

import (
	"context"

	"contract"
	"service/business/dto"
	"service/business/internal/repository"

	"gorm.io/gorm"
)

const RequirementStatusSubmitted = "submitted"

type Service interface {
	ListPrograms(context.Context, contract.BizLine) ([]dto.ProgramContext, error)
	ListRequirements(context.Context, dto.RequirementQuery) (dto.RequirementPage, error)
	ListCollectedRequirements(context.Context, dto.CollectedRequirementQuery) (dto.RequirementPage, error)
	CreateRequirement(context.Context, dto.CreateRequirementRequest) (dto.RequirementView, error)
	GetConversation(context.Context, dto.ConversationQuery) (dto.ConversationView, error)
	GetCollectedConversation(context.Context, dto.CollectedConversationQuery) (dto.ConversationView, error)
	SendMessage(context.Context, dto.SendMessageRequest) (dto.SendMessageResult, error)
	ListDocumentReferences(context.Context, dto.DocumentReferenceQuery) ([]dto.DocumentReferenceView, error)
	UploadAttachments(context.Context, dto.UploadAttachmentsRequest) ([]dto.AttachmentView, error)
	GetAttachment(context.Context, dto.AttachmentQuery) (dto.AttachmentContent, error)
}

// ProgramReader only validates the selected project and resolves its space.
// The business domain must not import the delivery domain implementation.
type ProgramReader interface {
	ListProgramContexts(context.Context, contract.BizLine) ([]dto.ProgramContext, error)
	ResolveProgramBizLine(context.Context, int64) (contract.BizLine, error)
	GetProgramContext(context.Context, contract.BizLine, int64) (dto.ProgramContext, error)
}

// Assistant is the only outward-facing dependency of the business domain.
// Its implementation is injected at the composition root and calls the
// remote Kodes Bridge with the same POST/GET conversation protocol that the
// local delivery plugin uses. The domain never invokes a user's local bridge.
type Assistant interface {
	Start(context.Context, dto.ConversationStartRequest) (dto.ConversationAction, error)
	Poll(context.Context, int64, int64, string, string, string) (dto.ConversationState, error)
	// UploadAttachments stores browser files in the requirement's remote
	// business workspace; DownloadAttachment reads one back for preview.
	UploadAttachments(context.Context, int64, int64, string, []dto.AttachmentUpload) ([]dto.AttachmentView, error)
	DownloadAttachment(context.Context, int64, int64, string, string) (dto.AttachmentContent, error)
}

type service struct {
	repo      *repository.BusinessRepository
	programs  ProgramReader
	assistant Assistant
}

func New(database *gorm.DB, programs ProgramReader, assistant Assistant) Service {
	repo := &repository.BusinessRepository{}
	repo.SetDb(database)
	return &service{repo: repo, programs: programs, assistant: assistant}
}
