// 需求（requirement）：任务的上游来源，负责人、模式与起始阶段都在这里定。

package delivery

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"contract"
	"service/delivery/dto"
	"service/delivery/internal/repository"
)

// ---------- 需求 ----------

func (s *service) ListRequirements(ctx context.Context, query dto.RequirementQuery) (dto.RequirementPage, error) {
	if !query.BizLine.Valid() {
		return dto.RequirementPage{}, contract.ErrBizLineRequired
	}
	if query.ProgramID <= 0 {
		return dto.RequirementPage{}, errors.New("缺少项目标识")
	}
	relatedTo := ""
	if strings.EqualFold(strings.TrimSpace(query.Scope), scopeMine) {
		relatedTo = strings.TrimSpace(query.ActorID)
		if relatedTo == "" {
			// 拿不到操作人时不能悄悄退化成「全部」——那等于把别人的需求也算成我的。
			return dto.RequirementPage{Total: 0, Data: []dto.RequirementView{}}, nil
		}
	}
	rows, total, err := s.repo.ListRequirements(ctx, repository.RequirementQuery{
		BizLine:   query.BizLine.String(),
		ProgramID: query.ProgramID,
		Keyword:   strings.TrimSpace(query.Keyword),
		Status:    strings.TrimSpace(query.Status),
		RelatedTo: relatedTo,
		Offset:    query.Offset(),
		Limit:     query.Limit(),
	})
	if err != nil {
		return dto.RequirementPage{}, err
	}
	counts, err := s.repo.ListRequirementItemCounts(ctx, query.BizLine.String(), query.ProgramID)
	if err != nil {
		return dto.RequirementPage{}, err
	}
	views := make([]dto.RequirementView, 0, len(rows))
	for _, row := range rows {
		view := toRequirementView(row)
		view.ItemCount = counts[row.RequirementKey]
		views = append(views, view)
	}
	return dto.RequirementPage{Total: total, Data: views}, nil
}

func (s *service) GetRequirement(ctx context.Context, bizLine contract.BizLine, programID int64, requirementKey string) (dto.RequirementView, error) {
	if !bizLine.Valid() {
		return dto.RequirementView{}, contract.ErrBizLineRequired
	}
	if programID <= 0 || requirementKey == "" {
		return dto.RequirementView{}, errors.New("缺少项目或需求标识")
	}
	row, err := s.repo.FindRequirement(ctx, bizLine.String(), programID, requirementKey)
	if err != nil {
		return dto.RequirementView{}, translate(err)
	}
	counts, err := s.repo.ListRequirementItemCounts(ctx, bizLine.String(), programID)
	if err != nil {
		return dto.RequirementView{}, err
	}
	view := toRequirementView(row)
	view.ItemCount = counts[row.RequirementKey]
	return view, nil
}

