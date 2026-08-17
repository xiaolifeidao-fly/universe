// Package bizline 是第 0 层：业务线注册与能力集。
//
// 业务线不是一个纵向服务，而是其余六层的横切维度。跨业务线真正会变的只有三处：
// 端侧能力集、模板与指令库、评分维度权重 —— 前者在这里注册，后两者是
// task / risk 包里带 biz_line 的配置数据，都不是代码分支。
package bizline

import (
	"context"
	"errors"
	"regexp"
	"strings"

	"contract"
	"gorm.io/gorm"

	"service/bizline/dto"
	"service/bizline/internal/repository"
)

var bizLineCodePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)

// Service 业务线注册与能力查询。
type Service interface {
	// List 仅返回启用项，供控制台的数据范围选择器使用。
	List(ctx context.Context) ([]dto.BizLineView, error)
	// ListAll 返回全部项，供业务线管理页维护已停用记录。
	ListAll(ctx context.Context) ([]dto.BizLineView, error)
	Get(ctx context.Context, code string) (dto.BizLineView, error)
	Save(ctx context.Context, req dto.SaveBizLineRequest) error
	Delete(ctx context.Context, req dto.DeleteBizLineRequest) error

	// Register 保留给后续服务端初始化调用，等价于保存一条启用项。
	Register(ctx context.Context, req dto.RegisterRequest) error

	// Capabilities 该业务线声明支持的能力集，task 层用它过滤指令，
	// 端侧 App 上报的 caps_version 与之比对。
	Capabilities(ctx context.Context, code string) ([]dto.Capability, error)
	SaveCapability(ctx context.Context, req dto.SaveCapabilityRequest) error
	// SupportedKeys 指定端侧版本下可用的能力键集合。
	SupportedKeys(ctx context.Context, code string, agentVersion string) (map[string]bool, error)
}

type service struct {
	repo           *repository.BizLineRepository
	programCounter ProgramCounter
}

func New(database *gorm.DB, programCounter ProgramCounter) Service {
	repo := &repository.BizLineRepository{}
	repo.SetDb(database)
	return &service{repo: repo, programCounter: programCounter}
}

func (s *service) List(ctx context.Context) ([]dto.BizLineView, error) {
	rows, err := s.repo.ListEnabled(ctx)
	if err != nil {
		return nil, err
	}
	views := make([]dto.BizLineView, 0, len(rows))
	for _, row := range rows {
		views = append(views, toView(row))
	}
	return views, nil
}

func (s *service) ListAll(ctx context.Context) ([]dto.BizLineView, error) {
	rows, err := s.repo.ListAll(ctx)
	if err != nil {
		return nil, err
	}
	views := make([]dto.BizLineView, 0, len(rows))
	for _, row := range rows {
		views = append(views, toView(row))
	}
	return views, nil
}

func (s *service) Get(ctx context.Context, code string) (dto.BizLineView, error) {
	if code == "" {
		return dto.BizLineView{}, errors.New("biz line required")
	}
	row, err := s.repo.FindByCode(ctx, code)
	if err != nil {
		return dto.BizLineView{}, err
	}
	return toView(row), nil
}

func (s *service) Register(ctx context.Context, req dto.RegisterRequest) error {
	return s.Save(ctx, dto.SaveBizLineRequest{Code: req.Code, Name: req.Name, Enabled: true})
}

func (s *service) Save(ctx context.Context, req dto.SaveBizLineRequest) error {
	code := strings.ToLower(strings.TrimSpace(req.Code))
	name := strings.TrimSpace(req.Name)
	if code == "" {
		return errors.New("缺少业务线编码")
	}
	if len(code) > 32 {
		return errors.New("业务线编码不能超过 32 个字符")
	}
	if !bizLineCodePattern.MatchString(code) {
		return errors.New("业务线编码仅支持字母、数字、下划线和连字符")
	}
	if name == "" {
		return errors.New("缺少业务线名称")
	}
	if len(name) > 64 {
		return errors.New("业务线名称不能超过 64 个字符")
	}

	current, err := s.repo.FindByCode(ctx, code)
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	if err == nil && current.Enabled && !req.Enabled {
		total, countErr := s.repo.CountEnabled(ctx)
		if countErr != nil {
			return countErr
		}
		if total <= 1 {
			return errors.New("至少保留一个启用的业务线")
		}
	}

	return s.repo.Upsert(ctx, &repository.BizLineDef{Code: code, Name: name, Enabled: req.Enabled})
}

func (s *service) Delete(ctx context.Context, req dto.DeleteBizLineRequest) error {
	code := strings.ToLower(strings.TrimSpace(req.Code))
	if code == "" {
		return errors.New("缺少业务线编码")
	}
	current, err := s.repo.FindByCode(ctx, code)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return contract.ErrNotFound
	}
	if err != nil {
		return err
	}
	if current.Enabled {
		total, countErr := s.repo.CountEnabled(ctx)
		if countErr != nil {
			return countErr
		}
		if total <= 1 {
			return errors.New("至少保留一个启用的业务线")
		}
	}
	if s.programCounter == nil {
		return errors.New("项目关联校验不可用")
	}
	programs, err := s.programCounter.CountPrograms(ctx, contract.BizLine(code))
	if err != nil {
		return err
	}
	if programs > 0 {
		return errors.New("该业务线仍有关联项目，不能删除")
	}
	rows, err := s.repo.Delete(ctx, code)
	if err != nil {
		return err
	}
	if rows == 0 {
		return contract.ErrNotFound
	}
	return nil
}

func (s *service) Capabilities(ctx context.Context, code string) ([]dto.Capability, error) {
	if code == "" {
		return nil, errors.New("biz line required")
	}
	rows, err := s.repo.ListCapabilities(ctx, code)
	if err != nil {
		return nil, err
	}
	caps := make([]dto.Capability, 0, len(rows))
	for _, row := range rows {
		caps = append(caps, dto.Capability{
			Key:             row.CapabilityKey,
			MinAgentVersion: row.MinAgentVersion,
			Enabled:         row.Enabled,
		})
	}
	return caps, nil
}

func (s *service) SaveCapability(ctx context.Context, req dto.SaveCapabilityRequest) error {
	if req.BizLine == "" {
		return errors.New("biz line required")
	}
	return s.repo.UpsertCapability(ctx, &repository.BizLineCapability{
		BizLine:         req.BizLine,
		CapabilityKey:   req.Key,
		MinAgentVersion: req.MinAgentVersion,
		Enabled:         req.Enabled,
	})
}

func (s *service) SupportedKeys(ctx context.Context, code string, agentVersion string) (map[string]bool, error) {
	if code == "" {
		return nil, errors.New("biz line required")
	}
	return s.repo.SupportedKeys(ctx, code, agentVersion)
}

func toView(row *repository.BizLineDef) dto.BizLineView {
	return dto.BizLineView{
		Code:    row.Code,
		Name:    row.Name,
		Enabled: row.Enabled,
	}
}
