// 任务（item）：看板的最小推进单元，含创建、阶段推进、局部更新与删除。

package delivery

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"gorm.io/gorm"

	"contract"
	"service/delivery/dto"
	"service/delivery/internal/repository"
)

const (
	ItemTestingCasesStatusTodo    = "todo"
	ItemTestingCasesStatusDoing   = "doing"
	ItemTestingCasesStatusReady   = "ready"
	ItemTestingCasesStatusBlocked = "blocked"
)

var itemTestingCasesStatuses = map[string]struct{}{
	ItemTestingCasesStatusTodo: {}, ItemTestingCasesStatusDoing: {},
	ItemTestingCasesStatusReady: {}, ItemTestingCasesStatusBlocked: {},
}

func itemTestingCasesStatusOrDefault(value string) string {
	status, err := normalizeItemTestingCasesStatus(value, ItemTestingCasesStatusTodo)
	if err != nil {
		return ItemTestingCasesStatusTodo
	}
	return status
}

func normalizeItemTestingCasesStatus(value, fallback string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		value = fallback
	}
	if _, ok := itemTestingCasesStatuses[value]; !ok {
		return "", fmt.Errorf("未知的任务测试用例状态：%s", value)
	}
	return value, nil
}

func itemTestingCasesPath(itemKey string) string {
	return "doc/test/" + itemKey + "/测试用例.md"
}

// UpdateItemTestingCases 仅更新与测试用例设计有关的字段。它可以在任意非 dropped 阶段运行，
// 从而不会阻断研发动作执行，也不会把任务置入 testing 阶段。
func (s *service) UpdateItemTestingCases(ctx context.Context, req dto.UpdateItemTestingCasesRequest) (dto.ItemView, error) {
	if !req.BizLine.Valid() {
		return dto.ItemView{}, contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 || strings.TrimSpace(req.ItemKey) == "" {
		return dto.ItemView{}, errors.New("缺少项目或任务标识")
	}
	status, err := normalizeItemTestingCasesStatus(req.TestingCasesStatus, "")
	if err != nil {
		return dto.ItemView{}, err
	}
	if req.TestingCases != nil && len(*req.TestingCases) > maxItemDocumentBytes {
		return dto.ItemView{}, errors.New("测试用例不能超过 8MB")
	}
	current, err := s.repo.FindItem(ctx, req.BizLine.String(), req.ProgramID, req.ItemKey)
	if err != nil {
		return dto.ItemView{}, translate(err)
	}
	if current.Status == StatusDropped {
		return dto.ItemView{}, errors.New("已中断的任务不能生成测试用例")
	}
	values := map[string]any{
		"testing_cases_status": status,
		"updated_by":           actorOf(req.ActorID, req.ActorName),
	}
	if req.TestingCases != nil {
		values["testing_cases"] = *req.TestingCases
		if strings.TrimSpace(*req.TestingCases) != "" {
			values["testing_cases_path"] = itemTestingCasesPath(req.ItemKey)
		}
	}
	events := make([]*repository.DeliveryItemEvent, 0, 2)
	if current.TestingCasesStatus != status {
		events = append(events, &repository.DeliveryItemEvent{
			BizLine: current.BizLine, ProgramID: current.ProgramID, ItemKey: current.ItemKey, RequirementKey: current.RequirementKey,
			Kind: "field", Field: "testingCasesStatus", FromValue: current.TestingCasesStatus, ToValue: status,
			ActorID: req.ActorID, ActorName: req.ActorName,
		})
	}
	if req.TestingCases != nil && current.TestingCases != *req.TestingCases {
		events = append(events, &repository.DeliveryItemEvent{
			BizLine: current.BizLine, ProgramID: current.ProgramID, ItemKey: current.ItemKey, RequirementKey: current.RequirementKey,
			Kind: "field", Field: "testingCases", FromValue: requirementTimelineValue(current.TestingCases), ToValue: requirementTimelineValue(*req.TestingCases),
			ActorID: req.ActorID, ActorName: req.ActorName,
		})
	}
	var affected int64
	if err := s.repo.Tx(ctx, func(tx *repository.DeliveryRepository) error {
		var updateErr error
		affected, updateErr = tx.UpdateItemTestingCases(ctx, req.BizLine.String(), req.ProgramID, req.ItemKey, values)
		if updateErr != nil {
			return updateErr
		}
		if affected == 0 {
			return errors.New("任务不存在")
		}
		return tx.AppendEvents(ctx, events)
	}); err != nil {
		return dto.ItemView{}, err
	}
	return s.GetItem(ctx, req.BizLine, req.ProgramID, req.ItemKey)
}

func (s *service) ListItems(ctx context.Context, query dto.ItemQuery) (dto.ItemPage, error) {
	if !query.BizLine.Valid() {
		return dto.ItemPage{}, contract.ErrBizLineRequired
	}
	if query.ProgramID <= 0 {
		return dto.ItemPage{}, errors.New("缺少项目标识")
	}
	recentFirst, err := itemListRecentFirst(query.Sort)
	if err != nil {
		return dto.ItemPage{}, err
	}
	rows, total, err := s.repo.ListItems(ctx, repository.ItemQuery{
		BizLine:        query.BizLine.String(),
		ProgramID:      query.ProgramID,
		StageKey:       query.StageKey,
		ModuleKey:      query.ModuleKey,
		RequirementKey: query.RequirementKey,
		Status:         query.Status,
		Phase:          query.Phase,
		Kind:           normalizeKind(query.Kind),
		OwnerName:      query.OwnerName,
		Keyword:        query.Keyword,
		RecentFirst:    recentFirst,
		Offset:         query.Offset(),
		Limit:          query.Limit(),
	})
	if err != nil {
		return dto.ItemPage{}, err
	}
	dependencies, err := s.repo.ListItemDependencies(ctx, query.BizLine.String(), query.ProgramID)
	if err != nil {
		return dto.ItemPage{}, err
	}
	return dto.ItemPage{Total: total, Data: toItemViews(rows, dependencyKeysBySuccessor(dependencies), dependencySourceSidesBySuccessor(dependencies), dependencyTargetSidesBySuccessor(dependencies))}, nil
}

// itemListRecentFirst 只允许声明过的排序，不能把浏览器传入的字符串拼进 SQL 的 ORDER BY。
func itemListRecentFirst(sort string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(sort)) {
	case "":
		return false, nil
	case "recent":
		return true, nil
	default:
		return false, errors.New("未知的任务排序方式")
	}
}

