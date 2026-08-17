// 看板与概览：两条统计口径（进度、成熟度）在这里定死，前端不许自己再算一遍。

package delivery

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"contract"
	"service/delivery/dto"
	"service/delivery/internal/repository"
)

// ---------- 看板 ----------

func (s *service) Board(ctx context.Context, query dto.BoardQuery) (dto.BoardView, error) {
	if !query.BizLine.Valid() {
		return dto.BoardView{}, contract.ErrBizLineRequired
	}
	if query.ProgramID <= 0 {
		return dto.BoardView{}, errors.New("缺少项目标识")
	}

	groupBy := query.GroupBy
	if groupBy == "" {
		groupBy = "stage"
	}
	if groupBy != "stage" && groupBy != "status" && groupBy != "module" {
		return dto.BoardView{}, errors.New("分列方式只能是 stage / status / module")
	}
	phase := ""
	if groupBy == "status" || query.Phase != "" {
		var err error
		phase, err = normalizePhase(query.Phase)
		if err != nil {
			return dto.BoardView{}, err
		}
	}

	stages, err := s.stages(ctx, query.BizLine, query.ProgramID)
	if err != nil {
		return dto.BoardView{}, err
	}
	modules, err := s.modules(ctx, query.BizLine, query.ProgramID)
	if err != nil {
		return dto.BoardView{}, err
	}

	// 看板取全量：一个项目几十到几百条，分页反而要多轮往返。
	filtered, err := s.repo.ListAllItems(ctx, repository.ItemQuery{
		BizLine:        query.BizLine.String(),
		ProgramID:      query.ProgramID,
		StageKey:       query.StageKey,
		ModuleKey:      query.ModuleKey,
		RequirementKey: query.RequirementKey,
		Status:         query.Status,
		Phase:          phase,
		Kind:           normalizeKind(query.Kind),
		OwnerName:      query.OwnerName,
		Keyword:        query.Keyword,
	})
	if err != nil {
		return dto.BoardView{}, err
	}
	dependencies, err := s.repo.ListItemDependencies(ctx, query.BizLine.String(), query.ProgramID)
	if err != nil {
		return dto.BoardView{}, err
	}
	dependsOn := dependencyKeysBySuccessor(dependencies)
	dependencySourceSides := dependencySourceSidesBySuccessor(dependencies)
	dependencyTargetSides := dependencyTargetSidesBySuccessor(dependencies)

	// 空项目也要返回 []，不能让 Go 的 nil slice 变成 JSON null。
	columns := make([]dto.BoardColumn, 0, len(stages)+len(modules)+len(statusOrder))
	switch groupBy {
	case "stage":
		for _, stage := range stages {
			columns = append(columns, buildColumn(stage.StageKey, stage.Tag,
				strings.TrimSpace(stage.TimeWindow+" · "+stage.MaturityLevel),
				pick(filtered, func(item *repository.DeliveryItem) bool { return item.StageKey == stage.StageKey }), dependsOn, dependencySourceSides, dependencyTargetSides))
		}
	case "module":
		for _, module := range modules {
			columns = append(columns, buildColumn(module.ModuleKey, module.Name,
				fmt.Sprintf("权重 %d%%", module.Weight),
				pick(filtered, func(item *repository.DeliveryItem) bool { return item.ModuleKey == module.ModuleKey }), dependsOn, dependencySourceSides, dependencyTargetSides))
		}
	case "status":
		for _, status := range statusOrder {
			items := pick(filtered, func(item *repository.DeliveryItem) bool { return item.Status == status })
			column := buildColumn(status, statusNames[status], "", items, dependsOn, dependencySourceSides, dependencyTargetSides)
			column.DoneCount = countStatus(items, StatusDone)
			columns = append(columns, column)
		}
	}

	// 概览始终基于全量数据算 —— 筛选是看的问题，成熟度是事实。
	overview, err := s.Overview(ctx, query.BizLine, query.ProgramID)
	if err != nil {
		return dto.BoardView{}, err
	}
	return dto.BoardView{
		ProgramID: query.ProgramID,
		GroupBy:   groupBy,
		Columns:   columns,
		Overview:  overview,
	}, nil
}

