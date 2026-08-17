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
			return errors.New("项目不属于所选业务线")
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
			return nil, nil, errors.New("项目分配缺少业务线或项目标识")
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
		return errors.New("项目不属于所选业务线")
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
	managerIDs := map[int64]struct{}{}
	for _, id := range assignment.UserIDs {
		if id > 0 {
			userIDs[id] = struct{}{}
		}
	}
	for _, id := range assignment.ManagerIDs {
		if id > 0 {
			userIDs[id] = struct{}{}
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
		result.bizLines = append(result.bizLines, repository.IdentityUserBizLine{UserID: id, IsManager: isManager})
		result.programs = append(result.programs, repository.IdentityUserProgram{UserID: id, IsManager: isManager})
	}
	return result, nil
}

func toScopeAssignment(bizLines []*repository.IdentityUserBizLine, programs []*repository.IdentityUserProgram) dto.ScopeAssignment {
	assignment := dto.ScopeAssignment{UserIDs: []int64{}, ManagerIDs: []int64{}}
	for _, row := range bizLines {
		assignment.UserIDs = append(assignment.UserIDs, row.UserID)
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