func (s *service) GetItem(ctx context.Context, bizLine contract.BizLine, programID int64, itemKey string) (dto.ItemView, error) {
	if !bizLine.Valid() {
		return dto.ItemView{}, contract.ErrBizLineRequired
	}
	if programID <= 0 || itemKey == "" {
		return dto.ItemView{}, errors.New("缺少项目或任务标识")
	}
	row, err := s.repo.FindItem(ctx, bizLine.String(), programID, itemKey)
	if err != nil {
		return dto.ItemView{}, translate(err)
	}
	dependencies, err := s.repo.ListItemDependencies(ctx, bizLine.String(), programID)
	if err != nil {
		return dto.ItemView{}, err
	}
	return toItemDetailView(row, dependencyKeysBySuccessor(dependencies)[itemKey], dependencySourceSidesBySuccessor(dependencies)[itemKey], dependencyTargetSidesBySuccessor(dependencies)[itemKey]), nil
}

func (s *service) CreateItem(ctx context.Context, req dto.SaveItemRequest) (dto.ItemView, error) {
	if !req.BizLine.Valid() {
		return dto.ItemView{}, contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 {
		return dto.ItemView{}, errors.New("缺少项目标识")
	}
	if strings.TrimSpace(req.Title) == "" {
		return dto.ItemView{}, errors.New("任务标题不能为空")
	}

	status, err := normalizeStatus(req.Status)
	if err != nil {
		return dto.ItemView{}, err
	}
	phase, err := normalizePhase(req.Phase)
	if err != nil {
		return dto.ItemView{}, err
	}
	due, err := parseDate(req.DueDate)
	if err != nil {
		return dto.ItemView{}, err
	}

	itemKey := req.ItemKey
	if itemKey == "" {
		itemKey = generateItemKey(req.ModuleKey)
	}
	if _, err := s.repo.FindItem(ctx, req.BizLine.String(), req.ProgramID, itemKey); err == nil {
		return dto.ItemView{}, fmt.Errorf("任务 %s 已存在", itemKey)
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return dto.ItemView{}, err
	}
	dependsOnItemKeys := normalizeDependencyKeys(req.DependsOnItemKeys)
	dependencySourceSides := normalizeDependencySides(req.DependencySourceSides, dependsOnItemKeys)
	dependencyTargetSides := normalizeDependencyTargetSides(req.DependencyTargetSides, dependsOnItemKeys)
	benefitTagsJSON, _, err := marshalBenefitTags(req.BenefitTags)
	if err != nil {
		return dto.ItemView{}, err
	}
	allItems, err := s.repo.ListAllItems(ctx, repository.ItemQuery{
		BizLine: req.BizLine.String(), ProgramID: req.ProgramID,
	})
	if err != nil {
		return dto.ItemView{}, err
	}
	dependencies, err := s.repo.ListItemDependencies(ctx, req.BizLine.String(), req.ProgramID)
	if err != nil {
		return dto.ItemView{}, err
	}
	if err := validateDependencyChange(allItems, dependencies, itemKey, dependsOnItemKeys); err != nil {
		return dto.ItemView{}, err
	}

	actor := actorOf(req.ActorID, req.ActorName)
	row := &repository.DeliveryItem{
		BizLine:        req.BizLine.String(),
		ProgramID:      req.ProgramID,
		ItemKey:        itemKey,
		StageKey:       req.StageKey,
		ModuleKey:      req.ModuleKey,
		RequirementKey: strings.TrimSpace(req.RequirementKey),
		// 拆解批次非必填：手工建的任务留空，只有拆解写入才带批次键。
		PlanningBatchKey: strings.TrimSpace(req.PlanningBatchKey),
		Kind:             normalizeKindOrDefault(req.Kind, KindCapability),
		// prototype_task 是历史兼容列；新流程从不创建原型任务。
		PrototypeTask:           false,
		Title:                   strings.TrimSpace(req.Title),
		Description:             req.Description,
		BenefitTags:             benefitTagsJSON,
		RequirementDocument:     req.RequirementDocument,
		RequirementDocumentPath: requirementDocumentPath(req.RequirementDocumentPath, req.ModuleKey, itemKey),
		ActionOutput:            req.ActionOutput,
		TestingReport:           req.TestingReport,
		Phase:                   phase,
		Status:                  status,
		Progress:                normalizeProgress(status, req.Progress),
		OwnerID:                 req.OwnerID,
		OwnerName:               req.OwnerName,
		DueDate:                 due,
		Note:                    req.Note,
		SortOrder:               req.SortOrder,
		Version:                 1,
		CreatedBy:               actor,
		UpdatedBy:               actor,
	}
	if err := validateItemDocuments(row.RequirementDocument, row.ActionOutput, row.TestingReport); err != nil {
		return dto.ItemView{}, err
	}
	if err := s.repo.Tx(ctx, func(tx *repository.DeliveryRepository) error {
		if err := tx.LockProgram(ctx, row.BizLine, row.ProgramID); err != nil {
			return translate(err)
		}
		if row.ModuleKey != "" {
			if _, err := tx.FindModule(ctx, row.BizLine, row.ProgramID, row.ModuleKey); err != nil {
				return translate(err)
			}
		}
		// 需求键由拆解会话的提示词透传过来，写错一个字符任务就会挂到不存在的需求上，
		// 需求列表里再也点不出来 —— 所以在这里挡住，而不是等用户发现。
		if row.RequirementKey != "" {
			if _, err := tx.FindRequirement(ctx, row.BizLine, row.ProgramID, row.RequirementKey); err != nil {
				return translate(err)
			}
		}
		// 批次键写错就等于任务永远归不了批，和需求键一样在这里挡住。
		if row.PlanningBatchKey != "" {
			batch, err := tx.FindRequirementPlanningBatch(ctx, row.BizLine, row.ProgramID, row.PlanningBatchKey)
			if err != nil {
				return translate(err)
			}
			if batch.RequirementKey != row.RequirementKey {
				return fmt.Errorf("拆解批次 %s 不属于需求 %s", row.PlanningBatchKey, row.RequirementKey)
			}
		}
		lockedItems, err := tx.ListAllItems(ctx, repository.ItemQuery{
			BizLine: row.BizLine, ProgramID: row.ProgramID,
		})
		if err != nil {
			return err
		}
		lockedDependencies, err := tx.ListItemDependencies(ctx, row.BizLine, row.ProgramID)
		if err != nil {
			return err
		}
		if err := validateDependencyChange(lockedItems, lockedDependencies, row.ItemKey, dependsOnItemKeys); err != nil {
			return err
		}
		if err := tx.CreateItem(ctx, row); err != nil {
			return err
		}
		if err := tx.ReplaceItemDependencies(ctx, row.BizLine, row.ProgramID, row.ItemKey,
			dependsOnItemKeys, dependencySourceSides, dependencyTargetSides, actor); err != nil {
			return err
		}
		return tx.AppendEvents(ctx, []*repository.DeliveryItemEvent{{
			BizLine:        row.BizLine,
			ProgramID:      row.ProgramID,
			ItemKey:        row.ItemKey,
			RequirementKey: row.RequirementKey,
			Kind:           "create",
			ToValue:        row.Title,
			ActorID:        req.ActorID,
			ActorName:      req.ActorName,
		}})
	}); err != nil {
		return dto.ItemView{}, err
	}
	return toItemView(row, dependsOnItemKeys, dependencySourceSides, dependencyTargetSides), nil
}

// AdvancePhase 将当前阶段已完成的任务迁移到下一阶段。测试是终点，不能再推进。
// 批量请求在一个事务内提交，任一任务的版本或前置状态变化都会使整批回滚。
func (s *service) AdvancePhase(ctx context.Context, req dto.AdvancePhaseRequest) ([]dto.ItemView, error) {
	if !req.BizLine.Valid() {
		return nil, contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 {
		return nil, errors.New("缺少项目标识")
	}
	phase, err := normalizePhase(req.Phase)
	if err != nil {
		return nil, err
	}
	if phase == PhaseTesting {
		return nil, errors.New("测试阶段已是交付流程终点")
	}
	if len(req.Items) == 0 {
		return nil, errors.New("请选择要推进的任务")
	}

	type change struct {
		item   *repository.DeliveryItem
		values map[string]any
		events []*repository.DeliveryItemEvent
	}
	changes := make([]change, 0, len(req.Items))
	seen := map[string]struct{}{}
	for _, candidate := range req.Items {
		if candidate.ItemKey == "" || candidate.Version <= 0 {
			return nil, errors.New("任务标识或版本号无效，请刷新后重试")
		}
		if _, exists := seen[candidate.ItemKey]; exists {
			return nil, fmt.Errorf("任务 %s 重复选择", candidate.ItemKey)
		}
		seen[candidate.ItemKey] = struct{}{}
		current, err := s.repo.FindItem(ctx, req.BizLine.String(), req.ProgramID, candidate.ItemKey)
		if err != nil {
			return nil, translate(err)
		}
		if current.Version != candidate.Version {
			return nil, contract.ErrVersionConflict
		}
		currentPhase := current.Phase
		if currentPhase == "" {
			currentPhase = phaseForLegacyItem(current)
		}
		if currentPhase != phase || current.Status != StatusDone {
			return nil, fmt.Errorf("任务 %s 仅能在当前阶段完成后推进", candidate.ItemKey)
		}
		next := nextPhase(phase)
		progress := phaseProgressForCurrentPhase(next, StatusTodo)
		changes = append(changes, change{
			item: current,
			values: map[string]any{
				"phase": next, "status": StatusTodo, "progress": progress,
				"updated_by": actorOf(req.ActorID, req.ActorName),
			},
			events: []*repository.DeliveryItemEvent{
				{BizLine: current.BizLine, ProgramID: current.ProgramID, ItemKey: current.ItemKey, RequirementKey: current.RequirementKey, Kind: "field", Field: "phase", FromValue: currentPhase, ToValue: next, ActorID: req.ActorID, ActorName: req.ActorName},
				{BizLine: current.BizLine, ProgramID: current.ProgramID, ItemKey: current.ItemKey, RequirementKey: current.RequirementKey, Kind: "field", Field: "status", FromValue: current.Status, ToValue: StatusTodo, ActorID: req.ActorID, ActorName: req.ActorName},
				{BizLine: current.BizLine, ProgramID: current.ProgramID, ItemKey: current.ItemKey, RequirementKey: current.RequirementKey, Kind: "field", Field: "progress", FromValue: strconv.Itoa(current.Progress), ToValue: strconv.Itoa(progress), ActorID: req.ActorID, ActorName: req.ActorName},
			},
		})
	}
	if err := s.repo.Tx(ctx, func(tx *repository.DeliveryRepository) error {
		for _, change := range changes {
			affected, err := tx.UpdateItem(ctx, change.item.BizLine, change.item.ProgramID, change.item.ItemKey, change.item.Version, change.values)
			if err != nil {
				return err
			}
			if affected == 0 {
				return contract.ErrVersionConflict
			}
			if err := tx.AppendEvents(ctx, change.events); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return nil, err
	}

	views := make([]dto.ItemView, 0, len(changes))
	for _, change := range changes {
		updated, err := s.repo.FindItem(ctx, change.item.BizLine, change.item.ProgramID, change.item.ItemKey)
		if err != nil {
			return nil, translate(err)
		}
		views = append(views, toItemView(updated, nil, nil, nil))
	}
	return views, nil
}

// PatchItem 单条局部更新，带乐观锁。
//
// 原型是「整份 tasks.json 覆盖写」（save-server.js 的 POST /api/save），
// 多人同时开着看板必然互相吃掉改动 —— 这里换成按字段 diff + version 比对，
// 冲突直接返回 ErrVersionConflict 让前端刷新，不做静默合并。
func (s *service) PatchItem(ctx context.Context, req dto.PatchItemRequest) (dto.ItemView, error) {
	if !req.BizLine.Valid() {
		return dto.ItemView{}, contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 || req.ItemKey == "" {
		return dto.ItemView{}, errors.New("缺少项目或任务标识")
	}
	if req.Version <= 0 {
		return dto.ItemView{}, errors.New("缺少版本号，请刷新后重试")
	}

	current, err := s.repo.FindItem(ctx, req.BizLine.String(), req.ProgramID, req.ItemKey)
	if err != nil {
		return dto.ItemView{}, translate(err)
	}
	if current.Version != req.Version {
		return dto.ItemView{}, contract.ErrVersionConflict
	}
	dependencies, err := s.repo.ListItemDependencies(ctx, current.BizLine, current.ProgramID)
	if err != nil {
		return dto.ItemView{}, err
	}
	currentDependsOnItemKeys := dependencyKeysBySuccessor(dependencies)[current.ItemKey]
	currentDependencySourceSides := dependencySourceSidesBySuccessor(dependencies)[current.ItemKey]
	currentDependencyTargetSides := dependencyTargetSidesBySuccessor(dependencies)[current.ItemKey]
	nextDependsOnItemKeys := currentDependsOnItemKeys
	nextDependencySourceSides := cloneStringMap(currentDependencySourceSides)
	nextDependencyTargetSides := cloneStringMap(currentDependencyTargetSides)
	dependencyChanged := false
	if req.DependsOnItemKeys != nil {
		nextDependsOnItemKeys = normalizeDependencyKeys(*req.DependsOnItemKeys)
		allItems, err := s.repo.ListAllItems(ctx, repository.ItemQuery{
			BizLine: current.BizLine, ProgramID: current.ProgramID,
		})
		if err != nil {
			return dto.ItemView{}, err
		}
		if err := validateDependencyChange(allItems, dependencies, current.ItemKey, nextDependsOnItemKeys); err != nil {
			return dto.ItemView{}, err
		}
		dependencyChanged = !sameStrings(currentDependsOnItemKeys, nextDependsOnItemKeys)
	}
	nextDependencySourceSides = normalizeDependencySides(nextDependencySourceSides, nextDependsOnItemKeys)
	if req.DependencySourceSides != nil {
		for predecessorItemKey, side := range *req.DependencySourceSides {
			if containsString(nextDependsOnItemKeys, predecessorItemKey) {
				nextDependencySourceSides[predecessorItemKey] = normalizeDependencySide(side)
			}
		}
	}
	dependencyChanged = dependencyChanged || !sameStringMap(currentDependencySourceSides, nextDependencySourceSides)
	nextDependencyTargetSides = normalizeDependencyTargetSides(nextDependencyTargetSides, nextDependsOnItemKeys)
	if req.DependencyTargetSides != nil {
		for predecessorItemKey, side := range *req.DependencyTargetSides {
			if containsString(nextDependsOnItemKeys, predecessorItemKey) {
				nextDependencyTargetSides[predecessorItemKey] = normalizeDependencyTargetSide(side)
			}
		}
	}
	dependencyChanged = dependencyChanged || !sameStringMap(currentDependencyTargetSides, nextDependencyTargetSides)

	values := map[string]any{}
	var events []*repository.DeliveryItemEvent
	record := func(field, from, to string) {
		if from == to {
			return
		}
		events = append(events, &repository.DeliveryItemEvent{
			BizLine:        current.BizLine,
			ProgramID:      current.ProgramID,
			ItemKey:        current.ItemKey,
			RequirementKey: current.RequirementKey,
			Kind:           "field",
			Field:          field,
			// 描述、备注这类长文本只在流水上留「已更新」，与需求时间线保持一致，
			// 也避免超出 from_value / to_value 的列长。
			FromValue: requirementTimelineValue(from),
			ToValue:   requirementTimelineValue(to),
			ActorID:   req.ActorID,
			ActorName: req.ActorName,
		})
	}

	if req.StageKey != nil && *req.StageKey != current.StageKey {
		values["stage_key"] = *req.StageKey
		record("stageKey", current.StageKey, *req.StageKey)
	}
	if req.ModuleKey != nil && *req.ModuleKey != current.ModuleKey {
		values["module_key"] = *req.ModuleKey
		record("moduleKey", current.ModuleKey, *req.ModuleKey)
	}
	if req.RequirementKey != nil && strings.TrimSpace(*req.RequirementKey) != current.RequirementKey {
		requirementKey := strings.TrimSpace(*req.RequirementKey)
		values["requirement_key"] = requirementKey
		record("requirementKey", current.RequirementKey, requirementKey)
		// 任务改挂到新需求时，旧需求和新需求都应看到这次归属变化；其它任务变动只归属事件发生时的需求。
		if requirementKey != "" {
			events = append(events, &repository.DeliveryItemEvent{
				BizLine: current.BizLine, ProgramID: current.ProgramID, ItemKey: current.ItemKey, RequirementKey: requirementKey,
				Kind: "field", Field: "requirementKey", FromValue: current.RequirementKey, ToValue: requirementKey,
				ActorID: req.ActorID, ActorName: req.ActorName,
			})
		}
	}
	moduleChanged := req.ModuleKey != nil && *req.ModuleKey != current.ModuleKey
	if req.Kind != nil {
		kind := normalizeKindOrDefault(*req.Kind, current.Kind)
		if kind != current.Kind {
			values["kind"] = kind
			record("kind", current.Kind, kind)
		}
	}
	if req.Title != nil && strings.TrimSpace(*req.Title) != current.Title {
		title := strings.TrimSpace(*req.Title)
		if title == "" {
			return dto.ItemView{}, errors.New("任务标题不能为空")
		}
		values["title"] = title
		record("title", current.Title, title)
	}
	if req.Description != nil && *req.Description != current.Description {
		values["description"] = *req.Description
		record("description", current.Description, *req.Description)
	}
	if req.BenefitTags != nil {
		nextBenefitTagsJSON, nextBenefitTags, err := marshalBenefitTags(*req.BenefitTags)
		if err != nil {
			return dto.ItemView{}, err
		}
		currentBenefitTags := storedBenefitTags(current.BenefitTags)
		if !sameStrings(currentBenefitTags, nextBenefitTags) {
			values["benefit_tags"] = nextBenefitTagsJSON
			record("benefitTags", strings.Join(currentBenefitTags, "、"), strings.Join(nextBenefitTags, "、"))
		}
	}
	if req.RequirementDocument != nil && *req.RequirementDocument != current.RequirementDocument {
		if err := validateItemDocuments(*req.RequirementDocument, "", ""); err != nil {
			return dto.ItemView{}, err
		}
		values["requirement_document"] = *req.RequirementDocument
		record("requirementDocument", "", "已更新")
	}
	if req.RequirementDocumentPath != nil {
		path := requirementDocumentPath(*req.RequirementDocumentPath, current.ModuleKey, current.ItemKey)
		if path != current.RequirementDocumentPath {
			values["requirement_document_path"] = path
			record("requirementDocumentPath", current.RequirementDocumentPath, path)
		}
	}
	if req.ActionOutput != nil && *req.ActionOutput != current.ActionOutput {
		if err := validateItemDocuments("", *req.ActionOutput, ""); err != nil {
			return dto.ItemView{}, err
		}
		values["action_output"] = *req.ActionOutput
		record("actionOutput", "", "已更新")
	}
	if req.TestingReport != nil && *req.TestingReport != current.TestingReport {
		if err := validateItemDocuments("", "", *req.TestingReport); err != nil {
			return dto.ItemView{}, err
		}
		values["testing_report"] = *req.TestingReport
		record("testingReport", "", "已更新")
	}
	if req.ExecutionOutput != nil && *req.ExecutionOutput != current.ExecutionOutput {
		if err := validateItemDocuments("", *req.ExecutionOutput, ""); err != nil {
			return dto.ItemView{}, err
		}
		values["execution_output"] = *req.ExecutionOutput
		values["action_output"] = *req.ExecutionOutput
		record("executionOutput", "", "已更新")
	}
	if req.OwnerID != nil && *req.OwnerID != current.OwnerID {
		values["owner_id"] = *req.OwnerID
		record("ownerId", current.OwnerID, *req.OwnerID)
	}
	if req.OwnerName != nil && *req.OwnerName != current.OwnerName {
		values["owner_name"] = *req.OwnerName
		record("ownerName", current.OwnerName, *req.OwnerName)
	}
	if req.Note != nil && *req.Note != current.Note {
		values["note"] = *req.Note
		record("note", current.Note, *req.Note)
	}
	if req.SortOrder != nil && *req.SortOrder != current.SortOrder {
		values["sort_order"] = *req.SortOrder
		record("sortOrder", strconv.Itoa(current.SortOrder), strconv.Itoa(*req.SortOrder))
	}
	if req.DueDate != nil {
		due, err := parseDate(*req.DueDate)
		if err != nil {
			return dto.ItemView{}, err
		}
		if formatDate(due) != formatDate(current.DueDate) {
			values["due_date"] = due
			record("dueDate", formatDate(current.DueDate), formatDate(due))
		}
	}

	phase := current.Phase
	if phase == "" {
		phase = phaseForLegacyItem(current)
	}
	if req.Phase != nil {
		value, err := normalizePhase(*req.Phase)
		if err != nil {
			return dto.ItemView{}, err
		}
		if value != phase {
			return dto.ItemView{}, errors.New("任务阶段只能通过完成当前阶段后推进")
		}
	}
	status := current.Status
	if req.Status != nil {
		value, err := normalizeStatus(*req.Status)
		if err != nil {
			return dto.ItemView{}, err
		}
		status = value
	}
	// 旧的阶段字段由旧客户端写入时，仅更新当前阶段的状态。
	if req.RequirementStatus != nil && phase == PhaseRequirement {
		status = *req.RequirementStatus
	}
	if req.DevelopmentStatus != nil && phase == PhaseDevelopment {
		status = *req.DevelopmentStatus
	}
	if req.TestingStatus != nil && phase == PhaseTesting {
		status = *req.TestingStatus
	}
	if status != current.Status {
		status, err = normalizeStatus(status)
		if err != nil {
			return dto.ItemView{}, err
		}
		values["status"] = status
		record("status", current.Status, status)
	}
	progress := current.Progress
	if req.Progress != nil {
		progress = normalizeProgress(status, *req.Progress)
	}
	if progress != current.Progress {
		values["progress"] = progress
		record("progress", strconv.Itoa(current.Progress), strconv.Itoa(progress))
	}
	if dependencyChanged {
		record("dependsOnItemKeys", strings.Join(currentDependsOnItemKeys, ","), strings.Join(nextDependsOnItemKeys, ","))
	}

	if len(values) == 0 && !dependencyChanged && req.Comment == "" {
		return toItemView(current, currentDependsOnItemKeys, currentDependencySourceSides, currentDependencyTargetSides), nil
	}

	if len(values) > 0 || dependencyChanged {
		values["updated_by"] = actorOf(req.ActorID, req.ActorName)
	}

	if req.Comment != "" {
		events = append(events, &repository.DeliveryItemEvent{
			BizLine:        current.BizLine,
			ProgramID:      current.ProgramID,
			ItemKey:        current.ItemKey,
			RequirementKey: current.RequirementKey,
			Kind:           "comment",
			Comment:        req.Comment,
			ActorID:        req.ActorID,
			ActorName:      req.ActorName,
		})
	}
	if err := s.repo.Tx(ctx, func(tx *repository.DeliveryRepository) error {
		if dependencyChanged || moduleChanged {
			if err := tx.LockProgram(ctx, current.BizLine, current.ProgramID); err != nil {
				return translate(err)
			}
			if moduleChanged && *req.ModuleKey != "" {
				if _, err := tx.FindModule(ctx, current.BizLine, current.ProgramID, *req.ModuleKey); err != nil {
					return translate(err)
				}
			}
		}
		if dependencyChanged {
			lockedItems, err := tx.ListAllItems(ctx, repository.ItemQuery{
				BizLine: current.BizLine, ProgramID: current.ProgramID,
			})
			if err != nil {
				return err
			}
			lockedDependencies, err := tx.ListItemDependencies(ctx, current.BizLine, current.ProgramID)
			if err != nil {
				return err
			}
			if err := validateDependencyChange(lockedItems, lockedDependencies, current.ItemKey, nextDependsOnItemKeys); err != nil {
				return err
			}
		}
		if len(values) > 0 || dependencyChanged {
			affected, err := tx.UpdateItem(ctx, current.BizLine, current.ProgramID, current.ItemKey, req.Version, values)
			if err != nil {
				return err
			}
			if affected == 0 {
				return contract.ErrVersionConflict
			}
		}
		if dependencyChanged {
			if err := tx.ReplaceItemDependencies(ctx, current.BizLine, current.ProgramID, current.ItemKey,
				nextDependsOnItemKeys, nextDependencySourceSides, nextDependencyTargetSides, actorOf(req.ActorID, req.ActorName)); err != nil {
				return err
			}
		}
		return tx.AppendEvents(ctx, events)
	}); err != nil {
		return dto.ItemView{}, err
	}

	updated, err := s.repo.FindItem(ctx, current.BizLine, current.ProgramID, current.ItemKey)
	if err != nil {
		return dto.ItemView{}, translate(err)
	}
	return toItemView(updated, nextDependsOnItemKeys, nextDependencySourceSides, nextDependencyTargetSides), nil
}

func (s *service) DeleteItem(ctx context.Context, req dto.DeleteItemRequest) error {
	if !req.BizLine.Valid() {
		return contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 || req.ItemKey == "" {
		return errors.New("缺少项目或任务标识")
	}
	return s.repo.Tx(ctx, func(tx *repository.DeliveryRepository) error {
		item, err := tx.FindItem(ctx, req.BizLine.String(), req.ProgramID, req.ItemKey)
		if err != nil {
			return translate(err)
		}
		if err := tx.DeleteItemExecutionSessions(ctx, req.BizLine.String(), req.ProgramID, req.ItemKey); err != nil {
			return err
		}
		if err := tx.DeleteItemDependencies(ctx, req.BizLine.String(), req.ProgramID, req.ItemKey); err != nil {
			return err
		}
		affected, err := tx.DeleteItem(ctx, req.BizLine.String(), req.ProgramID, req.ItemKey)
		if err != nil {
			return err
		}
		if affected == 0 {
			return contract.ErrNotFound
		}
		// 流水不跟着删：任务没了，「谁在什么时候把它删掉的」还得留着。
		return tx.AppendEvents(ctx, []*repository.DeliveryItemEvent{{
			BizLine:        req.BizLine.String(),
			ProgramID:      req.ProgramID,
			ItemKey:        req.ItemKey,
			RequirementKey: item.RequirementKey,
			Kind:           "delete",
			ActorID:        req.ActorID,
			ActorName:      req.ActorName,
		}})
	})
}

func requirementDocumentPath(value, moduleKey, itemKey string) string {
	// Requirement documents always live under the execution workspace. The path
	// is derived from the task identity so every new Codex conversation reads the
	// same source of truth instead of accepting a caller-controlled filesystem path.
	module := strings.TrimSpace(moduleKey)
	if module == "" {
		module = "module"
	}
	return fmt.Sprintf("doc/%s/%s/文档.md", module, itemKey)
}

func storedRequirementDocumentPath(value, moduleKey, itemKey string) string {
	prefix := "doc/"
	suffix := "/" + itemKey + "/文档.md"
	if strings.HasPrefix(value, prefix) && strings.HasSuffix(value, suffix) {
		middle := strings.TrimSuffix(strings.TrimPrefix(value, prefix), suffix)
		if middle != "" && !strings.Contains(middle, "..") && !strings.HasPrefix(middle, "/") {
			return value
		}
	}
	return requirementDocumentPath("", moduleKey, itemKey)
}

func generateItemKey(moduleKey string) string {
	prefix := moduleKey
	if prefix == "" {
		prefix = "item"
	}
	return fmt.Sprintf("%s-n%d", prefix, time.Now().UnixMilli()%1000000)
}

func validateItemDocuments(requirementDocument, actionOutput, testingReport string) error {
	if len(requirementDocument) > maxItemDocumentBytes {
		return errors.New("任务需求文档不能超过 8MB")
	}
	if len(actionOutput) > maxItemDocumentBytes {
		return errors.New("动作执行产物不能超过 8MB")
	}
	if len(testingReport) > maxItemDocumentBytes {
		return errors.New("成品测试报告不能超过 8MB")
	}
	return nil
}
