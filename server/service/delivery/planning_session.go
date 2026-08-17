// 拆解会话：需求维度的执行器会话目录。桥接是本地进程，重启就没了，列表只能由服务端持有。

package delivery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"contract"
	"service/delivery/dto"
	"service/delivery/internal/repository"
)

func (s *service) ListPlanningSessions(ctx context.Context, query dto.PlanningSessionQuery) ([]dto.PlanningSessionView, error) {
	if !query.BizLine.Valid() {
		return nil, contract.ErrBizLineRequired
	}
	if query.ProgramID <= 0 || query.RequirementKey == "" {
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
	rows, err := s.repo.ListRequirementPlanningSessions(ctx, query.BizLine.String(), query.ProgramID, query.RequirementKey, executorType)
	if err != nil {
		return nil, err
	}
	views := make([]dto.PlanningSessionView, 0, len(rows))
	for _, row := range rows {
		views = append(views, toPlanningSessionView(row))
	}
	return views, nil
}

func (s *service) BindPlanningSession(ctx context.Context, req dto.BindPlanningSessionRequest) (dto.PlanningSessionView, error) {
	if !req.BizLine.Valid() {
		return dto.PlanningSessionView{}, contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 || req.RequirementKey == "" {
		return dto.PlanningSessionView{}, errors.New("缺少项目或需求标识")
	}
	executorType, err := normalizeExecutorType(req.ExecutorType)
	if err != nil {
		return dto.PlanningSessionView{}, err
	}
	threadID := strings.TrimSpace(req.ThreadID)
	if threadID == "" || len(threadID) > 255 {
		return dto.PlanningSessionView{}, errors.New("会话标识不能为空且不能超过 255 字符")
	}
	title := strings.TrimSpace(req.Title)
	if len([]rune(title)) > 120 {
		title = string([]rune(title)[:120])
	}
	status, err := normalizePlanningSessionStatus(req.Status)
	if err != nil {
		return dto.PlanningSessionView{}, err
	}
	metadataJSON, err := marshalPlanningMetadata(req.Metadata)
	if err != nil {
		return dto.PlanningSessionView{}, err
	}
	if _, err := s.repo.FindRequirement(ctx, req.BizLine.String(), req.ProgramID, req.RequirementKey); err != nil {
		return dto.PlanningSessionView{}, translate(err)
	}
	actor := actorOf(req.ActorID, req.ActorName)
	row := &repository.DeliveryRequirementPlanningSession{
		BizLine: req.BizLine.String(), ProgramID: req.ProgramID, RequirementKey: req.RequirementKey,
		ExecutorType: executorType, ThreadID: threadID, Title: title, Status: status,
		MetadataJSON: metadataJSON, CreatedBy: actor, UpdatedBy: actor,
	}
	if err := s.repo.UpsertRequirementPlanningSession(ctx, row); err != nil {
		return dto.PlanningSessionView{}, err
	}
	updated, err := s.repo.FindRequirementPlanningSession(ctx, req.BizLine.String(), req.ProgramID, req.RequirementKey, executorType, threadID)
	if err != nil {
		return dto.PlanningSessionView{}, translate(err)
	}
	return toPlanningSessionView(updated), nil
}

func normalizePlanningSessionStatus(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		value = "running"
	}
	if _, ok := planningSessionStatuses[value]; !ok {
		return "", fmt.Errorf("未知的拆解会话状态：%s", value)
	}
	return value, nil
}

func marshalPlanningMetadata(value map[string]any) (string, error) {
	if value == nil {
		value = map[string]any{}
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return "", errors.New("拆解会话 metadata 不是有效 JSON")
	}
	if len(raw) > maxPlanningMetadataBytes {
		return "", errors.New("拆解会话 metadata 不能超过 256KB")
	}
	return string(raw), nil
}

func toPlanningSessionView(row *repository.DeliveryRequirementPlanningSession) dto.PlanningSessionView {
	created := row.CreatedTime
	updated := row.UpdatedTime
	metadata := map[string]any{}
	if row.MetadataJSON != "" {
		_ = json.Unmarshal([]byte(row.MetadataJSON), &metadata)
	}
	return dto.PlanningSessionView{
		ProgramID: row.ProgramID, RequirementKey: row.RequirementKey, ExecutorType: row.ExecutorType,
		ThreadID: row.ThreadID, Title: row.Title, Status: row.Status, Metadata: metadata,
		Version: row.Version, CreatedAt: &created, UpdatedAt: &updated,
	}
}
