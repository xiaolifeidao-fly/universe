// 项目（program）：交付看板的顶层容器，业务线迁移也在这里。

package delivery

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"

	"contract"
	"gorm.io/gorm"
	"service/delivery/dto"
	"service/delivery/internal/repository"
)

var (
	gitRemoteNameRE = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
	gitReferenceRE  = regexp.MustCompile(`^[A-Za-z0-9._/-]{1,255}$`)
)

// ---------- 项目 ----------

func (s *service) ListPrograms(ctx context.Context, bizLine contract.BizLine) ([]dto.ProgramView, error) {
	if !bizLine.Valid() {
		return nil, contract.ErrBizLineRequired
	}
	rows, err := s.repo.ListPrograms(ctx, bizLine.String())
	if err != nil {
		return nil, err
	}
	views := make([]dto.ProgramView, 0, len(rows))
	for _, row := range rows {
		views = append(views, toProgramView(row))
	}
	return views, nil
}

func (s *service) ResolveProgramBizLine(ctx context.Context, programID int64) (contract.BizLine, error) {
	if programID <= 0 {
		return "", errors.New("缺少项目标识")
	}
	program, err := s.repo.FindProgramByID(ctx, programID)
	if err != nil {
		return "", translate(err)
	}
	bizLine := contract.BizLine(program.BizLine)
	if !bizLine.Valid() {
		return "", contract.ErrBizLineRequired
	}
	return bizLine, nil
}

func (s *service) CountPrograms(ctx context.Context, bizLine contract.BizLine) (int64, error) {
	if !bizLine.Valid() {
		return 0, contract.ErrBizLineRequired
	}
	return s.repo.CountPrograms(ctx, bizLine.String())
}

func (s *service) GetProgram(ctx context.Context, bizLine contract.BizLine, programID int64) (dto.ProgramView, error) {
	if !bizLine.Valid() {
		return dto.ProgramView{}, contract.ErrBizLineRequired
	}
	if programID <= 0 {
		return dto.ProgramView{}, errors.New("缺少项目标识")
	}
	row, err := s.repo.FindProgram(ctx, bizLine.String(), programID)
	if err != nil {
		return dto.ProgramView{}, translate(err)
	}
	return toProgramView(row), nil
}

