// 数据范围：业务线与项目的分配归一化，以及项目归属校验。

package identity

import (
	"context"
	"errors"
	"sort"
	"strconv"
	"strings"

	"contract"
	"service/identity/dto"
	"service/identity/internal/repository"
)

func (s *service) validatePrograms(ctx context.Context, programs []repository.IdentityUserProgram) error {
	if len(programs) == 0 {
		return nil
	}
	if s.programs == nil {
		return errors.New("项目范围校验服务尚未初始化")
	}
	for _, program := range programs {
		bizLine, err := s.programs.ResolveProgramBizLine(ctx, program.ProgramID)
		if err != nil {
			if errors.Is(err, contract.ErrNotFound) {
				return errors.New("分配的项目不存在")
			}
			return err
		}
		if bizLine.String() != program.BizLine {
			return errors.New("项目不属于所选空间")
		}
	}
	return nil
}

func normalizeAssignments(rawBizLines []string, rawPrograms []dto.ProgramScope) ([]string, []repository.IdentityUserProgram, error) {
	set := map[string]struct{}{}
	for _, value := range rawBizLines {
		value = strings.TrimSpace(value)
		if value != "" {
			set[value] = struct{}{}
		}
	}
	programSet := map[string]struct{}{}
	programs := make([]repository.IdentityUserProgram, 0, len(rawPrograms))
	for _, scope := range rawPrograms {
		scope.BizLine = strings.TrimSpace(scope.BizLine)
		if scope.BizLine == "" || scope.ProgramID <= 0 {
			return nil, nil, errors.New("项目分配缺少空间或项目标识")
		}
		set[scope.BizLine] = struct{}{}
		key := scope.BizLine + "\x00" + strconv.FormatInt(scope.ProgramID, 10)
		if _, exists := programSet[key]; exists {
			continue
		}
		programSet[key] = struct{}{}
		programs = append(programs, repository.IdentityUserProgram{BizLine: scope.BizLine, ProgramID: scope.ProgramID})
	}
	bizLines := make([]string, 0, len(set))
	for value := range set {
		bizLines = append(bizLines, value)
	}
	sort.Strings(bizLines)
	sort.Slice(programs, func(i, j int) bool {
		if programs[i].BizLine == programs[j].BizLine {
			return programs[i].ProgramID < programs[j].ProgramID
		}
		return programs[i].BizLine < programs[j].BizLine
	})
	return bizLines, programs, nil
}

func (s *service) ListBizLineAssignment(ctx context.Context, bizLine string) (dto.ScopeAssignment, error) {
	rows, err := s.repo.ListBizLineAssignmentsByBizLine(ctx, strings.TrimSpace(bizLine))
	if err != nil {
		return dto.ScopeAssignment{}, err
	}
	return toScopeAssignment(rows, nil), nil
}

func (s *service) ReplaceBizLineAssignment(ctx context.Context, bizLine string, assignment dto.ScopeAssignment) error {
	bizLine = strings.TrimSpace(bizLine)
	if bizLine == "" {
		return contract.ErrBizLineRequired
	}
	rows, err := s.normalizeScopeAssignment(ctx, assignment)
	if err != nil {
		return err
	}
	return s.repo.ReplaceBizLineAssignments(ctx, bizLine, rows.bizLines)
}

func (s *service) ListProgramAssignment(ctx context.Context, programID int64) (dto.ScopeAssignment, error) {
	if programID <= 0 {
		return dto.ScopeAssignment{}, errors.New("缺少项目标识")
	}
	rows, err := s.repo.ListProgramAssignments(ctx, programID)
	if err != nil {
		return dto.ScopeAssignment{}, err
	}
	return toScopeAssignment(nil, rows), nil
}

// ListProgramMembers 为项目内的人员指派提供最小必要信息。
// 项目成员可能因停用或删除而残留在历史任务中；它们不再作为新的候选项返回。
func (s *service) ListProgramMembers(ctx context.Context, programID int64) ([]dto.MemberView, error) {
	if programID <= 0 {
		return nil, errors.New("缺少项目标识")
	}
	assignments, err := s.repo.ListProgramAssignments(ctx, programID)
	if err != nil {
		return nil, err
	}
	ids := make([]int64, 0, len(assignments))
	for _, assignment := range assignments {
		ids = append(ids, assignment.UserID)
	}
	users, err := s.repo.ListActiveUsersByIDs(ctx, ids)
	if err != nil {
		return nil, err
	}
	members := make([]dto.MemberView, 0, len(users))
	for _, user := range users {
		members = append(members, dto.MemberView{
			ID:          strconv.FormatInt(user.ID, 10),
			Username:    user.Username,
			DisplayName: user.DisplayName,
		})
	}
	return members, nil
}

