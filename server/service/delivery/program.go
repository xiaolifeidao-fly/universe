// 项目（program）：交付看板的顶层容器，业务线迁移也在这里。

package delivery

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"path"
	"regexp"
	"strconv"
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

const maxCloudSyncFileBytes = 8 * 1024 * 1024

var cloudSyncScopeSet = map[string]struct{}{"chat": {}, "requirement": {}, "design": {}}

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

// SaveProgramGitConfig 保存项目的可选 Git 能力和说明信息。
// 仓库地址与工作目录属于开发者机器，服务端不校验也不改写本机 remote。
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
	if req.GitEnabled && baseBranch == "" {
		return dto.ProgramView{}, errors.New("启用项目 Git 后必须填写默认基准分支")
	}
	// 聊天归档属于项目 Git 工作流；关闭 Git 时一并关闭，避免本机桥接留下
	// 不会随项目版本管理的聊天副本。
	gitChatSyncEnabled := req.GitEnabled && req.GitChatSyncEnabled
	row, err := s.repo.SaveProgramGitConfig(ctx, req.BizLine.String(), req.ProgramID, map[string]any{
		"git_enabled":           req.GitEnabled,
		"git_repository_url":    repositoryURL,
		"git_remote_name":       remoteName,
		"git_base_branch":       baseBranch,
		"git_chat_sync_enabled": gitChatSyncEnabled,
		"updated_by":            actorOf(req.ActorID, req.ActorName),
		"updated_time":          time.Now(),
	})
	if err != nil {
		return dto.ProgramView{}, translate(err)
	}
	return toProgramView(row), nil
}

