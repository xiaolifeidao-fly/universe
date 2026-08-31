// 时间计划（time plan）：项目的交付时间窗口，在 Git 上对应一条从基准分支切出的发布分支。
//
// 这一层只负责计划元数据、分支关联和需求归属。真正的 Git 动作 —— 建分支、
// 回合基线分支、合并需求分支、把计划分支回推基线 —— 全部发生在本机桥接的项目工作目录里，
// 服务端不执行也不校验 Git 命令，只在浏览器回报成功后记录事实。

package delivery

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"contract"
	"service/delivery/dto"
	"service/delivery/internal/repository"
)

var timePlanKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

var timePlanStatuses = map[string]struct{}{
	dto.TimePlanStatusActive: {}, dto.TimePlanStatusDone: {}, dto.TimePlanStatusArchived: {},
}

// 计划名称和需求名称一样只在列表里露一行，不需要放开到详情那种长度。
const maxTimePlanNameRunes = 128

// ---------- 查询 ----------

func (s *service) ListTimePlans(ctx context.Context, query dto.TimePlanQuery) (dto.TimePlanPage, error) {
	if !query.BizLine.Valid() {
		return dto.TimePlanPage{}, contract.ErrBizLineRequired
	}
	if query.ProgramID <= 0 {
		return dto.TimePlanPage{}, errors.New("缺少项目标识")
	}
	status := strings.TrimSpace(query.Status)
	if status != "" {
		if _, ok := timePlanStatuses[status]; !ok {
			return dto.TimePlanPage{}, fmt.Errorf("未知的时间计划状态：%s", status)
		}
	}
	rows, total, err := s.repo.ListTimePlansPage(
		ctx, query.BizLine.String(), query.ProgramID, status, strings.TrimSpace(query.Keyword),
		query.Offset(), query.Limit(),
	)
	if err != nil {
		return dto.TimePlanPage{}, err
	}
	counts, err := s.repo.CountRequirementsByTimePlan(ctx, query.BizLine.String(), query.ProgramID)
	if err != nil {
		return dto.TimePlanPage{}, err
	}
	views := make([]dto.TimePlanView, 0, len(rows))
	for _, row := range rows {
		views = append(views, toTimePlanView(row, counts[row.PlanKey]))
	}
	return dto.TimePlanPage{Total: total, Data: views}, nil
}

func (s *service) GetTimePlan(ctx context.Context, bizLine contract.BizLine, programID int64, planKey string) (dto.TimePlanView, error) {
	row, err := s.timePlan(ctx, bizLine, programID, planKey)
	if err != nil {
		return dto.TimePlanView{}, err
	}
	counts, err := s.repo.CountRequirementsByTimePlan(ctx, bizLine.String(), programID)
	if err != nil {
		return dto.TimePlanView{}, err
	}
	return toTimePlanView(row, counts[row.PlanKey]), nil
}

// ListTimePlanRequirements 给合并弹窗用：只带分支相关字段，不拉需求正文。
func (s *service) ListTimePlanRequirements(ctx context.Context, query dto.TimePlanRequirementQuery) ([]dto.TimePlanRequirementView, error) {
	if _, err := s.timePlan(ctx, query.BizLine, query.ProgramID, query.PlanKey); err != nil {
		return nil, err
	}
	rows, err := s.repo.ListRequirementsByTimePlan(ctx, query.BizLine.String(), query.ProgramID, strings.TrimSpace(query.PlanKey))
	if err != nil {
		return nil, err
	}
	views := make([]dto.TimePlanRequirementView, 0, len(rows))
	for _, row := range rows {
		views = append(views, dto.TimePlanRequirementView{
			RequirementKey: row.RequirementKey,
			Name:           row.Name,
			Status:         row.Status,
			GitBranch:      row.GitBranch,
			GitBaseBranch:  row.GitBaseBranch,
			GitEnabled:     boolValue(row.GitEnabled),
		})
	}
	return views, nil
}

// ---------- 写入 ----------

