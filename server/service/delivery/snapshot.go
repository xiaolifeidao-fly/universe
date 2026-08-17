// 快照：按日冻结项目与模块的进度，供趋势图使用。

package delivery

import (
	"context"
	"errors"
	"time"

	"contract"
	"service/delivery/dto"
	"service/delivery/internal/repository"
)

// ---------- 快照 ----------

func (s *service) RebuildSnapshot(ctx context.Context, req dto.RebuildSnapshotRequest) ([]dto.SnapshotView, error) {
	if !req.BizLine.Valid() {
		return nil, contract.ErrBizLineRequired
	}
	overview, err := s.Overview(ctx, req.BizLine, req.ProgramID)
	if err != nil {
		return nil, err
	}

	now := time.Now()
	statDate := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local)
	if req.StatDate != "" {
		parsed, err := time.ParseInLocation(dateLayout, req.StatDate, time.Local)
		if err != nil {
			return nil, errors.New("统计日期格式应为 2006-01-02")
		}
		statDate = parsed
	}

	items, err := s.repo.ListAllItems(ctx, repository.ItemQuery{
		BizLine:   req.BizLine.String(),
		ProgramID: req.ProgramID,
	})
	if err != nil {
		return nil, err
	}

	rows := []*repository.DeliverySnapshot{{
		BizLine:       req.BizLine.String(),
		ProgramID:     req.ProgramID,
		StatDate:      statDate,
		ModuleKey:     "",
		Progress:      overview.PlainProgress,
		MaturityScore: overview.MaturityScore,
		TotalCount:    countCounted(items),
		DoneCount:     countStatus(items, StatusDone),
		DoingCount:    countStatus(items, StatusDoing),
		BlockedCount:  countStatus(items, StatusBlocked),
	}}
	for _, module := range overview.ModuleProgress {
		scoped := pick(items, func(item *repository.DeliveryItem) bool { return item.ModuleKey == module.ModuleKey })
		rows = append(rows, &repository.DeliverySnapshot{
			BizLine:      req.BizLine.String(),
			ProgramID:    req.ProgramID,
			StatDate:     statDate,
			ModuleKey:    module.ModuleKey,
			Progress:     module.Progress,
			TotalCount:   countCounted(scoped),
			DoneCount:    countStatus(scoped, StatusDone),
			DoingCount:   countStatus(scoped, StatusDoing),
			BlockedCount: countStatus(scoped, StatusBlocked),
		})
	}

	views := make([]dto.SnapshotView, 0, len(rows))
	for _, row := range rows {
		if err := s.repo.UpsertSnapshot(ctx, row); err != nil {
			return nil, err
		}
		views = append(views, toSnapshotView(row))
	}
	return views, nil
}

func (s *service) ListSnapshots(ctx context.Context, query dto.SnapshotQuery) ([]dto.SnapshotView, error) {
	if !query.BizLine.Valid() {
		return nil, contract.ErrBizLineRequired
	}
	if query.ProgramID <= 0 {
		return nil, errors.New("缺少项目标识")
	}
	from, err := parseDate(query.From)
	if err != nil {
		return nil, err
	}
	to, err := parseDate(query.To)
	if err != nil {
		return nil, err
	}
	rows, err := s.repo.ListSnapshots(ctx, repository.SnapshotQuery{
		BizLine:   query.BizLine.String(),
		ProgramID: query.ProgramID,
		ModuleKey: query.ModuleKey,
		From:      from,
		To:        to,
		Limit:     400,
	})
	if err != nil {
		return nil, err
	}
	views := make([]dto.SnapshotView, 0, len(rows))
	for _, row := range rows {
		views = append(views, toSnapshotView(row))
	}
	return views, nil
}

func toSnapshotView(row *repository.DeliverySnapshot) dto.SnapshotView {
	return dto.SnapshotView{
		StatDate:      row.StatDate.Format(dateLayout),
		ModuleKey:     row.ModuleKey,
		Progress:      row.Progress,
		MaturityScore: row.MaturityScore,
		TotalCount:    row.TotalCount,
		DoneCount:     row.DoneCount,
		DoingCount:    row.DoingCount,
		BlockedCount:  row.BlockedCount,
	}
}