// SaveRequirement 新建与编辑走同一个入口：RequirementKey 为空就是新建。
// 编辑必须带 version —— 需求详情弹窗会长时间开着，覆盖别人的负责人调整是最难查的那类问题。
func (s *service) SaveRequirement(ctx context.Context, req dto.SaveRequirementRequest) (dto.RequirementView, error) {
	if !req.BizLine.Valid() {
		return dto.RequirementView{}, contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 {
		return dto.RequirementView{}, errors.New("缺少项目标识")
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return dto.RequirementView{}, errors.New("需求名称不能为空")
	}
	if len(name) > 255 {
		return dto.RequirementView{}, errors.New("需求名称不能超过 255 个字符")
	}
	if len(req.Detail) > maxItemDocumentBytes {
		return dto.RequirementView{}, errors.New("需求详情不能超过 8MB")
	}
	plannedStartAt, plannedEndAt, err := normalizeRequirementPlannedPeriod(req.PlannedStartAt, req.PlannedEndAt)
	if err != nil {
		return dto.RequirementView{}, err
	}
	status, err := normalizeRequirementStatus(req.Status)
	if err != nil {
		return dto.RequirementView{}, err
	}
	mode, startPhase, err := normalizeRequirementMode(req.Mode, req.StartPhase)
	if err != nil {
		return dto.RequirementView{}, err
	}
	// HTML 原型只在专业模式可选；简易模式不保留该开关，避免下次切回专业模式时意外触发生成。
	generatePrototype := mode == RequirementModeProfessional && req.GeneratePrototype
	// 是否拆解任务默认开启：请求没带这个字段时，新建按默认拆解，编辑保持需求原有选择。
	splitTasks := true
	if req.SplitTasks != nil {
		splitTasks = *req.SplitTasks
	}
	// 预生成任务需求文档默认关闭；任务需求梳理阶段仍可在同一文件上继续完善。
	preGenerateTaskDocuments := false
	if req.GenerateTaskOutline != nil {
		preGenerateTaskDocuments = *req.GenerateTaskOutline
	}
	if req.PreGenerateTaskDocuments != nil {
		preGenerateTaskDocuments = *req.PreGenerateTaskDocuments
	}
	ownerIDs, ownerNames, err := normalizeRequirementMembers(req.Owners, "主负责人")
	if err != nil {
		return dto.RequirementView{}, err
	}
	assistantIDs, assistantNames, err := normalizeRequirementMembers(req.Assistants, "辅助人")
	if err != nil {
		return dto.RequirementView{}, err
	}

	requirementKey := strings.TrimSpace(req.RequirementKey)
	if requirementKey == "" {
		row := &repository.DeliveryRequirement{
			BizLine:             req.BizLine.String(),
			ProgramID:           req.ProgramID,
			RequirementKey:      generateRequirementKey(),
			Name:                name,
			Detail:              req.Detail,
			PlannedStartAt:      plannedStartAt,
			PlannedEndAt:        plannedEndAt,
			Status:              status,
			Mode:                mode,
			StartPhase:          startPhase,
			SplitTasks:          splitTasks,
			GenerateTaskOutline: preGenerateTaskDocuments,
			GeneratePrototype:   generatePrototype,
			StageKey:            strings.TrimSpace(req.StageKey),
			ModuleKey:           strings.TrimSpace(req.ModuleKey),
			Kind:                normalizeKind(req.Kind),
			OwnerIDs:            ownerIDs,
			OwnerNames:          ownerNames,
			AssistantIDs:        assistantIDs,
			AssistantNames:      assistantNames,
			Version:             1,
			CreatedBy:           req.ActorID,
			CreatedByName:       actorOf(req.ActorID, req.ActorName),
			UpdatedBy:           actorOf(req.ActorID, req.ActorName),
		}
		if err := s.repo.Tx(ctx, func(tx *repository.DeliveryRepository) error {
			if err := tx.CreateRequirement(ctx, row); err != nil {
				return err
			}
			return tx.AppendRequirementEvents(ctx, []*repository.DeliveryRequirementEvent{requirementCreateEvent(row, req.ActorID, req.ActorName)})
		}); err != nil {
			return dto.RequirementView{}, err
		}
		return toRequirementView(row), nil
	}

	current, err := s.repo.FindRequirement(ctx, req.BizLine.String(), req.ProgramID, requirementKey)
	if err != nil {
		return dto.RequirementView{}, translate(err)
	}
	if req.SplitTasks == nil {
		splitTasks = current.SplitTasks
	}
	if req.GenerateTaskOutline == nil && req.PreGenerateTaskDocuments == nil {
		preGenerateTaskDocuments = current.GenerateTaskOutline
	}
	if req.Version <= 0 {
		return dto.RequirementView{}, errors.New("缺少版本号，请刷新后重试")
	}
	if current.Version != req.Version {
		return dto.RequirementView{}, contract.ErrVersionConflict
	}
	values := map[string]any{
		"name":                  name,
		"detail":                req.Detail,
		"planned_start_at":      plannedStartAt,
		"planned_end_at":        plannedEndAt,
		"status":                status,
		"mode":                  mode,
		"start_phase":           startPhase,
		"split_tasks":           splitTasks,
		"generate_task_outline": preGenerateTaskDocuments,
		"generate_prototype":    generatePrototype,
		"stage_key":             strings.TrimSpace(req.StageKey),
		"module_key":            strings.TrimSpace(req.ModuleKey),
		"kind":                  normalizeKind(req.Kind),
		"owner_ids":             ownerIDs,
		"owner_names":           ownerNames,
		"assistant_ids":         assistantIDs,
		"assistant_names":       assistantNames,
		"updated_by":            actorOf(req.ActorID, req.ActorName),
	}
	events := requirementChangeEvents(current, name, req.Detail, plannedStartAt, plannedEndAt, status, mode, startPhase,
		splitTasks, preGenerateTaskDocuments, generatePrototype, strings.TrimSpace(req.StageKey), strings.TrimSpace(req.ModuleKey), normalizeKind(req.Kind), ownerNames, assistantNames,
		req.ActorID, req.ActorName)
	var affected int64
	if err := s.repo.Tx(ctx, func(tx *repository.DeliveryRepository) error {
		var updateErr error
		affected, updateErr = tx.UpdateRequirement(ctx, current.BizLine, current.ProgramID, current.RequirementKey, req.Version, values)
		if updateErr != nil {
			return updateErr
		}
		if affected == 0 {
			return contract.ErrVersionConflict
		}
		return tx.AppendRequirementEvents(ctx, events)
	}); err != nil {
		return dto.RequirementView{}, err
	}
	return s.GetRequirement(ctx, req.BizLine, req.ProgramID, requirementKey)
}

// DeleteRequirement 只删需求本身：拆出来的任务已经在推进，解绑后仍留在看板上。
func (s *service) DeleteRequirement(ctx context.Context, req dto.DeleteRequirementRequest) error {
	if !req.BizLine.Valid() {
		return contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 || req.RequirementKey == "" {
		return errors.New("缺少项目或需求标识")
	}
	return s.repo.Tx(ctx, func(tx *repository.DeliveryRepository) error {
		requirement, err := tx.FindRequirement(ctx, req.BizLine.String(), req.ProgramID, req.RequirementKey)
		if err != nil {
			return translate(err)
		}
		if _, err := tx.DetachRequirementItems(ctx, req.BizLine.String(), req.ProgramID, req.RequirementKey); err != nil {
			return err
		}
		// 需求没了，挂在它下面的拆解会话目录也留不住。
		if err := tx.DeleteRequirementPlanningSessions(ctx, req.BizLine.String(), req.ProgramID, req.RequirementKey); err != nil {
			return err
		}
		if err := tx.DeleteRequirementTestingSessions(ctx, req.BizLine.String(), req.ProgramID, req.RequirementKey); err != nil {
			return err
		}
		affected, err := tx.DeleteRequirement(ctx, req.BizLine.String(), req.ProgramID, req.RequirementKey)
		if err != nil {
			return err
		}
		if affected == 0 {
			return errors.New("需求不存在")
		}
		return tx.AppendRequirementEvents(ctx, []*repository.DeliveryRequirementEvent{{
			BizLine: requirement.BizLine, ProgramID: requirement.ProgramID, RequirementKey: requirement.RequirementKey,
			Kind: "delete", ActorID: req.ActorID, ActorName: actorOf(req.ActorID, req.ActorName),
		}})
	})
}

// ---------- 需求辅助 ----------

// 需求状态刻意只有三个：需求层是「这件事要不要做、做完没有」，
// 细粒度的进行中/受阻由它下面的任务表达。
const (
	RequirementStatusOpen    = "open"
	RequirementStatusDone    = "done"
	RequirementStatusDropped = "dropped"
)

// scopeMine 是需求列表的默认视角：创建人 / 主负责人 / 辅助人是我。
const scopeMine = "mine"

const maxRequirementMembers = 20

var requirementStatuses = map[string]struct{}{
	RequirementStatusOpen: {}, RequirementStatusDone: {}, RequirementStatusDropped: {},
}

// 拆解模式。简易模式跳过梳理需求，任务建出来直接进动作执行；
// 专业模式保留三段流程，起始阶段由用户选，默认从梳理需求开始。
const (
	RequirementModeSimple       = "simple"
	RequirementModeProfessional = "professional"
)

// normalizeRequirementMode 返回 (模式, 起始阶段)。
// 简易模式的起始阶段是模式本身的定义，不接受客户端另给一个值 —— 两处口径不一致时，
// 界面上会出现「选了简易，任务却停在梳理需求」这种没法解释的结果。
func normalizeRequirementMode(mode, startPhase string) (string, string, error) {
	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode == "" {
		mode = RequirementModeProfessional
	}
	if mode != RequirementModeSimple && mode != RequirementModeProfessional {
		return "", "", fmt.Errorf("未知的需求模式：%s", mode)
	}
	if mode == RequirementModeSimple {
		return mode, PhaseDevelopment, nil
	}
	phase, err := normalizePhase(startPhase)
	if err != nil {
		return "", "", err
	}
	return mode, phase, nil
}

func requirementModeOrDefault(value string) string {
	if value == RequirementModeSimple {
		return RequirementModeSimple
	}
	return RequirementModeProfessional
}

func requirementStartPhaseOrDefault(value string) string {
	if phase, err := normalizePhase(value); err == nil {
		return phase
	}
	return PhaseRequirement
}

func normalizeRequirementStatus(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		return RequirementStatusOpen, nil
	}
	if _, ok := requirementStatuses[value]; !ok {
		return "", fmt.Errorf("未知的需求状态：%s", value)
	}
	return value, nil
}

// normalizeRequirementPlannedPeriod 确保需求排期是完整且顺序正确的时间区间。
// 计划未定时两端都可以为空，编辑时也允许一次性清空已有排期。
func normalizeRequirementPlannedPeriod(startAt, endAt *time.Time) (*time.Time, *time.Time, error) {
	if (startAt == nil) != (endAt == nil) {
		return nil, nil, errors.New("计划开始和结束时间需要同时填写")
	}
	if startAt != nil && endAt.Before(*startAt) {
		return nil, nil, errors.New("计划结束时间不能早于开始时间")
	}
	return startAt, endAt, nil
}

// normalizeRequirementMembers 把选人结果压成 ,1,2, 形式的标识串和逗号分隔的显示名。
// 前后都补逗号是为了让「和我有关」的 LIKE '%,3,%' 不会把 13、23 也捞进来。
func normalizeRequirementMembers(members []dto.RequirementMember, label string) (string, string, error) {
	if len(members) > maxRequirementMembers {
		return "", "", fmt.Errorf("%s最多选择 %d 人", label, maxRequirementMembers)
	}
	ids := make([]string, 0, len(members))
	names := make([]string, 0, len(members))
	seen := make(map[string]struct{}, len(members))
	for _, member := range members {
		id := strings.TrimSpace(member.ID)
		if id == "" {
			continue
		}
		if strings.ContainsAny(id, ",") {
			return "", "", fmt.Errorf("%s标识不能包含逗号", label)
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
		name := strings.ReplaceAll(strings.TrimSpace(member.Name), ",", " ")
		if name == "" {
			name = id
		}
		names = append(names, name)
	}
	if len(ids) == 0 {
		return "", "", nil
	}
	joinedIDs := "," + strings.Join(ids, ",") + ","
	joinedNames := strings.Join(names, ",")
	if len(joinedIDs) > 512 || len(joinedNames) > 512 {
		return "", "", fmt.Errorf("%s数量过多，请减少选择", label)
	}
	return joinedIDs, joinedNames, nil
}

func requirementMembersOf(ids, names string) []dto.RequirementMember {
	idList := splitMemberIDs(ids)
	nameList := strings.Split(names, ",")
	members := make([]dto.RequirementMember, 0, len(idList))
	for index, id := range idList {
		name := id
		if index < len(nameList) && strings.TrimSpace(nameList[index]) != "" {
			name = strings.TrimSpace(nameList[index])
		}
		members = append(members, dto.RequirementMember{ID: id, Name: name})
	}
	return members
}

func splitMemberIDs(value string) []string {
	parts := strings.Split(value, ",")
	ids := make([]string, 0, len(parts))
	for _, part := range parts {
		if id := strings.TrimSpace(part); id != "" {
			ids = append(ids, id)
		}
	}
	return ids
}

func generateRequirementKey() string {
	return fmt.Sprintf("req-%d", time.Now().UnixMilli())
}

func toRequirementView(row *repository.DeliveryRequirement) dto.RequirementView {
	created := row.CreatedTime
	updated := row.UpdatedTime
	return dto.RequirementView{
		RequirementKey:           row.RequirementKey,
		BizLine:                  contract.BizLine(row.BizLine),
		ProgramID:                row.ProgramID,
		Name:                     row.Name,
		Detail:                   row.Detail,
		PlannedStartAt:           row.PlannedStartAt,
		PlannedEndAt:             row.PlannedEndAt,
		Status:                   row.Status,
		Mode:                     requirementModeOrDefault(row.Mode),
		StartPhase:               requirementStartPhaseOrDefault(row.StartPhase),
		SplitTasks:               row.SplitTasks,
		PreGenerateTaskDocuments: row.GenerateTaskOutline,
		GenerateTaskOutline:      row.GenerateTaskOutline,
		GeneratePrototype:        row.GeneratePrototype,
		PrototypeHTMLPath:        row.PrototypeHTMLPath,
		PrototypeGeneratedAt:     row.PrototypeGeneratedAt,
		TestingStatus:            requirementTestingStatusOrDefault(row.TestingStatus),
		TestingReport:            row.TestingReport,
		TestingReportPath:        row.TestingReportPath,
		TestingReportedAt:        row.TestingReportedAt,
		TestingCasesStatus:       requirementTestingCasesStatusOrDefault(row.TestingCasesStatus),
		TestingCases:             row.TestingCases,
		TestingCasesPath:         row.TestingCasesPath,
		StageKey:                 row.StageKey,
		ModuleKey:                row.ModuleKey,
		Kind:                     normalizeKind(row.Kind),
		Owners:                   requirementMembersOf(row.OwnerIDs, row.OwnerNames),
		Assistants:               requirementMembersOf(row.AssistantIDs, row.AssistantNames),
		Version:                  row.Version,
		CreatedBy:                row.CreatedBy,
		CreatedByName:            row.CreatedByName,
		CreatedAt:                &created,
		UpdatedBy:                row.UpdatedBy,
		UpdatedAt:                &updated,
	}
}

func requirementCreateEvent(row *repository.DeliveryRequirement, actorID, actorName string) *repository.DeliveryRequirementEvent {
	return &repository.DeliveryRequirementEvent{
		BizLine: row.BizLine, ProgramID: row.ProgramID, RequirementKey: row.RequirementKey,
		Kind: "create", ToValue: requirementTimelineValue(row.Name), ActorID: actorID, ActorName: actorOf(actorID, actorName),
	}
}

func requirementChangeEvents(
	current *repository.DeliveryRequirement,
	name, detail string,
	plannedStartAt, plannedEndAt *time.Time,
	status, mode, startPhase string,
	splitTasks, preGenerateTaskDocuments, generatePrototype bool,
	stageKey, moduleKey, kind, ownerNames, assistantNames,
	actorID, actorName string,
) []*repository.DeliveryRequirementEvent {
	events := make([]*repository.DeliveryRequirementEvent, 0, 13)
	record := func(field, from, to string) {
		if from == to {
			return
		}
		events = append(events, &repository.DeliveryRequirementEvent{
			BizLine: current.BizLine, ProgramID: current.ProgramID, RequirementKey: current.RequirementKey,
			Kind: "field", Field: field, FromValue: requirementTimelineValue(from), ToValue: requirementTimelineValue(to),
			ActorID: actorID, ActorName: actorOf(actorID, actorName),
		})
	}
	record("name", current.Name, name)
	record("detail", current.Detail, detail)
	record("plannedStartAt", requirementTimelineTime(current.PlannedStartAt), requirementTimelineTime(plannedStartAt))
	record("plannedEndAt", requirementTimelineTime(current.PlannedEndAt), requirementTimelineTime(plannedEndAt))
	record("status", current.Status, status)
	record("mode", requirementModeOrDefault(current.Mode), mode)
	record("startPhase", requirementStartPhaseOrDefault(current.StartPhase), startPhase)
	record("splitTasks", strconv.FormatBool(current.SplitTasks), strconv.FormatBool(splitTasks))
	record("preGenerateTaskDocuments", strconv.FormatBool(current.GenerateTaskOutline), strconv.FormatBool(preGenerateTaskDocuments))
	record("generatePrototype", strconv.FormatBool(current.GeneratePrototype), strconv.FormatBool(generatePrototype))
	record("stageKey", current.StageKey, stageKey)
	record("moduleKey", current.ModuleKey, moduleKey)
	record("kind", normalizeKind(current.Kind), kind)
	record("owners", current.OwnerNames, ownerNames)
	record("assistants", current.AssistantNames, assistantNames)
	return events
}

func requirementTimelineTime(value *time.Time) string {
	if value == nil {
		return ""
	}
	return value.Format(time.DateTime)
}

// 时间线不应复制大段需求正文或测试报告；短文本保留差异，长文本统一标记为“已更新”。
func requirementTimelineValue(value string) string {
	value = strings.TrimSpace(value)
	if len([]rune(value)) > 120 {
		return "已更新"
	}
	return value
}
