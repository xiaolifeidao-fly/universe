// 模块（module）：项目的纵向能力划分，带权重，参与成熟度加权。

package delivery

import (
	"context"
	"errors"
	"strings"

	"contract"
	"service/delivery/dto"
	"service/delivery/internal/repository"
)

// ---------- 模块 ----------

func (s *service) ListModules(ctx context.Context, bizLine contract.BizLine, programID int64) ([]dto.ModuleView, error) {
	rows, err := s.modules(ctx, bizLine, programID)
	if err != nil {
		return nil, err
	}
	return s.moduleViews(ctx, bizLine.String(), programID, rows)
}

func (s *service) ListModulesPage(ctx context.Context, query dto.ModuleQuery) (dto.ModulePage, error) {
	if !query.BizLine.Valid() {
		return dto.ModulePage{}, contract.ErrBizLineRequired
	}
	if query.ProgramID <= 0 {
		return dto.ModulePage{}, errors.New("缺少项目标识")
	}
	rows, total, err := s.repo.ListModulesPage(ctx, query.BizLine.String(), query.ProgramID, query.Offset(), query.Limit())
	if err != nil {
		return dto.ModulePage{}, err
	}
	views, err := s.moduleViews(ctx, query.BizLine.String(), query.ProgramID, rows)
	if err != nil {
		return dto.ModulePage{}, err
	}
	return dto.ModulePage{Total: total, Data: views}, nil
}

func (s *service) SaveModule(ctx context.Context, req dto.SaveModuleRequest) error {
	if !req.BizLine.Valid() {
		return contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 || req.ModuleKey == "" {
		return errors.New("缺少项目或模块标识")
	}
	if req.Weight < 0 {
		return errors.New("模块权重不能为负数")
	}
	if strings.TrimSpace(req.Name) == "" {
		return errors.New("模块名称不能为空")
	}
	return s.repo.UpsertModule(ctx, &repository.DeliveryModule{
		BizLine:   req.BizLine.String(),
		ProgramID: req.ProgramID,
		ModuleKey: req.ModuleKey,
		Seq:       req.Seq,
		Name:      strings.TrimSpace(req.Name),
		Weight:    req.Weight,
		Kind:      req.Kind,
	})
}

func (s *service) DeleteModule(ctx context.Context, req dto.DeleteModuleRequest) error {
	if !req.BizLine.Valid() {
		return contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 || req.ModuleKey == "" {
		return errors.New("缺少项目或模块标识")
	}
	return s.repo.Tx(ctx, func(tx *repository.DeliveryRepository) error {
		if err := tx.LockProgram(ctx, req.BizLine.String(), req.ProgramID); err != nil {
			return translate(err)
		}
		items, err := tx.CountItemsByModule(ctx, req.BizLine.String(), req.ProgramID, req.ModuleKey)
		if err != nil {
			return err
		}
		if items > 0 {
			if req.TargetModuleKey == "" {
				return errors.New("该模块仍有关联任务，请选择接收任务的模块")
			}
			if req.TargetModuleKey == req.ModuleKey {
				return errors.New("接收任务的模块不能与待删除模块相同")
			}
			if _, err := tx.FindModule(ctx, req.BizLine.String(), req.ProgramID, req.TargetModuleKey); err != nil {
				return translate(err)
			}
			moved, err := tx.MoveItemsToModule(ctx, req.BizLine.String(), req.ProgramID, req.ModuleKey, req.TargetModuleKey)
			if err != nil {
				return err
			}
			if moved != items {
				return errors.New("迁移关联任务时数据已变化，请刷新后重试")
			}
		}
		rows, err := tx.DeleteModule(ctx, req.BizLine.String(), req.ProgramID, req.ModuleKey)
		if err != nil {
			return err
		}
		if rows == 0 {
			return contract.ErrNotFound
		}
		return nil
	})
}

func (s *service) modules(ctx context.Context, bizLine contract.BizLine, programID int64) ([]*repository.DeliveryModule, error) {
	if !bizLine.Valid() {
		return nil, contract.ErrBizLineRequired
	}
	if programID <= 0 {
		return nil, errors.New("缺少项目标识")
	}
	return s.repo.ListModules(ctx, bizLine.String(), programID)
}

func (s *service) moduleViews(ctx context.Context, bizLine string, programID int64, rows []*repository.DeliveryModule) ([]dto.ModuleView, error) {
	counts, err := s.repo.ListModuleItemCounts(ctx, bizLine, programID)
	if err != nil {
		return nil, err
	}
	views := make([]dto.ModuleView, 0, len(rows))
	for _, row := range rows {
		views = append(views, toModuleView(row, counts[row.ModuleKey]))
	}
	return views, nil
}

func toModuleView(row *repository.DeliveryModule, itemCount int64) dto.ModuleView {
	return dto.ModuleView{
		ModuleKey: row.ModuleKey,
		Seq:       row.Seq,
		Name:      row.Name,
		Weight:    row.Weight,
		Kind:      row.Kind,
		ItemCount: itemCount,
	}
}
