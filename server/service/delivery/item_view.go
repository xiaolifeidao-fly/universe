// 任务实体到视图的转换。

package delivery

import (
	"contract"
	"service/delivery/dto"
	"service/delivery/internal/repository"
)

func toItemViews(
	rows []*repository.DeliveryItem,
	dependsOn map[string][]string,
	dependencySourceSides map[string]map[string]string,
	dependencyTargetSides map[string]map[string]string,
) []dto.ItemView {
	views := make([]dto.ItemView, 0, len(rows))
	for _, row := range rows {
		views = append(views, toItemView(row, dependsOn[row.ItemKey], dependencySourceSides[row.ItemKey], dependencyTargetSides[row.ItemKey]))
	}
	return views
}

func toItemView(row *repository.DeliveryItem, dependsOnItemKeys []string, dependencySourceSides, dependencyTargetSides map[string]string) dto.ItemView {
	updated := row.UpdatedTime
	dependencies := append([]string{}, dependsOnItemKeys...)
	phase := phaseForLegacyItem(row)
	requirementStatus, developmentStatus, testingStatus := phaseStatusesForCurrentTask(phase, row.Status)
	return dto.ItemView{
		ItemKey:                 row.ItemKey,
		BizLine:                 contract.BizLine(row.BizLine),
		ProgramID:               row.ProgramID,
		StageKey:                row.StageKey,
		ModuleKey:               row.ModuleKey,
		RequirementKey:          row.RequirementKey,
		Kind:                    row.Kind,
		Title:                   row.Title,
		Description:             row.Description,
		BenefitTags:             storedBenefitTags(row.BenefitTags),
		RequirementDocumentPath: storedRequirementDocumentPath(row.RequirementDocumentPath, row.ModuleKey, row.ItemKey),
		Phase:                   phase,
		// 旧字段仅兼容读取，按当前唯一阶段投影为连续的三阶段状态。
		RequirementStatus:     requirementStatus,
		DevelopmentStatus:     developmentStatus,
		TestingStatus:         testingStatus,
		TestingCasesStatus:    itemTestingCasesStatusOrDefault(row.TestingCasesStatus),
		TestingCasesPath:      row.TestingCasesPath,
		Status:                row.Status,
		Progress:              progressOf(row),
		OwnerID:               row.OwnerID,
		OwnerName:             row.OwnerName,
		DueDate:               row.DueDate,
		Note:                  row.Note,
		SortOrder:             row.SortOrder,
		DependsOnItemKeys:     dependencies,
		DependencySourceSides: cloneStringMap(dependencySourceSides),
		DependencyTargetSides: cloneStringMap(dependencyTargetSides),
		Version:               row.Version,
		UpdatedBy:             row.UpdatedBy,
		UpdatedAt:             &updated,
	}
}

func toItemDetailView(row *repository.DeliveryItem, dependsOnItemKeys []string, dependencySourceSides, dependencyTargetSides map[string]string) dto.ItemView {
	view := toItemView(row, dependsOnItemKeys, dependencySourceSides, dependencyTargetSides)
	view.RequirementDocument = row.RequirementDocument
	view.ActionOutput = row.ActionOutput
	view.TestingReport = row.TestingReport
	view.TestingCases = row.TestingCases
	view.ExecutionOutput = row.ActionOutput
	return view
}
