// Package bizline 是第 0 层：业务线注册与能力集。
//
// 业务线不是一个纵向服务，而是其余六层的横切维度。跨业务线真正会变的只有三处：
// 端侧能力集、模板与指令库、评分维度权重 —— 前者在这里注册，后两者是
// task / risk 包里带 biz_line 的配置数据，都不是代码分支。
package bizline

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"regexp"
	"strings"
	"time"

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
	// CountEnabledOwned 统计这些编码里仍启用的条数，用于校验建空间配额。
	CountEnabledOwned(ctx context.Context, codes []string) (int64, error)
	Delete(ctx context.Context, req dto.DeleteBizLineRequest) error

	// Register 保留给后续服务端初始化调用，等价于保存一条启用项。
	Register(ctx context.Context, req dto.RegisterRequest) error

	// CreateShareLink 签发一条加入邀请，默认 1 小时后失效。
	CreateShareLink(ctx context.Context, req dto.CreateShareLinkRequest) (dto.ShareLinkView, error)
	// ResolveShareLink 校验令牌并返回受邀人该看到的空间信息与权限。
	ResolveShareLink(ctx context.Context, token string) (dto.ShareLinkTarget, error)

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
		return dto.BizLineView{}, errors.New("缺少空间")
	}
	row, err := s.repo.FindByCode(ctx, code)
	if err != nil {
		return dto.BizLineView{}, err
	}
	return toView(row), nil
}

func (s *service) Register(ctx context.Context, req dto.RegisterRequest) error {
	return s.Save(ctx, dto.SaveBizLineRequest{Code: req.Code, Name: req.Name, Enabled: true, Visible: true})
}

func (s *service) Save(ctx context.Context, req dto.SaveBizLineRequest) error {
	code := strings.ToLower(strings.TrimSpace(req.Code))
	name := strings.TrimSpace(req.Name)
	if code == "" {
		return errors.New("缺少空间编码")
	}
	if len(code) > 32 {
		return errors.New("空间编码不能超过 32 个字符")
	}
	if !bizLineCodePattern.MatchString(code) {
		return errors.New("空间编码仅支持字母、数字、下划线和连字符")
	}
	if name == "" {
		return errors.New("缺少空间名称")
	}
	if len(name) > 64 {
		return errors.New("空间名称不能超过 64 个字符")
	}
	description := strings.TrimSpace(req.Description)
	if len([]rune(description)) > 200 {
		return errors.New("空间描述不能超过 200 个字符")
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
			return errors.New("至少保留一个启用的空间")
		}
	}

	return s.repo.Upsert(ctx, &repository.BizLineDef{Code: code, Name: name, Description: description, Enabled: req.Enabled, Visible: req.Visible, CreatedBy: req.CreatedBy})
}

func (s *service) CountEnabledOwned(ctx context.Context, codes []string) (int64, error) {
	return s.repo.CountEnabledByCodes(ctx, codes)
}

func (s *service) Delete(ctx context.Context, req dto.DeleteBizLineRequest) error {
	code := strings.ToLower(strings.TrimSpace(req.Code))
	if code == "" {
		return errors.New("缺少空间编码")
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
			return errors.New("至少保留一个启用的空间")
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
		return errors.New("该空间仍有关联项目，不能删除")
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
		return nil, errors.New("缺少空间")
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

// ---------- 分享链接 ----------

func (s *service) CreateShareLink(ctx context.Context, req dto.CreateShareLinkRequest) (dto.ShareLinkView, error) {
	code := strings.ToLower(strings.TrimSpace(req.BizLine))
	if code == "" {
		return dto.ShareLinkView{}, errors.New("缺少空间编码")
	}
	if _, err := s.repo.FindByCode(ctx, code); err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return dto.ShareLinkView{}, contract.ErrNotFound
		}
		return dto.ShareLinkView{}, err
	}
	permission := strings.TrimSpace(req.Permission)
	if permission != dto.PermissionRead && permission != dto.PermissionWrite {
		return dto.ShareLinkView{}, errors.New("分享权限只能是只读或写入")
	}
	ttl := req.TTLMinutes
	if ttl <= 0 {
		ttl = dto.DefaultShareTTLMinutes
	}
	if ttl > dto.MaxShareTTLMinutes {
		return dto.ShareLinkView{}, errors.New("分享链接有效期不能超过 7 天")
	}
	token, err := newShareToken()
	if err != nil {
		return dto.ShareLinkView{}, err
	}
	// 过期记录没人会再用，签发新链接时顺手清掉，省一个定时任务。
	if err := s.repo.PurgeExpiredShareLinks(ctx); err != nil {
		return dto.ShareLinkView{}, err
	}
	link := &repository.BizLineShareLink{
		Token:      token,
		BizLine:    code,
		Permission: permission,
		CreatedBy:  req.CreatedBy,
		ExpiresAt:  time.Now().Add(time.Duration(ttl) * time.Minute),
	}
	if err := s.repo.CreateShareLink(ctx, link); err != nil {
		return dto.ShareLinkView{}, err
	}
	return dto.ShareLinkView{Token: link.Token, BizLine: link.BizLine, Permission: link.Permission, ExpiresAt: link.ExpiresAt}, nil
}

func (s *service) ResolveShareLink(ctx context.Context, token string) (dto.ShareLinkTarget, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return dto.ShareLinkTarget{}, errors.New("缺少邀请令牌")
	}
	link, err := s.repo.FindShareLink(ctx, token)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return dto.ShareLinkTarget{}, errors.New("邀请链接无效")
		}
		return dto.ShareLinkTarget{}, err
	}
	if time.Now().After(link.ExpiresAt) {
		return dto.ShareLinkTarget{}, errors.New("邀请链接已过期")
	}
	row, err := s.repo.FindByCode(ctx, link.BizLine)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return dto.ShareLinkTarget{}, errors.New("邀请链接指向的空间已不存在")
		}
		return dto.ShareLinkTarget{}, err
	}
	if !row.Enabled {
		return dto.ShareLinkTarget{}, errors.New("该空间已停用，无法加入")
	}
	return dto.ShareLinkTarget{
		BizLine:     row.Code,
		Name:        row.Name,
		Description: row.Description,
		Permission:  link.Permission,
		ExpiresAt:   link.ExpiresAt,
	}, nil
}

// newShareToken 用 URL 安全的随机串做令牌：链接本身就是凭证，
// 必须不可枚举，不能拿业务线编码之类的可猜内容拼。
func newShareToken() (string, error) {
	buffer := make([]byte, 24)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

func toView(row *repository.BizLineDef) dto.BizLineView {
	return dto.BizLineView{
		Code:        row.Code,
		Name:        row.Name,
		Description: row.Description,
		Enabled:     row.Enabled,
		Visible:     row.Visible,
		CreatedBy:   row.CreatedBy,
	}
}