func (s *service) Overview(ctx context.Context, bizLine contract.BizLine, programID int64) (dto.ProgramOverview, error) {
	if !bizLine.Valid() {
		return dto.ProgramOverview{}, contract.ErrBizLineRequired
	}
	if programID <= 0 {
		return dto.ProgramOverview{}, errors.New("缺少项目标识")
	}

	program, err := s.repo.FindProgram(ctx, bizLine.String(), programID)
	if err != nil {
		return dto.ProgramOverview{}, translate(err)
	}
	stages, err := s.stages(ctx, bizLine, programID)
	if err != nil {
		return dto.ProgramOverview{}, err
	}
	modules, err := s.modules(ctx, bizLine, programID)
	if err != nil {
		return dto.ProgramOverview{}, err
	}
	items, err := s.repo.ListAllItems(ctx, repository.ItemQuery{
		BizLine:   bizLine.String(),
		ProgramID: programID,
	})
	if err != nil {
		return dto.ProgramOverview{}, err
	}

	overview := dto.ProgramOverview{
		ProgramID:      programID,
		Name:           program.Name,
		TotalCount:     len(items),
		StatusCounts:   map[string]int{},
		ModuleProgress: make([]dto.ModuleProgressView, 0, len(modules)),
		StageProgress:  make([]dto.StageProgressView, 0, len(stages)),
	}
	for _, status := range statusOrder {
		overview.StatusCounts[status] = 0
	}
	for _, item := range items {
		overview.StatusCounts[item.Status]++
	}
	overview.PlainProgress = averageProgress(items)

	var weightSum, weighted float64
	for _, module := range modules {
		scoped := pick(items, func(item *repository.DeliveryItem) bool { return item.ModuleKey == module.ModuleKey })
		progress := averageProgress(scoped)
		overview.ModuleProgress = append(overview.ModuleProgress, dto.ModuleProgressView{
			ModuleKey: module.ModuleKey,
			Name:      module.Name,
			Weight:    module.Weight,
			Kind:      module.Kind,
			Total:     countCounted(scoped),
			DoneCount: countStatus(scoped, StatusDone),
			Progress:  progress,
		})
		// 没有任务的模块不参与加权：它的 0% 不是「没做」，是「没登记」，
		// 算进去会把整体成熟度压虚。
		if countCounted(scoped) == 0 {
			continue
		}
		weightSum += float64(module.Weight)
		weighted += float64(module.Weight) * progress
	}
	if weightSum > 0 {
		overview.MaturityScore = round2(weighted / weightSum)
	} else {
		overview.MaturityScore = overview.PlainProgress
	}

	for _, stage := range stages {
		scoped := pick(items, func(item *repository.DeliveryItem) bool { return item.StageKey == stage.StageKey })
		overview.StageProgress = append(overview.StageProgress, dto.StageProgressView{
			StageKey:      stage.StageKey,
			Tag:           stage.Tag,
			MaturityLevel: stage.MaturityLevel,
			Total:         countCounted(scoped),
			DoneCount:     countStatus(scoped, StatusDone),
			Progress:      averageProgress(scoped),
		})
	}
	return overview, nil
}

func buildColumn(
	key, name, subtitle string,
	items []*repository.DeliveryItem,
	dependsOn map[string][]string,
	dependencySourceSides map[string]map[string]string,
	dependencyTargetSides map[string]map[string]string,
) dto.BoardColumn {
	return dto.BoardColumn{
		Key:       key,
		Name:      name,
		Subtitle:  strings.Trim(subtitle, " ·"),
		Total:     len(items),
		DoneCount: countStatus(items, StatusDone),
		Progress:  averageProgress(items),
		Items:     toItemViews(items, dependsOn, dependencySourceSides, dependencyTargetSides),
	}
}

func pick(items []*repository.DeliveryItem, match func(*repository.DeliveryItem) bool) []*repository.DeliveryItem {
	picked := make([]*repository.DeliveryItem, 0, len(items))
	for _, item := range items {
		if match(item) {
			picked = append(picked, item)
		}
	}
	return picked
}

// averageProgress 排除 dropped：不做的事不该拉低也不该抬高进度。
func averageProgress(items []*repository.DeliveryItem) float64 {
	var sum, count float64
	for _, item := range items {
		if item.Status == StatusDropped {
			continue
		}
		sum += float64(progressOf(item))
		count++
	}
	if count == 0 {
		return 0
	}
	return round2(sum / count)
}

func countCounted(items []*repository.DeliveryItem) int {
	count := 0
	for _, item := range items {
		if item.Status != StatusDropped {
			count++
		}
	}
	return count
}

func countStatus(items []*repository.DeliveryItem, status string) int {
	count := 0
	for _, item := range items {
		if item.Status == status {
			count++
		}
	}
	return count
}