func (s *service) ReplaceProgramAssignment(ctx context.Context, bizLine string, programID int64, assignment dto.ScopeAssignment) error {
	if programID <= 0 {
		return errors.New("缺少项目标识")
	}
	if s.programs == nil {
		return errors.New("项目范围校验服务尚未初始化")
	}
	actualBizLine, err := s.programs.ResolveProgramBizLine(ctx, programID)
	if err != nil {
		return err
	}
	if actualBizLine.String() != strings.TrimSpace(bizLine) {
		return errors.New("项目不属于所选空间")
	}
	rows, err := s.normalizeScopeAssignment(ctx, assignment)
	if err != nil {
		return err
	}
	return s.repo.ReplaceProgramAssignments(ctx, programID, actualBizLine.String(), rows.programs)
}

type normalizedScopeAssignment struct {
	bizLines []repository.IdentityUserBizLine
	programs []repository.IdentityUserProgram
}

func (s *service) normalizeScopeAssignment(ctx context.Context, assignment dto.ScopeAssignment) (normalizedScopeAssignment, error) {
	userIDs := map[int64]struct{}{}
	writerIDs := map[int64]struct{}{}
	managerIDs := map[int64]struct{}{}
	for _, id := range assignment.UserIDs {
		if id > 0 {
			userIDs[id] = struct{}{}
		}
	}
	for _, id := range assignment.WriterIDs {
		if id > 0 {
			userIDs[id] = struct{}{}
			writerIDs[id] = struct{}{}
		}
	}
	for _, id := range assignment.ManagerIDs {
		if id > 0 {
			userIDs[id] = struct{}{}
			writerIDs[id] = struct{}{}
			managerIDs[id] = struct{}{}
		}
	}
	ids := make([]int64, 0, len(userIDs))
	for id := range userIDs {
		user, err := s.repo.FindUser(ctx, id)
		if err != nil {
			if repository.IsNotFound(err) {
				return normalizedScopeAssignment{}, errors.New("分配的用户不存在")
			}
			return normalizedScopeAssignment{}, err
		}
		if user.Status != StatusActive {
			return normalizedScopeAssignment{}, errors.New("不能为停用用户分配权限")
		}
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	result := normalizedScopeAssignment{
		bizLines: make([]repository.IdentityUserBizLine, 0, len(ids)),
		programs: make([]repository.IdentityUserProgram, 0, len(ids)),
	}
	for _, id := range ids {
		_, isManager := managerIDs[id]
		_, canWrite := writerIDs[id]
		result.bizLines = append(result.bizLines, repository.IdentityUserBizLine{UserID: id, IsManager: isManager, CanWrite: canWrite || isManager})
		result.programs = append(result.programs, repository.IdentityUserProgram{UserID: id, IsManager: isManager})
	}
	return result, nil
}

func toScopeAssignment(bizLines []*repository.IdentityUserBizLine, programs []*repository.IdentityUserProgram) dto.ScopeAssignment {
	assignment := dto.ScopeAssignment{UserIDs: []int64{}, WriterIDs: []int64{}, ManagerIDs: []int64{}}
	for _, row := range bizLines {
		assignment.UserIDs = append(assignment.UserIDs, row.UserID)
		if row.CanWrite || row.IsManager {
			assignment.WriterIDs = append(assignment.WriterIDs, row.UserID)
		}
		if row.IsManager {
			assignment.ManagerIDs = append(assignment.ManagerIDs, row.UserID)
		}
	}
	for _, row := range programs {
		assignment.UserIDs = append(assignment.UserIDs, row.UserID)
		if row.IsManager {
			assignment.ManagerIDs = append(assignment.ManagerIDs, row.UserID)
		}
	}
	return assignment
}

// ---------- 空间成员：单条增删改 ----------
//
// 成员不再由空间编辑表单整体覆盖：加入只能走分享链接，退出只能由空间管理员剔除。
// 这几个方法因此都只动一条记录，替换式的 ReplaceBizLineAssignment 留给用户管理页。

func (s *service) ListBizLineMembers(ctx context.Context, bizLine string) ([]dto.BizLineMemberView, error) {
	bizLine = strings.TrimSpace(bizLine)
	if bizLine == "" {
		return nil, contract.ErrBizLineRequired
	}
	rows, err := s.repo.ListBizLineAssignmentsByBizLine(ctx, bizLine)
	if err != nil {
		return nil, err
	}
	ids := make([]int64, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.UserID)
	}
	users, err := s.repo.ListUsersByIDs(ctx, ids)
	if err != nil {
		return nil, err
	}
	byID := make(map[int64]*repository.IdentityUser, len(users))
	for _, user := range users {
		byID[user.ID] = user
	}
	views := make([]dto.BizLineMemberView, 0, len(rows))
	for _, row := range rows {
		user, ok := byID[row.UserID]
		if !ok {
			// 账号已被删除但授权行还在：跳过而不是报错，剔除入口仍能清掉它。
			continue
		}
		views = append(views, dto.BizLineMemberView{
			ID:          user.ID,
			Username:    user.Username,
			DisplayName: user.DisplayName,
			IsManager:   row.IsManager,
			CanWrite:    row.CanWrite || row.IsManager,
			Permission:  permissionOf(row),
			JoinedAt:    timePtr(row.CreatedAt),
		})
	}
	sort.Slice(views, func(i, j int) bool {
		if views[i].IsManager != views[j].IsManager {
			return views[i].IsManager
		}
		return views[i].ID < views[j].ID
	})
	return views, nil
}

