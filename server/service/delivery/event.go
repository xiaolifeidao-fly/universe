// 任务流水：进展说明与字段变更历史。任务删了流水也留着。

package delivery

import (
	"context"
	"errors"
	"strings"

	"contract"
	"service/delivery/dto"
	"service/delivery/internal/repository"
)

func (s *service) Comment(ctx context.Context, req dto.CommentRequest) error {
	if !req.BizLine.Valid() {
		return contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 || req.ItemKey == "" {
		return errors.New("缺少项目或任务标识")
	}
	if strings.TrimSpace(req.Comment) == "" {
		return errors.New("进展说明不能为空")
	}
	item, err := s.repo.FindItem(ctx, req.BizLine.String(), req.ProgramID, req.ItemKey)
	if err != nil {
		return translate(err)
	}
	return s.repo.AppendEvents(ctx, []*repository.DeliveryItemEvent{{
		BizLine:        req.BizLine.String(),
		ProgramID:      req.ProgramID,
		ItemKey:        req.ItemKey,
		RequirementKey: item.RequirementKey,
		Kind:           "comment",
		Comment:        strings.TrimSpace(req.Comment),
		ActorID:        req.ActorID,
		ActorName:      req.ActorName,
	}})
}

func (s *service) ListEvents(ctx context.Context, query dto.EventQuery) (dto.EventPage, error) {
	if !query.BizLine.Valid() {
		return dto.EventPage{}, contract.ErrBizLineRequired
	}
	if query.ProgramID <= 0 {
		return dto.EventPage{}, errors.New("缺少项目标识")
	}
	rows, total, err := s.repo.ListEvents(ctx, repository.EventQuery{
		BizLine:   query.BizLine.String(),
		ProgramID: query.ProgramID,
		ItemKey:   query.ItemKey,
		Offset:    query.Offset(),
		Limit:     query.Limit(),
	})
	if err != nil {
		return dto.EventPage{}, err
	}
	views := make([]dto.EventView, 0, len(rows))
	for _, row := range rows {
		views = append(views, dto.EventView{
			ItemKey:   row.ItemKey,
			Kind:      row.Kind,
			Field:     row.Field,
			FromValue: row.FromValue,
			ToValue:   row.ToValue,
			Comment:   row.Comment,
			ActorID:   row.ActorID,
			ActorName: row.ActorName,
			CreatedAt: row.CreatedTime,
		})
	}
	return dto.EventPage{Total: total, Data: views}, nil
}

// ListRequirementTimeline 把需求本身与其下任务的事件按时间归并。
// 任务事件写入时冻结需求键，所以任务被删除、移动到其他需求后，原需求仍能保留完整的过程记录。
func (s *service) ListRequirementTimeline(ctx context.Context, query dto.RequirementTimelineQuery) (dto.RequirementTimelinePage, error) {
	if !query.BizLine.Valid() {
		return dto.RequirementTimelinePage{}, contract.ErrBizLineRequired
	}
	if query.ProgramID <= 0 || strings.TrimSpace(query.RequirementKey) == "" {
		return dto.RequirementTimelinePage{}, errors.New("缺少项目或需求标识")
	}
	if _, err := s.repo.FindRequirement(ctx, query.BizLine.String(), query.ProgramID, query.RequirementKey); err != nil {
		return dto.RequirementTimelinePage{}, translate(err)
	}
	rows, total, err := s.repo.ListRequirementTimeline(ctx, repository.RequirementTimelineQuery{
		BizLine:        query.BizLine.String(),
		ProgramID:      query.ProgramID,
		RequirementKey: query.RequirementKey,
		Offset:         query.Offset(),
		Limit:          query.Limit(),
	})
	if err != nil {
		return dto.RequirementTimelinePage{}, err
	}
	views := make([]dto.RequirementTimelineEventView, 0, len(rows))
	for _, row := range rows {
		views = append(views, dto.RequirementTimelineEventView{
			Source: row.Source, ItemKey: row.ItemKey, Kind: row.Kind, Field: row.Field,
			FromValue: row.FromValue, ToValue: row.ToValue, Comment: row.Comment,
			ActorID: row.ActorID, ActorName: row.ActorName, CreatedAt: row.CreatedAt,
		})
	}
	return dto.RequirementTimelinePage{Total: total, Data: views}, nil
}
