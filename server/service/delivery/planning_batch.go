// 拆解批次：一次「把需求拆成任务并写入」的写入单元。
//
// 任务面板要回答的是「这批任务是哪一轮拆解拆出来的、能不能整批再做一次」，
// 靠创建时间聚类猜不出来 —— 同一轮写入会跨秒，两轮写入也可能挨得很近，
// 所以批次是一条独立的服务端事实，任务只冻结它的键。

package delivery

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"contract"
	"service/delivery/dto"
	"service/delivery/internal/repository"
)

const (
	PlanningBatchSourcePlanner = "planner"
	PlanningBatchSourceManual  = "manual"
	PlanningBatchSourceImport  = "import"
)

var planningBatchSources = map[string]struct{}{
	PlanningBatchSourcePlanner: {}, PlanningBatchSourceManual: {}, PlanningBatchSourceImport: {},
}

func normalizePlanningBatchSource(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		return PlanningBatchSourcePlanner, nil
	}
	if _, ok := planningBatchSources[value]; !ok {
		return "", fmt.Errorf("未知的拆解批次来源：%s", value)
	}
	return value, nil
}

func generatePlanningBatchKey() string {
	raw := make([]byte, 10)
	if _, err := rand.Read(raw); err != nil {
		// crypto/rand 失败极罕见；时间戳仍能保证键唯一且可读。
		return fmt.Sprintf("plan-%d", time.Now().UnixNano())
	}
	return "plan-" + hex.EncodeToString(raw)
}

func (s *service) ListPlanningBatches(ctx context.Context, query dto.PlanningBatchQuery) ([]dto.PlanningBatchView, error) {
	if !query.BizLine.Valid() {
		return nil, contract.ErrBizLineRequired
	}
	if query.ProgramID <= 0 {
		return nil, errors.New("缺少项目标识")
	}
	rows, err := s.repo.ListRequirementPlanningBatches(ctx, query.BizLine.String(), query.ProgramID, strings.TrimSpace(query.RequirementKey))
	if err != nil {
		return nil, err
	}
	views := make([]dto.PlanningBatchView, 0, len(rows))
	for _, row := range rows {
		views = append(views, toPlanningBatchView(row))
	}
	return views, nil
}

// CreatePlanningBatch 在写任务之前先开一批。任务写入失败也不回收批次：
// 空批次在面板上一眼可见，比任务挂在一个不存在的批次键上要好收拾。
func (s *service) CreatePlanningBatch(ctx context.Context, req dto.CreatePlanningBatchRequest) (dto.PlanningBatchView, error) {
	if !req.BizLine.Valid() {
		return dto.PlanningBatchView{}, contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 {
		return dto.PlanningBatchView{}, errors.New("缺少项目标识")
	}
	requirementKey := strings.TrimSpace(req.RequirementKey)
	if requirementKey == "" {
		return dto.PlanningBatchView{}, errors.New("拆解批次必须归属一条需求")
	}
	source, err := normalizePlanningBatchSource(req.Source)
	if err != nil {
		return dto.PlanningBatchView{}, err
	}
	executorType := ""
	if strings.TrimSpace(req.ExecutorType) != "" {
		if executorType, err = normalizeExecutorType(req.ExecutorType); err != nil {
			return dto.PlanningBatchView{}, err
		}
	}
	title := truncateRunes(strings.TrimSpace(req.Title), 120)
	summary := truncateRunes(strings.TrimSpace(req.Summary), 500)
	threadID := strings.TrimSpace(req.ThreadID)
	if len(threadID) > 255 {
		return dto.PlanningBatchView{}, errors.New("拆解会话标识不能超过 255 字符")
	}
	if req.ItemCount < 0 {
		return dto.PlanningBatchView{}, errors.New("拆解批次的任务数不能为负")
	}

	var created *repository.DeliveryRequirementPlanningBatch
	if err := s.repo.Tx(ctx, func(tx *repository.DeliveryRepository) error {
		if err := tx.LockProgram(ctx, req.BizLine.String(), req.ProgramID); err != nil {
			return translate(err)
		}
		if _, err := tx.FindRequirement(ctx, req.BizLine.String(), req.ProgramID, requirementKey); err != nil {
			return translate(err)
		}
		seq, err := tx.NextRequirementPlanningBatchSeq(ctx, req.BizLine.String(), req.ProgramID, requirementKey)
		if err != nil {
			return err
		}
		if title == "" {
			title = fmt.Sprintf("第 %d 次拆解", seq)
		}
		created = &repository.DeliveryRequirementPlanningBatch{
			BizLine: req.BizLine.String(), ProgramID: req.ProgramID, BatchKey: generatePlanningBatchKey(),
			RequirementKey: requirementKey, Seq: seq, Title: title, Source: source,
			ExecutorType: executorType, ThreadID: threadID, Summary: summary, ItemCount: req.ItemCount,
			CreatedBy: req.ActorID, CreatedByName: actorOf(req.ActorID, req.ActorName), UpdatedBy: actorOf(req.ActorID, req.ActorName),
		}
		return tx.CreateRequirementPlanningBatch(ctx, created)
	}); err != nil {
		return dto.PlanningBatchView{}, err
	}
	return toPlanningBatchView(created), nil
}

func toPlanningBatchView(row *repository.DeliveryRequirementPlanningBatch) dto.PlanningBatchView {
	created, updated := row.CreatedTime, row.UpdatedTime
	return dto.PlanningBatchView{
		BatchKey: row.BatchKey, BizLine: contract.BizLine(row.BizLine), ProgramID: row.ProgramID,
		RequirementKey: row.RequirementKey, Seq: row.Seq, Title: row.Title, Source: row.Source,
		ExecutorType: row.ExecutorType, ThreadID: row.ThreadID, Summary: row.Summary, ItemCount: row.ItemCount,
		CreatedBy: row.CreatedBy, CreatedByName: row.CreatedByName, CreatedAt: &created, UpdatedAt: &updated,
	}
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}
