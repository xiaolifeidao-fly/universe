// 导入：从原型 assets/tasks.json 覆盖写一个项目的全部路线图数据。

package delivery

import (
	"context"
	"errors"

	"contract"
	"service/delivery/dto"
	"service/delivery/internal/repository"
)

// ImportItems 从原型 assets/tasks.json 导入 / 覆盖一个项目的全部路线图数据。
// 阶段按 idx 生成 stage_key（s0..s4）—— 原型用数组下标当键，插一个阶段就整体错位。
func (s *service) ImportItems(ctx context.Context, req dto.ImportRequest) (dto.ImportResult, error) {
	if !req.BizLine.Valid() {
		return dto.ImportResult{}, contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 {
		return dto.ImportResult{}, errors.New("缺少项目标识")
	}

	name := req.ProgramName
	if name == "" {
		name = req.Meta.Name
	}
	actor := actorOf(req.ActorID, req.ActorName)
	result := dto.ImportResult{}

	err := s.repo.Tx(ctx, func(tx *repository.DeliveryRepository) error {
		program, err := tx.FindProgram(ctx, req.BizLine.String(), req.ProgramID)
		if err != nil {
			return translate(err)
		}
		if name != "" && name != program.Name {
			if err := tx.SaveProgram(ctx, &repository.DeliveryProgram{
				Id: program.Id, BizLine: program.BizLine, ProgramCode: program.ProgramCode,
				Name: name, Summary: program.Summary, Status: program.Status,
				CreatedBy: program.CreatedBy, UpdatedBy: actor,
			}); err != nil {
				return err
			}
		}

		for _, stage := range req.Stages {
			if err := tx.UpsertStage(ctx, &repository.DeliveryStage{
				BizLine:       req.BizLine.String(),
				ProgramID:     req.ProgramID,
				StageKey:      stageKeyOf(stage.Idx),
				Seq:           stage.Idx,
				Tag:           stage.Tag,
				TimeWindow:    stage.When,
				MaturityLevel: stage.Lv,
				Title:         stage.Title,
			}); err != nil {
				return err
			}
			result.Stages++
		}

		for seq, module := range req.Modules {
			if err := tx.UpsertModule(ctx, &repository.DeliveryModule{
				BizLine:   req.BizLine.String(),
				ProgramID: req.ProgramID,
				ModuleKey: module.ID,
				Seq:       seq,
				Name:      module.Name,
				Weight:    module.Weight,
				Kind:      module.Kind,
			}); err != nil {
				return err
			}
			result.Modules++
		}

		for seq, task := range req.Tasks {
			if task.ID == "" {
				return errors.New("导入数据里有任务缺少 id")
			}
			status, err := normalizeStatus(task.Status)
			if err != nil {
				return err
			}
			due, err := parseDate(task.Due)
			if err != nil {
				return err
			}
			created, err := tx.UpsertItem(ctx, &repository.DeliveryItem{
				BizLine:                 req.BizLine.String(),
				ProgramID:               req.ProgramID,
				ItemKey:                 task.ID,
				StageKey:                stageKeyOf(task.Stage),
				ModuleKey:               task.Module,
				Kind:                    normalizeKindOrDefault(task.Type, KindGap),
				Title:                   task.Title,
				Description:             task.Desc,
				RequirementDocumentPath: requirementDocumentPath("", task.Module, task.ID),
				Phase:                   phaseForLegacyStatus(status),
				Status:                  status,
				Progress:                normalizeProgress(status, task.Progress),
				OwnerName:               task.Owner,
				DueDate:                 due,
				Note:                    task.Note,
				SortOrder:               seq,
				CreatedBy:               actor,
				UpdatedBy:               actor,
			})
			if err != nil {
				return err
			}
			if created {
				result.Created++
			} else {
				result.Updated++
			}
		}
		return nil
	})
	if err != nil {
		return dto.ImportResult{}, err
	}
	return result, nil
}