// SaveProgramCloudSyncConfig 保存项目级云端同步范围。关闭时清空范围，避免配置重新开启后意外上传旧类别。
func (s *service) SaveProgramCloudSyncConfig(ctx context.Context, req dto.SaveProgramCloudSyncConfigRequest) (dto.ProgramView, error) {
	if !req.BizLine.Valid() {
		return dto.ProgramView{}, contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 {
		return dto.ProgramView{}, errors.New("缺少项目标识")
	}
	scopes, err := normalizeCloudSyncScopes(req.CloudSyncScopes)
	if err != nil {
		return dto.ProgramView{}, err
	}
	if req.CloudSyncEnabled && len(scopes) == 0 {
		return dto.ProgramView{}, errors.New("启用云端同步后至少选择一种内容")
	}
	if req.CloudSyncEnabled && s.cloudStorage == nil {
		return dto.ProgramView{}, errors.New("服务器未配置 OSS 云存储，暂不能启用云端同步")
	}
	if !req.CloudSyncEnabled {
		scopes = nil
	}
	row, err := s.repo.SaveProgramCloudSyncConfig(ctx, req.BizLine.String(), req.ProgramID, map[string]any{
		"cloud_sync_enabled": req.CloudSyncEnabled,
		"cloud_sync_scopes":  strings.Join(scopes, ","),
		"updated_by":         actorOf(req.ActorID, req.ActorName),
		"updated_time":       time.Now(),
	})
	if err != nil {
		return dto.ProgramView{}, translate(err)
	}
	return toProgramView(row), nil
}

// UpsertCloudSyncFile 保存一个本机桥接上传的项目文件快照。项目配置是最终开关，桥接不能绕开它上传未选类别。
func (s *service) UpsertCloudSyncFile(ctx context.Context, req dto.UpsertCloudSyncFileRequest) (dto.CloudSyncFileView, error) {
	if !req.BizLine.Valid() {
		return dto.CloudSyncFileView{}, contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 {
		return dto.CloudSyncFileView{}, errors.New("缺少项目标识")
	}
	if _, ok := cloudSyncScopeSet[req.Category]; !ok {
		return dto.CloudSyncFileView{}, errors.New("云端同步类别无效")
	}
	relativePath, err := normalizeCloudSyncRelativePath(req.RelativePath)
	if err != nil {
		return dto.CloudSyncFileView{}, err
	}
	if len(req.Content) > maxCloudSyncFileBytes {
		return dto.CloudSyncFileView{}, errors.New("云端同步文件不能超过 8MB")
	}
	contentType := strings.TrimSpace(req.ContentType)
	if len(contentType) > 128 {
		return dto.CloudSyncFileView{}, errors.New("云端同步文件类型无效")
	}
	program, err := s.repo.FindProgram(ctx, req.BizLine.String(), req.ProgramID)
	if err != nil {
		return dto.CloudSyncFileView{}, translate(err)
	}
	if !program.CloudSyncEnabled || !cloudSyncScopeEnabled(program.CloudSyncScopes, req.Category) {
		return dto.CloudSyncFileView{}, errors.New("当前项目未启用该类云端同步")
	}
	if s.cloudStorage == nil {
		return dto.CloudSyncFileView{}, errors.New("服务器未配置 OSS 云存储")
	}
	sum := sha256.Sum256(req.Content)
	checksum := fmt.Sprintf("%x", sum)
	objectKey, err := s.cloudStorage.Put(ctx, cloudSyncObjectKey(req.BizLine.String(), req.ProgramID, req.Category, relativePath), contentType, req.Content, checksum)
	if err != nil {
		return dto.CloudSyncFileView{}, err
	}
	if strings.TrimSpace(objectKey) == "" || len(objectKey) > 1536 {
		return dto.CloudSyncFileView{}, errors.New("OSS 返回的对象键无效")
	}
	now := time.Now()
	row, err := s.repo.UpsertCloudSyncFile(ctx, &repository.DeliveryCloudSyncFile{
		BizLine: req.BizLine.String(), ProgramID: req.ProgramID, Category: req.Category,
		RelativePath: relativePath, ContentType: contentType, ObjectKey: objectKey, Size: int64(len(req.Content)),
		SHA256: checksum, UpdatedBy: actorOf(req.ActorID, req.ActorName), UpdatedTime: now,
	})
	if err != nil {
		return dto.CloudSyncFileView{}, translate(err)
	}
	return toCloudSyncFileView(row), nil
}

func normalizeCloudSyncScopes(raw []string) ([]string, error) {
	seen := map[string]struct{}{}
	for _, value := range raw {
		scope := strings.TrimSpace(value)
		if _, ok := cloudSyncScopeSet[scope]; !ok {
			return nil, errors.New("云端同步类别无效")
		}
		seen[scope] = struct{}{}
	}
	scopes := make([]string, 0, len(seen))
	for _, scope := range []string{"chat", "requirement", "design"} {
		if _, ok := seen[scope]; ok {
			scopes = append(scopes, scope)
		}
	}
	return scopes, nil
}

func cloudSyncScopeEnabled(raw, wanted string) bool {
	for _, scope := range strings.Split(raw, ",") {
		if strings.TrimSpace(scope) == wanted {
			return true
		}
	}
	return false
}

func normalizeCloudSyncRelativePath(raw string) (string, error) {
	value := strings.TrimSpace(strings.ReplaceAll(raw, "\\", "/"))
	if value == "" || len(value) > 1024 || strings.HasPrefix(value, "/") {
		return "", errors.New("云端同步文件路径无效")
	}
	cleaned := path.Clean(value)
	if cleaned == "." || cleaned != value || strings.HasPrefix(cleaned, "../") {
		return "", errors.New("云端同步文件路径无效")
	}
	return cleaned, nil
}

// cloudSyncObjectKey 用路径的 SHA-256 作为对象名，既保持同一项目文件的覆盖幂等，
// 也避免中文或超长本机路径直接成为 OSS key；原始相对路径仍只作为项目元数据保存。
func cloudSyncObjectKey(bizLine string, programID int64, category, relativePath string) string {
	sum := sha256.Sum256([]byte(relativePath))
	return path.Join("delivery-cloud-sync", bizLine, strconv.FormatInt(programID, 10), category, fmt.Sprintf("%x", sum))
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
		ProgramID:          row.Id,
		ProgramCode:        row.ProgramCode,
		BizLine:            contract.BizLine(row.BizLine),
		Name:               row.Name,
		Summary:            row.Summary,
		Status:             row.Status,
		GitEnabled:         row.GitEnabled,
		GitRepositoryURL:   row.GitRepositoryURL,
		GitRemoteName:      row.GitRemoteName,
		GitBaseBranch:      row.GitBaseBranch,
		GitChatSyncEnabled: row.GitChatSyncEnabled,
		CloudSyncEnabled:   row.CloudSyncEnabled,
		CloudSyncScopes:    strings.FieldsFunc(row.CloudSyncScopes, func(r rune) bool { return r == ',' }),
		UpdatedBy:          row.UpdatedBy,
		UpdatedAt:          &updated,
	}
}

func toCloudSyncFileView(row *repository.DeliveryCloudSyncFile) dto.CloudSyncFileView {
	updated := row.UpdatedTime
	return dto.CloudSyncFileView{
		ProgramID: row.ProgramID, Category: row.Category, RelativePath: row.RelativePath,
		ContentType: row.ContentType, Size: row.Size, SHA256: row.SHA256, UpdatedAt: &updated,
	}
}
