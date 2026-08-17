// 项目（program）：交付看板的顶层容器，业务线迁移也在这里。

package delivery

import (
	"context"
	"errors"
	"strings"
	"time"

	"contract"
	"service/delivery/dto"
	"service/delivery/internal/repository"
)

// ---------- 项目 ----------

func (s *service) ListPrograms(ctx context.Context, bizLine contract.BizLine) ([]dto.ProgramView, error) {
	if !bizLine.Valid() {
		return nil, contract.ErrBizLineRequired
	}
	rows, err := s.repo.ListPrograms(ctx, bizLine.String())
	if err != nil {
		return nil, err
	}
	views := make([]dto.ProgramView, 0, len(rows))
	for _, row := range rows {
		views = append(views, toProgramView(row))
	}
	return views, nil
}

func (s *service) ResolveProgramBizLine(ctx context.Context, programID int64) (contract.BizLine, error) {
	if programID <= 0 {
		return "", errors.New("缺少项目标识")
	}
	program, err := s.repo.FindProgramByID(ctx, programID)
	if err != nil {
		return "", translate(err)
	}
	bizLine := contract.BizLine(program.BizLine)
	if !bizLine.Valid() {
		return "", contract.ErrBizLineRequired
	}
	return bizLine, nil
}

func (s *service) CountPrograms(ctx context.Context, bizLine contract.BizLine) (int64, error) {
	if !bizLine.Valid() {
		return 0, contract.ErrBizLineRequired
	}
	return s.repo.CountPrograms(ctx, bizLine.String())
}

func (s *service) GetProgram(ctx context.Context, bizLine contract.BizLine, programID int64) (dto.ProgramView, error) {
	if !bizLine.Valid() {
		return dto.ProgramView{}, contract.ErrBizLineRequired
	}
	if programID <= 0 {
		return dto.ProgramView{}, errors.New("缺少项目标识")
	}
	row, err := s.repo.FindProgram(ctx, bizLine.String(), programID)
	if err != nil {
		return dto.ProgramView{}, translate(err)
	}
	return toProgramView(row), nil
}

func (s *service) SaveProgram(ctx context.Context, req dto.SaveProgramRequest) error {
	if !req.BizLine.Valid() {
		return contract.ErrBizLineRequired
	}
	programCode := strings.TrimSpace(req.ProgramCode)
	if req.ProgramID == 0 && programCode == "" {
		return errors.New("缺少项目编码")
	}
	status := req.Status
	if status == "" {
		status = "active"
	}
	if req.ProgramID > 0 && programCode == "" {
		existing, err := s.repo.FindProgram(ctx, req.BizLine.String(), req.ProgramID)
		if err != nil {
			return translate(err)
		}
		programCode = existing.ProgramCode
	}
	return s.repo.SaveProgram(ctx, &repository.DeliveryProgram{
		Id:          req.ProgramID,
		BizLine:     req.BizLine.String(),
		ProgramCode: programCode,
		Name:        req.Name,
		Summary:     req.Summary,
		Status:      status,
		CreatedBy:   actorOf(req.ActorID, req.ActorName),
		UpdatedBy:   actorOf(req.ActorID, req.ActorName),
	})
}

func (s *service) MigrateProgram(ctx context.Context, req dto.MigrateProgramRequest) error {
	if !req.SourceBizLine.Valid() || !req.TargetBizLine.Valid() {
		return contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 {
		return errors.New("缺少项目标识")
	}
	if req.SourceBizLine == req.TargetBizLine {
		current, err := s.repo.FindProgram(ctx, req.SourceBizLine.String(), req.ProgramID)
		if err != nil {
			return translate(err)
		}
		return s.SaveProgram(ctx, dto.SaveProgramRequest{
			BizLine: req.SourceBizLine, ProgramID: req.ProgramID, Name: req.Name,
			ProgramCode: current.ProgramCode,
			Summary:     req.Summary, Status: req.Status, ActorID: req.ActorID, ActorName: req.ActorName,
		})
	}

	status := req.Status
	if status == "" {
		status = "active"
	}
	actor := actorOf(req.ActorID, req.ActorName)
	return s.repo.Tx(ctx, func(tx *repository.DeliveryRepository) error {
		if err := tx.LockProgram(ctx, req.SourceBizLine.String(), req.ProgramID); err != nil {
			return translate(err)
		}
		rows, err := tx.MoveProgramBizLine(ctx, req.SourceBizLine.String(), req.TargetBizLine.String(), req.ProgramID, map[string]any{
			"name": req.Name, "summary": req.Summary, "status": status,
			"updated_by": actor, "updated_time": time.Now(),
		})
		if err != nil {
			return err
		}
		if rows == 0 {
			return contract.ErrNotFound
		}
		return nil
	})
}

func toProgramView(row *repository.DeliveryProgram) dto.ProgramView {
	updated := row.UpdatedTime
	return dto.ProgramView{
		ProgramID:   row.Id,
		ProgramCode: row.ProgramCode,
		BizLine:     contract.BizLine(row.BizLine),
		Name:        row.Name,
		Summary:     row.Summary,
		Status:      row.Status,
		UpdatedBy:   row.UpdatedBy,
		UpdatedAt:   &updated,
	}
}
