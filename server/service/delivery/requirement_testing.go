// 需求总体测试：独立于单条任务的成品测试，汇总同一需求下的交付物并沉淀总体验收报告。

package delivery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"contract"
	"service/delivery/dto"
	"service/delivery/internal/repository"
)

const (
	RequirementTestingStatusTodo    = "todo"
	RequirementTestingStatusDoing   = "doing"
	RequirementTestingStatusPassed  = "passed"
	RequirementTestingStatusFailed  = "failed"
	RequirementTestingStatusBlocked = "blocked"
)

const (
	RequirementTestingCasesStatusTodo    = "todo"
	RequirementTestingCasesStatusDoing   = "doing"
	RequirementTestingCasesStatusReady   = "ready"
	RequirementTestingCasesStatusBlocked = "blocked"
)

var requirementTestingStatuses = map[string]struct{}{
	RequirementTestingStatusTodo: {}, RequirementTestingStatusDoing: {}, RequirementTestingStatusPassed: {},
	RequirementTestingStatusFailed: {}, RequirementTestingStatusBlocked: {},
}

var requirementTestingCasesStatuses = map[string]struct{}{
	RequirementTestingCasesStatusTodo: {}, RequirementTestingCasesStatusDoing: {},
	RequirementTestingCasesStatusReady: {}, RequirementTestingCasesStatusBlocked: {},
}

func requirementTestingStatusOrDefault(value string) string {
	status, err := normalizeRequirementTestingStatus(value, RequirementTestingStatusTodo)
	if err != nil {
		return RequirementTestingStatusTodo
	}
	return status
}

func normalizeRequirementTestingStatus(value, fallback string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		value = fallback
	}
	if _, ok := requirementTestingStatuses[value]; !ok {
		return "", fmt.Errorf("未知的需求总体测试状态：%s", value)
	}
	return value, nil
}

func requirementTestingReportPath(requirementKey string) string {
	return "doc/test/" + requirementKey + "/测试报告.md"
}

func requirementTestingCasesPath(requirementKey string) string {
	return "doc/test/" + requirementKey + "/测试用例.md"
}

func requirementTestingCasesStatusOrDefault(value string) string {
	status, err := normalizeRequirementTestingCasesStatus(value, RequirementTestingCasesStatusTodo)
	if err != nil {
		return RequirementTestingCasesStatusTodo
	}
	return status
}

func normalizeRequirementTestingCasesStatus(value, fallback string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		value = fallback
	}
	if _, ok := requirementTestingCasesStatuses[value]; !ok {
		return "", fmt.Errorf("未知的需求测试用例状态：%s", value)
	}
	return value, nil
}

