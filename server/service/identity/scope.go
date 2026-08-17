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