func (s *service) SaveTimePlan(ctx context.Context, req dto.SaveTimePlanRequest) (dto.TimePlanView, error) {
	if !req.BizLine.Valid() {
		return dto.TimePlanView{}, contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 {
		return dto.TimePlanView{}, errors.New("缺少项目标识")
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return dto.TimePlanView{}, errors.New("时间计划名称不能为空")
	}
	if len([]rune(name)) > maxTimePlanNameRunes {
		return dto.TimePlanView{}, fmt.Errorf("时间计划名称不能超过 %d 个字符", maxTimePlanNameRunes)
	}
	// 截止时间同时决定默认分支名，缺了它连分支都取不出来，所以是必填。
	if req.EndAt == nil {
		return dto.TimePlanView{}, errors.New("请填写时间计划的截止时间")
	}
	if req.StartAt != nil && req.StartAt.After(*req.EndAt) {
		return dto.TimePlanView{}, errors.New("时间计划的开始时间不能晚于截止时间")
	}
	status := strings.TrimSpace(req.Status)
	if status == "" {
		status = dto.TimePlanStatusActive
	}
	if _, ok := timePlanStatuses[status]; !ok {
		return dto.TimePlanView{}, fmt.Errorf("未知的时间计划状态：%s", status)
	}

	program, err := s.repo.FindProgram(ctx, req.BizLine.String(), req.ProgramID)
	if err != nil {
		return dto.TimePlanView{}, translate(err)
	}
	baseBranch, err := normalizeRequirementGitRef(req.BaseBranch)
	if err != nil {
		return dto.TimePlanView{}, err
	}
	if baseBranch == "" {
		baseBranch = strings.TrimSpace(program.GitBaseBranch)
	}
	branch, err := normalizeRequirementGitRef(req.Branch)
	if err != nil {
		return dto.TimePlanView{}, err
	}
	if branch == "" {
		branch = defaultTimePlanBranch(*req.EndAt)
	}
	// 项目没开 Git 时时间计划仍然可以用来排期，只是不带分支；开了才要求基准分支到位。
	if program.GitEnabled && baseBranch == "" {
		return dto.TimePlanView{}, errors.New("当前项目启用了 Git，请先在项目设置里填写默认基准分支，或为本计划指定基准分支")
	}
	if !program.GitEnabled {
		baseBranch = ""
		branch = ""
	}

	actor := actorOf(req.ActorID, req.ActorName)
	planKey := strings.TrimSpace(req.PlanKey)
	if planKey == "" {
		if branch != "" {
			if err := s.assertTimePlanBranchFree(ctx, req.BizLine.String(), req.ProgramID, branch, ""); err != nil {
				return dto.TimePlanView{}, err
			}
		}
		row := &repository.DeliveryTimePlan{
			BizLine:       req.BizLine.String(),
			ProgramID:     req.ProgramID,
			PlanKey:       generateTimePlanKey(),
			Name:          name,
			StartAt:       req.StartAt,
			EndAt:         req.EndAt,
			Status:        status,
			BaseBranch:    baseBranch,
			Branch:        branch,
			Version:       1,
			CreatedBy:     req.ActorID,
			CreatedByName: actor,
			UpdatedBy:     actor,
		}
		if err := s.repo.CreateTimePlan(ctx, row); err != nil {
			return dto.TimePlanView{}, err
		}
		return toTimePlanView(row, 0), nil
	}

	if !timePlanKeyPattern.MatchString(planKey) {
		return dto.TimePlanView{}, errors.New("时间计划标识格式不正确")
	}
	current, err := s.repo.FindTimePlan(ctx, req.BizLine.String(), req.ProgramID, planKey)
	if err != nil {
		return dto.TimePlanView{}, translate(err)
	}
	if req.Version <= 0 {
		return dto.TimePlanView{}, errors.New("缺少时间计划版本号")
	}
	if branch != "" && branch != current.Branch {
		if err := s.assertTimePlanBranchFree(ctx, req.BizLine.String(), req.ProgramID, branch, planKey); err != nil {
			return dto.TimePlanView{}, err
		}
	}
	values := map[string]any{
		"name":        name,
		"start_at":    req.StartAt,
		"end_at":      req.EndAt,
		"status":      status,
		"base_branch": baseBranch,
		"branch":      branch,
		"updated_by":  actor,
	}
	// 换了分支就说明之前那条关联已经不成立，创建时间和三个方向的合并时间一并清空，
	// 不让列表继续展示上一条分支的合并记录。
	if branch != current.Branch {
		values["branch_created_at"] = nil
		values["base_synced_at"] = nil
		values["requirement_merged_at"] = nil
		values["base_published_at"] = nil
	}
	rows, err := s.repo.UpdateTimePlan(ctx, req.BizLine.String(), req.ProgramID, planKey, req.Version, values)
	if err != nil {
		return dto.TimePlanView{}, err
	}
	if rows == 0 {
		return dto.TimePlanView{}, contract.ErrVersionConflict
	}
	return s.GetTimePlan(ctx, req.BizLine, req.ProgramID, planKey)
}

// BindTimePlanBranch 由浏览器在本机桥接确认分支创建成功后调用；服务端只记录规范化后的分支名。
func (s *service) BindTimePlanBranch(ctx context.Context, req dto.BindTimePlanBranchRequest) (dto.TimePlanView, error) {
	current, err := s.timePlan(ctx, req.BizLine, req.ProgramID, req.PlanKey)
	if err != nil {
		return dto.TimePlanView{}, err
	}
	program, err := s.repo.FindProgram(ctx, req.BizLine.String(), req.ProgramID)
	if err != nil {
		return dto.TimePlanView{}, translate(err)
	}
	if !program.GitEnabled {
		return dto.TimePlanView{}, errors.New("当前项目未启用 Git，不能关联计划分支")
	}
	baseBranch, err := normalizeRequirementGitRef(req.BaseBranch)
	if err != nil {
		return dto.TimePlanView{}, err
	}
	branch, err := normalizeRequirementGitRef(req.Branch)
	if err != nil {
		return dto.TimePlanView{}, err
	}
	if baseBranch == "" || branch == "" {
		return dto.TimePlanView{}, errors.New("缺少基准分支或计划分支")
	}
	if branch != current.Branch {
		if err := s.assertTimePlanBranchFree(ctx, req.BizLine.String(), req.ProgramID, branch, current.PlanKey); err != nil {
			return dto.TimePlanView{}, err
		}
	}
	rows, err := s.repo.TouchTimePlan(ctx, req.BizLine.String(), req.ProgramID, current.PlanKey, map[string]any{
		"base_branch":       baseBranch,
		"branch":            branch,
		"branch_created_at": time.Now(),
		"updated_by":        actorOf(req.ActorID, req.ActorName),
	})
	if err != nil {
		return dto.TimePlanView{}, err
	}
	if rows == 0 {
		return dto.TimePlanView{}, contract.ErrNotFound
	}
	return s.GetTimePlan(ctx, req.BizLine, req.ProgramID, current.PlanKey)
}

// RecordTimePlanMerge 记录一次本机合并成功的事实。合并结果对不对由本机 Git 说了算，
// 服务端只留一个「最近什么时候合过」，供计划列表判断这条分支是不是还新鲜。
func (s *service) RecordTimePlanMerge(ctx context.Context, req dto.RecordTimePlanMergeRequest) (dto.TimePlanView, error) {
	current, err := s.timePlan(ctx, req.BizLine, req.ProgramID, req.PlanKey)
	if err != nil {
		return dto.TimePlanView{}, err
	}
	column := ""
	switch strings.TrimSpace(req.Kind) {
	case dto.TimePlanMergeKindBase:
		column = "base_synced_at"
	case dto.TimePlanMergeKindRequirement:
		column = "requirement_merged_at"
	case dto.TimePlanMergeKindPublish:
		column = "base_published_at"
	default:
		return dto.TimePlanView{}, fmt.Errorf("未知的合并类型：%s", req.Kind)
	}
	if _, err := s.repo.TouchTimePlan(ctx, req.BizLine.String(), req.ProgramID, current.PlanKey, map[string]any{
		column:       time.Now(),
		"updated_by": actorOf(req.ActorID, req.ActorName),
	}); err != nil {
		return dto.TimePlanView{}, err
	}
	return s.GetTimePlan(ctx, req.BizLine, req.ProgramID, current.PlanKey)
}

// DeleteTimePlan 连同解除需求关联一起做：留着悬挂的 time_plan_key 只会让需求列表
// 显示一个查不到的计划。已经建出来的分支不动，删计划不是删代码。
func (s *service) DeleteTimePlan(ctx context.Context, req dto.DeleteTimePlanRequest) error {
	if _, err := s.timePlan(ctx, req.BizLine, req.ProgramID, req.PlanKey); err != nil {
		return err
	}
	planKey := strings.TrimSpace(req.PlanKey)
	return s.repo.Tx(ctx, func(tx *repository.DeliveryRepository) error {
		if _, err := tx.ClearTimePlanRequirements(ctx, req.BizLine.String(), req.ProgramID, planKey); err != nil {
			return err
		}
		rows, err := tx.DeleteTimePlan(ctx, req.BizLine.String(), req.ProgramID, planKey)
		if err != nil {
			return err
		}
		if rows == 0 {
			return contract.ErrNotFound
		}
		return nil
	})
}

// BindRequirementTimePlan 需求列表和工作台的「关联时间计划」按钮用它，传空串解除关联。
func (s *service) BindRequirementTimePlan(ctx context.Context, req dto.BindRequirementTimePlanRequest) (dto.RequirementView, error) {
	if !req.BizLine.Valid() {
		return dto.RequirementView{}, contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 || strings.TrimSpace(req.RequirementKey) == "" {
		return dto.RequirementView{}, errors.New("缺少项目或需求标识")
	}
	requirementKey := strings.TrimSpace(req.RequirementKey)
	planKey := strings.TrimSpace(req.PlanKey)
	if planKey != "" {
		if !timePlanKeyPattern.MatchString(planKey) {
			return dto.RequirementView{}, errors.New("时间计划标识格式不正确")
		}
		// 计划必须属于同一个项目：跨项目关联会让合并时拿到别的项目的需求分支。
		if _, err := s.repo.FindTimePlan(ctx, req.BizLine.String(), req.ProgramID, planKey); err != nil {
			return dto.RequirementView{}, translate(err)
		}
	}
	if _, err := s.repo.FindRequirement(ctx, req.BizLine.String(), req.ProgramID, requirementKey); err != nil {
		return dto.RequirementView{}, translate(err)
	}
	rows, err := s.repo.BindRequirementTimePlan(
		ctx, req.BizLine.String(), req.ProgramID, requirementKey, planKey,
		actorOf(req.ActorID, req.ActorName), time.Now(),
	)
	if err != nil {
		return dto.RequirementView{}, err
	}
	if rows == 0 {
		return dto.RequirementView{}, contract.ErrNotFound
	}
	return s.GetRequirement(ctx, req.BizLine, req.ProgramID, requirementKey)
}

// ---------- 内部 ----------

func (s *service) timePlan(ctx context.Context, bizLine contract.BizLine, programID int64, planKey string) (*repository.DeliveryTimePlan, error) {
	if !bizLine.Valid() {
		return nil, contract.ErrBizLineRequired
	}
	if programID <= 0 || strings.TrimSpace(planKey) == "" {
		return nil, errors.New("缺少项目或时间计划标识")
	}
	row, err := s.repo.FindTimePlan(ctx, bizLine.String(), programID, strings.TrimSpace(planKey))
	if err != nil {
		return nil, translate(err)
	}
	return row, nil
}

// assertTimePlanBranchFree 同一个项目里一条分支只能挂一个计划：两个计划共用一条分支时，
// 「这条分支代表哪一批需求」就没有答案了，合并记录也会互相覆盖。
func (s *service) assertTimePlanBranchFree(ctx context.Context, bizLine string, programID int64, branch, exceptPlanKey string) error {
	existing, err := s.repo.FindTimePlanByBranch(ctx, bizLine, programID, branch)
	if err != nil {
		if errors.Is(translate(err), contract.ErrNotFound) {
			return nil
		}
		return err
	}
	if existing.PlanKey == exceptPlanKey {
		return nil
	}
	return fmt.Errorf("分支 %s 已经被时间计划「%s」占用，请换一个分支名", branch, existing.Name)
}

func generateTimePlanKey() string {
	return fmt.Sprintf("plan-%d", time.Now().UnixMilli())
}

// defaultTimePlanBranch 默认分支名 release/{截止日期}。日期用本地时区的年月日，
// 和用户在表单里看到的截止日期一致，不用 UTC 免得差一天。
func defaultTimePlanBranch(endAt time.Time) string {
	return "release/" + endAt.In(time.Local).Format("20060102")
}

func toTimePlanView(row *repository.DeliveryTimePlan, requirementCount int64) dto.TimePlanView {
	created := row.CreatedTime
	updated := row.UpdatedTime
	status := strings.TrimSpace(row.Status)
	if status == "" {
		status = dto.TimePlanStatusActive
	}
	return dto.TimePlanView{
		PlanKey:             row.PlanKey,
		BizLine:             contract.BizLine(row.BizLine),
		ProgramID:           row.ProgramID,
		Name:                row.Name,
		StartAt:             row.StartAt,
		EndAt:               row.EndAt,
		Status:              status,
		BaseBranch:          row.BaseBranch,
		Branch:              row.Branch,
		BranchCreatedAt:     row.BranchCreatedAt,
		BaseSyncedAt:        row.BaseSyncedAt,
		RequirementMergedAt: row.RequirementMergedAt,
		BasePublishedAt:     row.BasePublishedAt,
		RequirementCount:    requirementCount,
		Version:             row.Version,
		CreatedBy:           row.CreatedBy,
		CreatedByName:       row.CreatedByName,
		CreatedAt:           &created,
		UpdatedBy:           row.UpdatedBy,
		UpdatedAt:           &updated,
	}
}