func (s *service) UpdateRequirementTesting(ctx context.Context, req dto.UpdateRequirementTestingRequest) (dto.RequirementView, error) {
	if !req.BizLine.Valid() {
		return dto.RequirementView{}, contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 || strings.TrimSpace(req.RequirementKey) == "" {
		return dto.RequirementView{}, errors.New("缺少项目或需求标识")
	}
	if req.TestingReport != nil && len(*req.TestingReport) > maxItemDocumentBytes {
		return dto.RequirementView{}, errors.New("需求总体测试报告不能超过 8MB")
	}
	if req.TestingCases != nil && len(*req.TestingCases) > maxItemDocumentBytes {
		return dto.RequirementView{}, errors.New("需求总体测试用例不能超过 8MB")
	}
	if req.TestingStatus == nil && req.TestingCasesStatus == nil && req.TestingReport == nil && req.TestingCases == nil {
		return dto.RequirementView{}, errors.New("缺少要更新的需求测试内容")
	}
	current, err := s.repo.FindRequirement(ctx, req.BizLine.String(), req.ProgramID, req.RequirementKey)
	if err != nil {
		return dto.RequirementView{}, translate(err)
	}
	values := map[string]any{}
	if req.TestingStatus != nil {
		status, err := normalizeRequirementTestingStatus(*req.TestingStatus, "")
		if err != nil {
			return dto.RequirementView{}, err
		}
		values["testing_status"] = status
	}
	if req.TestingReport != nil {
		values["testing_report"] = *req.TestingReport
		if strings.TrimSpace(*req.TestingReport) != "" {
			values["testing_report_path"] = requirementTestingReportPath(req.RequirementKey)
			values["testing_reported_at"] = time.Now()
		}
	}
	if req.TestingCasesStatus != nil {
		status, err := normalizeRequirementTestingCasesStatus(*req.TestingCasesStatus, "")
		if err != nil {
			return dto.RequirementView{}, err
		}
		values["testing_cases_status"] = status
	}
	if req.TestingCases != nil {
		values["testing_cases"] = *req.TestingCases
		if strings.TrimSpace(*req.TestingCases) != "" {
			values["testing_cases_path"] = requirementTestingCasesPath(req.RequirementKey)
		}
	}
	events := make([]*repository.DeliveryRequirementEvent, 0, 4)
	record := func(field, from, to string) {
		if from == to {
			return
		}
		events = append(events, &repository.DeliveryRequirementEvent{
			BizLine: current.BizLine, ProgramID: current.ProgramID, RequirementKey: current.RequirementKey,
			Kind: "field", Field: field, FromValue: requirementTimelineValue(from), ToValue: requirementTimelineValue(to),
			ActorID: req.ActorID, ActorName: actorOf(req.ActorID, req.ActorName),
		})
	}
	if req.TestingStatus != nil {
		record("testingStatus", requirementTestingStatusOrDefault(current.TestingStatus), values["testing_status"].(string))
	}
	if req.TestingReport != nil {
		record("testingReport", current.TestingReport, *req.TestingReport)
	}
	if req.TestingCasesStatus != nil {
		record("testingCasesStatus", requirementTestingCasesStatusOrDefault(current.TestingCasesStatus), values["testing_cases_status"].(string))
	}
	if req.TestingCases != nil {
		record("testingCases", current.TestingCases, *req.TestingCases)
	}
	var affected int64
	if err := s.repo.Tx(ctx, func(tx *repository.DeliveryRepository) error {
		var updateErr error
		affected, updateErr = tx.UpdateRequirementTesting(ctx, req.BizLine.String(), req.ProgramID, req.RequirementKey, values)
		if updateErr != nil {
			return updateErr
		}
		if affected == 0 {
			return errors.New("需求不存在")
		}
		return tx.AppendRequirementEvents(ctx, events)
	}); err != nil {
		return dto.RequirementView{}, err
	}
	return s.GetRequirement(ctx, req.BizLine, req.ProgramID, req.RequirementKey)
}

func (s *service) ListRequirementTestingSessions(ctx context.Context, query dto.RequirementTestingSessionQuery) ([]dto.RequirementTestingSessionView, error) {
	if !query.BizLine.Valid() {
		return nil, contract.ErrBizLineRequired
	}
	if query.ProgramID <= 0 || strings.TrimSpace(query.RequirementKey) == "" {
		return nil, errors.New("缺少项目或需求标识")
	}
	executorType := ""
	if query.ExecutorType != "" {
		var err error
		executorType, err = normalizeExecutorType(query.ExecutorType)
		if err != nil {
			return nil, err
		}
	}
	if _, err := s.repo.FindRequirement(ctx, query.BizLine.String(), query.ProgramID, query.RequirementKey); err != nil {
		return nil, translate(err)
	}
	rows, err := s.repo.ListRequirementTestingSessions(ctx, query.BizLine.String(), query.ProgramID, query.RequirementKey, executorType)
	if err != nil {
		return nil, err
	}
	views := make([]dto.RequirementTestingSessionView, 0, len(rows))
	for _, row := range rows {
		views = append(views, toRequirementTestingSessionView(row))
	}
	return views, nil
}

func (s *service) BindRequirementTestingSession(ctx context.Context, req dto.BindRequirementTestingSessionRequest) (dto.RequirementTestingSessionView, error) {
	if !req.BizLine.Valid() {
		return dto.RequirementTestingSessionView{}, contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 || strings.TrimSpace(req.RequirementKey) == "" {
		return dto.RequirementTestingSessionView{}, errors.New("缺少项目或需求标识")
	}
	executorType, err := normalizeExecutorType(req.ExecutorType)
	if err != nil {
		return dto.RequirementTestingSessionView{}, err
	}
	threadID := strings.TrimSpace(req.ThreadID)
	if threadID == "" || len(threadID) > 255 {
		return dto.RequirementTestingSessionView{}, errors.New("会话标识不能为空且不能超过 255 字符")
	}
	status, err := normalizeRequirementTestingSessionStatus(req.Status)
	if err != nil {
		return dto.RequirementTestingSessionView{}, err
	}
	metadataJSON, err := marshalRequirementTestingMetadata(req.Metadata)
	if err != nil {
		return dto.RequirementTestingSessionView{}, err
	}
	if _, err := s.repo.FindRequirement(ctx, req.BizLine.String(), req.ProgramID, req.RequirementKey); err != nil {
		return dto.RequirementTestingSessionView{}, translate(err)
	}
	title := strings.TrimSpace(req.Title)
	if len([]rune(title)) > 120 {
		title = string([]rune(title)[:120])
	}
	actor := actorOf(req.ActorID, req.ActorName)
	row := &repository.DeliveryRequirementTestingSession{
		BizLine: req.BizLine.String(), ProgramID: req.ProgramID, RequirementKey: req.RequirementKey,
		ExecutorType: executorType, ThreadID: threadID, Title: title, Status: status,
		MetadataJSON: metadataJSON, CreatedBy: actor, UpdatedBy: actor,
	}
	if err := s.repo.UpsertRequirementTestingSession(ctx, row); err != nil {
		return dto.RequirementTestingSessionView{}, err
	}
	updated, err := s.repo.FindRequirementTestingSession(ctx, req.BizLine.String(), req.ProgramID, req.RequirementKey, executorType, threadID)
	if err != nil {
		return dto.RequirementTestingSessionView{}, translate(err)
	}
	return toRequirementTestingSessionView(updated), nil
}

func normalizeRequirementTestingSessionStatus(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		value = "running"
	}
	if _, ok := planningSessionStatuses[value]; !ok {
		return "", fmt.Errorf("未知的需求测试会话状态：%s", value)
	}
	return value, nil
}

func marshalRequirementTestingMetadata(value map[string]any) (string, error) {
	if value == nil {
		value = map[string]any{}
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return "", errors.New("需求测试会话 metadata 不是有效 JSON")
	}
	if len(raw) > maxPlanningMetadataBytes {
		return "", errors.New("需求测试会话 metadata 不能超过 256KB")
	}
	return string(raw), nil
}

func toRequirementTestingSessionView(row *repository.DeliveryRequirementTestingSession) dto.RequirementTestingSessionView {
	created := row.CreatedTime
	updated := row.UpdatedTime
	metadata := map[string]any{}
	if row.MetadataJSON != "" {
		_ = json.Unmarshal([]byte(row.MetadataJSON), &metadata)
	}
	return dto.RequirementTestingSessionView{
		ProgramID: row.ProgramID, RequirementKey: row.RequirementKey, ExecutorType: row.ExecutorType,
		ThreadID: row.ThreadID, Title: row.Title, Status: row.Status, Metadata: metadata,
		Version: row.Version, CreatedAt: &created, UpdatedAt: &updated,
	}
}
