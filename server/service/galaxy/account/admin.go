package account

import (
	"context"
	"errors"
	"strings"

	"service/galaxy/dto"
	"service/galaxy/internal/repository"
)

// 运营那一半：翻账号、停用、重置密码。散户 / 工作室不在这里改，在 galaxy.Service.SetProviderType ——
// 那张身份表是信誉读分的依据，和机器、贡献在同一个领域服务里。

func (s *service) List(ctx context.Context, query dto.AccountQuery) (dto.AccountPage, error) {
	if !validSide(query.Side) {
		return dto.AccountPage{}, errors.New("请选择共享端或使用端")
	}
	switch query.Status {
	case "", dto.AccountActive, dto.AccountDisabled:
	default:
		return dto.AccountPage{}, errors.New("非法的账号状态")
	}
	providerType := ""
	if query.Side == dto.SideProvider {
		switch query.ProviderType {
		case "", dto.ProviderIndividual, dto.ProviderStudio:
			providerType = query.ProviderType
		default:
			return dto.AccountPage{}, errors.New("非法的提供者身份")
		}
	}
	limit := query.Limit
	if limit <= 0 || limit > 200 {
		limit = 20
	}
	offset := query.Offset
	if offset < 0 {
		offset = 0
	}
	rows, total, err := s.repository.ListUsers(ctx, repository.UserQuery{
		BizLine: bizLine, Side: query.Side, Keyword: query.Keyword, Status: query.Status,
		ProviderType: providerType, Offset: offset, Limit: limit,
	})
	if err != nil {
		return dto.AccountPage{}, err
	}
	views, err := s.views(ctx, rows)
	if err != nil {
		return dto.AccountPage{}, err
	}
	return dto.AccountPage{List: views, Total: total}, nil
}

// SetStatus 停用当场生效：令牌版本加一，已经登录的那几台立刻被踢回登录页。
// 启用不会让旧令牌复活 —— 停用那一下已经把它们作废了。
//
// 停用挡的是登录控制台。这个人名下已经在跑的机器、已经发出去的算力密钥不跟着停：
// 那些各有各的开关（封禁机器、吊销密钥），混在一起的话，运营想让一个人登不上控制台，
// 会顺手把一池子消费者的请求一起掐断。
func (s *service) SetStatus(ctx context.Context, req dto.SetAccountStatusRequest) error {
	if !validSide(req.Side) {
		return errors.New("请选择共享端或使用端")
	}
	userID := strings.TrimSpace(req.UserID)
	switch req.Status {
	case dto.AccountActive, dto.AccountDisabled:
	default:
		return errors.New("非法的账号状态")
	}
	err := s.repository.BumpTokenVersion(ctx, bizLine, req.Side, userID, map[string]any{
		"status": req.Status, "updated_by": truncate(req.UpdatedBy, 64),
	})
	if repository.IsNotFound(err) {
		return ErrAccountMissing
	}
	return err
}

// ResetPassword 运营替忘了密码的人设一个临时密码。本人下次登录必须先改掉它。
func (s *service) ResetPassword(ctx context.Context, req dto.ResetAccountPasswordRequest) error {
	if !validSide(req.Side) {
		return errors.New("请选择共享端或使用端")
	}
	hash, err := hashPassword(req.Password)
	if err != nil {
		return err
	}
	err = s.repository.BumpTokenVersion(ctx, bizLine, req.Side, strings.TrimSpace(req.UserID), map[string]any{
		"password_hash": hash, "must_change_password": true, "updated_by": truncate(req.UpdatedBy, 64),
	})
	if repository.IsNotFound(err) {
		return ErrAccountMissing
	}
	return err
}

func truncate(value string, max int) string {
	value = strings.TrimSpace(value)
	if len(value) <= max {
		return value
	}
	return value[:max]
}