func (s *service) SaveProgram(ctx context.Context, req dto.SaveProgramRequest) error {
	if !req.BizLine.Valid() {
		return contract.ErrBizLineRequired
	}
	programCode := strings.TrimSpace(req.ProgramCode)
	if req.ProgramID == 0 && programCode == "" {
		return errors.New("缺少项目编码")
	}
	status := req.Status
	if status == "" {
		status = "active"
	}
	if req.ProgramID > 0 && programCode == "" {
		existing, err := s.repo.FindProgram(ctx, req.BizLine.String(), req.ProgramID)
		if err != nil {
			return translate(err)
		}
		programCode = existing.ProgramCode
	}
	// 先自己查一次重码，好过把 MySQL 的 1062 原样抛到界面上。
	// 唯一键仍然是最终的并发保障，这里只负责给出能看懂的提示。
	if duplicate, err := s.repo.FindProgramByCode(ctx, req.BizLine.String(), programCode); err == nil {
		if duplicate.Id != req.ProgramID {
			return errors.New("该空间下已存在相同编码的项目")
		}
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	return s.repo.SaveProgram(ctx, &repository.DeliveryProgram{
		Id:          req.ProgramID,
		BizLine:     req.BizLine.String(),
		ProgramCode: programCode,
		Name:        req.Name,
		Summary:     req.Summary,
		Status:      status,
		CreatedBy:   actorOf(req.ActorID, req.ActorName),
		UpdatedBy:   actorOf(req.ActorID, req.ActorName),
	})
}

// SaveProgramGitConfig 保存项目对本机仓库的期望约束。它刻意只保存期望值：
// 远端地址与工作目录属于开发者机器，服务端不应代替用户执行 git remote set-url。
func (s *service) SaveProgramGitConfig(ctx context.Context, req dto.SaveProgramGitConfigRequest) (dto.ProgramView, error) {
	if !req.BizLine.Valid() {
		return dto.ProgramView{}, contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 {
		return dto.ProgramView{}, errors.New("缺少项目标识")
	}
	repositoryURL := strings.TrimSpace(req.GitRepositoryURL)
	if len(repositoryURL) > 512 {
		return dto.ProgramView{}, errors.New("Git 仓库地址不能超过 512 个字符")
	}
	remoteName := strings.TrimSpace(req.GitRemoteName)
	if remoteName == "" {
		remoteName = "origin"
	}
	if len(remoteName) > 64 || !gitRemoteNameRE.MatchString(remoteName) {
		return dto.ProgramView{}, errors.New("Git 远端名称不合法")
	}
	baseBranch := strings.TrimSpace(req.GitBaseBranch)
	if len(baseBranch) > 255 || (baseBranch != "" && !gitReferenceRE.MatchString(baseBranch)) {
		return dto.ProgramView{}, errors.New("Git 基准分支不合法")
	}
	row, err := s.repo.SaveProgramGitConfig(ctx, req.BizLine.String(), req.ProgramID, map[string]any{
		"git_repository_url": repositoryURL,
		"git_remote_name":    remoteName,
		"git_base_branch":    baseBranch,
		"updated_by":         actorOf(req.ActorID, req.ActorName),
		"updated_time":       time.Now(),
	})
	if err != nil {
		return dto.ProgramView{}, translate(err)
	}
	return toProgramView(row), nil
}

func (s *service) MigrateProgram(ctx context.Context, req dto.MigrateProgramRequest) error {
	if !req.SourceBizLine.Valid() || !req.TargetBizLine.Valid() {
		return contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 {
		return errors.New("缺少项目标识")
	}
	if req.SourceBizLine == req.TargetBizLine {
		current, err := s.repo.FindProgram(ctx, req.SourceBizLine.String(), req.ProgramID)
		if err != nil {
			return translate(err)
		}
		return s.SaveProgram(ctx, dto.SaveProgramRequest{
			BizLine: req.SourceBizLine, ProgramID: req.ProgramID, Name: req.Name,
			ProgramCode: current.ProgramCode,
			Summary:     req.Summary, Status: req.Status, ActorID: req.ActorID, ActorName: req.ActorName,
		})
	}

	status := req.Status
	if status == "" {
		status = "active"
	}
	actor := actorOf(req.ActorID, req.ActorName)
	return s.repo.Tx(ctx, func(tx *repository.DeliveryRepository) error {
		if err := tx.LockProgram(ctx, req.SourceBizLine.String(), req.ProgramID); err != nil {
			return translate(err)
		}
		// 项目编码只在空间内唯一，迁到别的空间可能撞上同名项目。
		// 唯一键会让整个事务回滚，但那给出的是 1062，先自己判一次好让提示能看懂。
		current, err := tx.FindProgram(ctx, req.SourceBizLine.String(), req.ProgramID)
		if err != nil {
			return translate(err)
		}
		if _, err := tx.FindProgramByCode(ctx, req.TargetBizLine.String(), current.ProgramCode); err == nil {
			return errors.New("目标空间下已存在相同编码的项目")
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		var rows int64
		rows, err = tx.MoveProgramBizLine(ctx, req.SourceBizLine.String(), req.TargetBizLine.String(), req.ProgramID, map[string]any{
			"name": req.Name, "summary": req.Summary, "status": status,
			"updated_by": actor, "updated_time": time.Now(),
		})
		if err != nil {
			return err
		}
		if rows == 0 {
			return contract.ErrNotFound
		}
		return nil
	})
}

func toProgramView(row *repository.DeliveryProgram) dto.ProgramView {
	updated := row.UpdatedTime
	return dto.ProgramView{
		ProgramID:        row.Id,
		ProgramCode:      row.ProgramCode,
		BizLine:          contract.BizLine(row.BizLine),
		Name:             row.Name,
		Summary:          row.Summary,
		Status:           row.Status,
		GitRepositoryURL: row.GitRepositoryURL,
		GitRemoteName:    row.GitRemoteName,
		GitBaseBranch:    row.GitBaseBranch,
		UpdatedBy:        row.UpdatedBy,
		UpdatedAt:        &updated,
	}
}