// SaveBizLineMember 加入或调权。管理员行始终带写入位，判权时不用再兜底。
func (s *service) SaveBizLineMember(ctx context.Context, req dto.BizLineMemberRequest) error {
	bizLine := strings.TrimSpace(req.BizLine)
	if bizLine == "" {
		return contract.ErrBizLineRequired
	}
	if req.UserID <= 0 {
		return errors.New("缺少用户标识")
	}
	user, err := s.repo.FindUser(ctx, req.UserID)
	if err != nil {
		if repository.IsNotFound(err) {
			return errors.New("用户不存在")
		}
		return err
	}
	if user.Status != StatusActive {
		return errors.New("不能为停用用户分配权限")
	}
	// 降级最后一个管理员等于把空间变成孤儿，和剔除最后一个管理员是同一件事。
	if !req.AsManager {
		current, findErr := s.repo.FindBizLineAssignment(ctx, bizLine, req.UserID)
		if findErr != nil && !repository.IsNotFound(findErr) {
			return findErr
		}
		if findErr == nil && current.IsManager {
			managers, countErr := s.repo.CountBizLineManagers(ctx, bizLine)
			if countErr != nil {
				return countErr
			}
			if managers <= 1 {
				return errors.New("至少保留一个空间管理员")
			}
		}
	}
	return s.repo.UpsertBizLineMember(ctx, &repository.IdentityUserBizLine{
		UserID:    req.UserID,
		BizLine:   bizLine,
		IsManager: req.AsManager,
		CanWrite:  req.CanWrite || req.AsManager,
	})
}

// RemoveBizLineMember 剔除成员。最后一个管理员不能被剔除，
// 否则这个空间会没有任何人能维护它 —— 系统管理员也不再隐式可见。
func (s *service) RemoveBizLineMember(ctx context.Context, bizLine string, userID int64) error {
	bizLine = strings.TrimSpace(bizLine)
	if bizLine == "" {
		return contract.ErrBizLineRequired
	}
	if userID <= 0 {
		return errors.New("缺少用户标识")
	}
	current, err := s.repo.FindBizLineAssignment(ctx, bizLine, userID)
	if err != nil {
		if repository.IsNotFound(err) {
			return contract.ErrNotFound
		}
		return err
	}
	if current.IsManager {
		managers, countErr := s.repo.CountBizLineManagers(ctx, bizLine)
		if countErr != nil {
			return countErr
		}
		if managers <= 1 {
			return errors.New("至少保留一个空间管理员")
		}
	}
	rows, err := s.repo.DeleteBizLineMember(ctx, bizLine, userID)
	if err != nil {
		return err
	}
	if rows == 0 {
		return contract.ErrNotFound
	}
	return nil
}

func (s *service) IsBizLineMember(ctx context.Context, bizLine string, userID int64) (bool, error) {
	if strings.TrimSpace(bizLine) == "" || userID <= 0 {
		return false, nil
	}
	_, err := s.repo.FindBizLineAssignment(ctx, strings.TrimSpace(bizLine), userID)
	if repository.IsNotFound(err) {
		return false, nil
	}
	return err == nil, err
}

func permissionOf(row *repository.IdentityUserBizLine) string {
	switch {
	case row.IsManager:
		return "manager"
	case row.CanWrite:
		return "write"
	default:
		return "read"
	}
}
