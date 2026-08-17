// 阶段（stage）：项目路线图的横向分期，与任务内部的 Phase 不是一回事。

package delivery

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"contract"
	"service/delivery/dto"
	"service/delivery/internal/repository"
)

// ---------- 阶段 ----------

func (s *service) ListStages(ctx context.Context, bizLine contract.BizLine, programID int64) ([]dto.StageView, error) {
	rows, err := s.stages(ctx, bizLine, programID)
	if err != nil {
		return nil, err
	}
	views := make([]dto.StageView, 0, len(rows))
	for _, row := range rows {
		views = append(views, toStageView(row))
	}
	return views, nil
}

func (s *service) SaveStage(ctx context.Context, req dto.SaveStageRequest) error {
	if !req.BizLine.Valid() {
		return contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 || req.StageKey == "" {
		return errors.New("缺少项目或阶段标识")
	}
	if strings.TrimSpace(req.Tag) == "" || strings.TrimSpace(req.Title) == "" {
		return errors.New("阶段名称和目标不能为空")
	}
	return s.repo.UpsertStage(ctx, &repository.DeliveryStage{
		BizLine:       req.BizLine.String(),
		ProgramID:     req.ProgramID,
		StageKey:      req.StageKey,
		Seq:           req.Seq,
		Tag:           strings.TrimSpace(req.Tag),
		TimeWindow:    strings.TrimSpace(req.TimeWindow),
		MaturityLevel: strings.TrimSpace(req.MaturityLevel),
		Title:         strings.TrimSpace(req.Title),
	})
}

func (s *service) DeleteStage(ctx context.Context, req dto.DeleteStageRequest) error {
	if !req.BizLine.Valid() {
		return contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 || req.StageKey == "" {
		return errors.New("缺少项目或阶段标识")
	}
	return s.repo.Tx(ctx, func(tx *repository.DeliveryRepository) error {
		if err := tx.LockProgram(ctx, req.BizLine.String(), req.ProgramID); err != nil {
			return translate(err)
		}
		items, err := tx.CountItemsByStage(ctx, req.BizLine.String(), req.ProgramID, req.StageKey)
		if err != nil {
			return err
		}
		if items > 0 {
			return errors.New("该阶段仍有关联任务，不能删除")
		}
		rows, err := tx.DeleteStage(ctx, req.BizLine.String(), req.ProgramID, req.StageKey)
		if err != nil {
			return err
		}
		if rows == 0 {
			return contract.ErrNotFound
		}
		return nil
	})
}

func (s *service) stages(ctx context.Context, bizLine contract.BizLine, programID int64) ([]*repository.DeliveryStage, error) {
	if !bizLine.Valid() {
		return nil, contract.ErrBizLineRequired
	}
	if programID <= 0 {
		return nil, errors.New("缺少项目标识")
	}
	return s.repo.ListStages(ctx, bizLine.String(), programID)
}

func stageKeyOf(idx int) string { return "s" + strconv.Itoa(idx) }

func toStageView(row *repository.DeliveryStage) dto.StageView {
	return dto.StageView{
		StageKey:      row.StageKey,
		Seq:           row.Seq,
		Tag:           row.Tag,
		TimeWindow:    row.TimeWindow,
		MaturityLevel: row.MaturityLevel,
		Title:         row.Title,
	}
}
