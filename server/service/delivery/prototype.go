// 需求 HTML 原型：只登记项目工作区里的相对路径，正文不进服务端。

package delivery

import (
	"context"
	"errors"
	"strings"
	"time"

	"contract"
	"service/delivery/dto"
	"service/delivery/internal/repository"
)

// GetRequirementPrototype 返回需求关联的工作区相对路径和生成时间。
// 原型正文始终留在项目工作区，浏览器通过本地桥接受控读取，Web API 不读取宿主机文件。
func (s *service) GetRequirementPrototype(ctx context.Context, bizLine contract.BizLine, programID int64, requirementKey string) (dto.RequirementPrototypeView, error) {
	if !bizLine.Valid() {
		return dto.RequirementPrototypeView{}, contract.ErrBizLineRequired
	}
	if programID <= 0 || strings.TrimSpace(requirementKey) == "" {
		return dto.RequirementPrototypeView{}, errors.New("缺少项目或需求标识")
	}
	requirement, err := s.repo.FindRequirement(ctx, bizLine.String(), programID, requirementKey)
	if err != nil {
		return dto.RequirementPrototypeView{}, translate(err)
	}
	return dto.RequirementPrototypeView{
		RequirementKey: requirement.RequirementKey,
		Path:           requirement.PrototypeHTMLPath,
		Exists:         strings.TrimSpace(requirement.PrototypeHTMLPath) != "",
		GeneratedAt:    requirement.PrototypeGeneratedAt,
	}, nil
}

// SaveRequirementPrototype 只记录项目工作区里的原型相对路径。
// 正文由本机桥接生成在项目 doc/ 下，避免容器和开发工作区之间出现第二份权威副本。
func (s *service) SaveRequirementPrototype(ctx context.Context, req dto.SaveRequirementPrototypeRequest) (dto.RequirementPrototypeView, error) {
	if !req.BizLine.Valid() {
		return dto.RequirementPrototypeView{}, contract.ErrBizLineRequired
	}
	if req.ProgramID <= 0 || strings.TrimSpace(req.RequirementKey) == "" {
		return dto.RequirementPrototypeView{}, errors.New("缺少项目或需求标识")
	}
	requirement, err := s.repo.FindRequirement(ctx, req.BizLine.String(), req.ProgramID, req.RequirementKey)
	if err != nil {
		return dto.RequirementPrototypeView{}, translate(err)
	}
	if !requirement.GeneratePrototype {
		return dto.RequirementPrototypeView{}, errors.New("当前需求未启用 HTML 原型生成")
	}
	path, err := requirementPrototypePath(requirement.RequirementKey)
	if err != nil {
		return dto.RequirementPrototypeView{}, err
	}
	if strings.TrimSpace(req.Path) != path {
		return dto.RequirementPrototypeView{}, errors.New("需求原型路径无效")
	}
	now := time.Now()
	var affected int64
	if err := s.repo.Tx(ctx, func(tx *repository.DeliveryRepository) error {
		var updateErr error
		affected, updateErr = tx.UpdateRequirementPrototype(ctx, requirement.BizLine, requirement.ProgramID, requirement.RequirementKey, path, actorOf(req.ActorID, req.ActorName), now)
		if updateErr != nil {
			return updateErr
		}
		if affected == 0 {
			return errors.New("需求不存在")
		}
		return tx.AppendRequirementEvents(ctx, []*repository.DeliveryRequirementEvent{{
			BizLine: requirement.BizLine, ProgramID: requirement.ProgramID, RequirementKey: requirement.RequirementKey,
			Kind: "field", Field: "prototypeHtmlPath", FromValue: requirementTimelineValue(requirement.PrototypeHTMLPath), ToValue: path,
			ActorID: req.ActorID, ActorName: actorOf(req.ActorID, req.ActorName),
		}})
	}); err != nil {
		return dto.RequirementPrototypeView{}, err
	}
	return dto.RequirementPrototypeView{RequirementKey: requirement.RequirementKey, Path: path, Exists: true, GeneratedAt: &now}, nil
}

func requirementPrototypePath(requirementKey string) (string, error) {
	if !prototypePathPart(requirementKey) {
		return "", errors.New("需求原型路径无效")
	}
	return "doc/requirements/" + requirementKey + "/prototype", nil
}

func prototypePathPart(value string) bool {
	if value == "" || len(value) > 64 {
		return false
	}
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '-' || char == '_' {
			continue
		}
		return false
	}
	return true
}
