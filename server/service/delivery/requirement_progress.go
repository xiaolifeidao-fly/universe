package delivery

import (
	"context"
	"errors"
	"strings"

	"contract"
	"service/delivery/dto"
	"service/delivery/internal/repository"
)

// GetRequirementProgress 返回一条需求的完整任务图，并用批次补充当前运行上下文。
func (s *service) GetRequirementProgress(ctx context.Context, query dto.RequirementProgressQuery) (dto.RequirementProgressView, error) {
	if !query.BizLine.Valid() {
		return dto.RequirementProgressView{}, contract.ErrBizLineRequired
	}
	if query.ProgramID <= 0 || strings.TrimSpace(query.RequirementKey) == "" {
		return dto.RequirementProgressView{}, errors.New("缺少项目或需求标识")
	}
	requirement, err := s.repo.FindRequirement(ctx, query.BizLine.String(), query.ProgramID, query.RequirementKey)
	if err != nil {
		return dto.RequirementProgressView{}, translate(err)
	}
	items, err := s.repo.ListAllItems(ctx, repository.ItemQuery{
		BizLine: query.BizLine.String(), ProgramID: query.ProgramID, RequirementKey: query.RequirementKey,
	})
	if err != nil {
		return dto.RequirementProgressView{}, err
	}
	dependencies, err := s.repo.ListItemDependencies(ctx, query.BizLine.String(), query.ProgramID)
	if err != nil {
		return dto.RequirementProgressView{}, err
	}
	batches, err := s.repo.ListRequirementExecutionBatches(ctx, query.BizLine.String(), query.ProgramID, query.RequirementKey)
	if err != nil {
		return dto.RequirementProgressView{}, err
	}
	batchIDs := make([]string, 0, len(batches))
	for _, batch := range batches {
		batchIDs = append(batchIDs, batch.BatchID)
	}
	batchItems, err := s.repo.ListExecutionBatchItemsByBatchIDs(ctx, query.BizLine.String(), query.ProgramID, batchIDs)
	if err != nil {
		return dto.RequirementProgressView{}, err
	}

	return buildRequirementProgressView(requirement, items, dependencies, batches, batchItems), nil
}

func buildRequirementProgressView(
	requirement *repository.DeliveryRequirement,
	items []*repository.DeliveryItem,
	dependencies []*repository.DeliveryItemDependency,
	batches []*repository.DeliveryExecutionBatch,
	batchItems []*repository.DeliveryExecutionBatchItem,
) dto.RequirementProgressView {
	statusCounts := map[string]int{
		StatusTodo: 0, StatusDoing: 0, StatusDone: 0, StatusBlocked: 0, StatusDropped: 0,
	}
	for _, item := range items {
		statusCounts[item.Status]++
	}
	itemsByBatch := make(map[string][]*repository.DeliveryExecutionBatchItem, len(batches))
	for _, item := range batchItems {
		itemsByBatch[item.BatchID] = append(itemsByBatch[item.BatchID], item)
	}
	batchViews := make([]dto.ExecutionBatchView, 0, len(batches))
	for _, batch := range batches {
		batchViews = append(batchViews, toExecutionBatchView(batch, itemsByBatch[batch.BatchID]))
	}
	return dto.RequirementProgressView{
		RequirementKey: requirement.RequirementKey, RequirementName: requirement.Name,
		TotalCount: len(items), CountedCount: countCounted(items), Progress: averageProgress(items),
		StatusCounts: statusCounts,
		Items:        toItemViews(items, dependencyKeysBySuccessor(dependencies), dependencySourceSidesBySuccessor(dependencies), dependencyTargetSidesBySuccessor(dependencies)),
		Batches:      batchViews,
	}
}
