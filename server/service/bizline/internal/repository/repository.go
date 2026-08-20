package repository

import (
	"context"
	"errors"
	"time"

	"common/middleware/db"

	"gorm.io/gorm"
)

type BizLineRepository struct {
	db.Repository[*BizLineDef]
}

// AutoMigrate 由显式初始化命令调用；服务启动不执行 DDL。
func (r *BizLineRepository) AutoMigrate() error {
	return r.Db.AutoMigrate(&BizLineDef{}, &BizLineCapability{}, &BizLineShareLink{})
}

func (r *BizLineRepository) ListEnabled(ctx context.Context) ([]*BizLineDef, error) {
	var rows []*BizLineDef
	err := r.Db.WithContext(ctx).Where("enabled = ?", true).Order("code asc").Find(&rows).Error
	return rows, err
}

func (r *BizLineRepository) ListAll(ctx context.Context) ([]*BizLineDef, error) {
	var rows []*BizLineDef
	err := r.Db.WithContext(ctx).Order("code asc").Find(&rows).Error
	return rows, err
}

func (r *BizLineRepository) FindByCode(ctx context.Context, code string) (*BizLineDef, error) {
	var row BizLineDef
	if err := r.Db.WithContext(ctx).Where("code = ?", code).First(&row).Error; err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *BizLineRepository) Upsert(ctx context.Context, def *BizLineDef) error {
	var existing BizLineDef
	err := r.Db.WithContext(ctx).Where("code = ?", def.Code).First(&existing).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		def.CreatedTime = time.Now()
		def.UpdatedTime = def.CreatedTime
		return r.Db.WithContext(ctx).Create(def).Error
	}
	if err != nil {
		return err
	}
	return r.Db.WithContext(ctx).Model(&existing).Updates(map[string]any{
		"name":         def.Name,
		"description":  def.Description,
		"enabled":      def.Enabled,
		"visible":      def.Visible,
		"updated_time": time.Now(),
	}).Error
}

// CountEnabledByCodes 统计给定编码里仍处于启用状态的条数。
// 配额只算启用项：停用一个空间就该立刻腾出一个名额。
func (r *BizLineRepository) CountEnabledByCodes(ctx context.Context, codes []string) (int64, error) {
	if len(codes) == 0 {
		return 0, nil
	}
	var total int64
	err := r.Db.WithContext(ctx).Model(&BizLineDef{}).
		Where("code IN ? AND enabled = ?", codes, true).Count(&total).Error
	return total, err
}

func (r *BizLineRepository) CountEnabled(ctx context.Context) (int64, error) {
	var total int64
	err := r.Db.WithContext(ctx).Model(&BizLineDef{}).Where("enabled = ?", true).Count(&total).Error
	return total, err
}

// Delete 同时清理该业务线自有的能力集。关联项目的存在性校验属于 Service，
// 因为它需要通过跨域只读端口询问 delivery 域。
func (r *BizLineRepository) Delete(ctx context.Context, code string) (int64, error) {
	var rows int64
	err := r.Db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("biz_line = ?", code).Delete(&BizLineCapability{}).Error; err != nil {
			return err
		}
		if err := tx.Where("biz_line = ?", code).Delete(&BizLineShareLink{}).Error; err != nil {
			return err
		}
		result := tx.Where("code = ?", code).Delete(&BizLineDef{})
		rows = result.RowsAffected
		return result.Error
	})
	return rows, err
}

// ---------- 能力集 ----------

func (r *BizLineRepository) ListCapabilities(ctx context.Context, bizLine string) ([]*BizLineCapability, error) {
	var rows []*BizLineCapability
	err := r.Db.WithContext(ctx).
		Where("biz_line = ? AND enabled = ?", bizLine, true).
		Order("capability_key asc").Find(&rows).Error
	return rows, err
}

func (r *BizLineRepository) UpsertCapability(ctx context.Context, cap *BizLineCapability) error {
	var existing BizLineCapability
	err := r.Db.WithContext(ctx).
		Where("biz_line = ? AND capability_key = ?", cap.BizLine, cap.CapabilityKey).
		First(&existing).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return r.Db.WithContext(ctx).Create(cap).Error
	}
	if err != nil {
		return err
	}
	return r.Db.WithContext(ctx).Model(&existing).Updates(map[string]any{
		"min_agent_version": cap.MinAgentVersion,
		"enabled":           cap.Enabled,
	}).Error
}

// SupportedKeys 返回该业务线下端侧版本可用的能力键集合，供 task 层过滤指令。
func (r *BizLineRepository) SupportedKeys(ctx context.Context, bizLine, agentVersion string) (map[string]bool, error) {
	rows, err := r.ListCapabilities(ctx, bizLine)
	if err != nil {
		return nil, err
	}
	keys := make(map[string]bool, len(rows))
	for _, row := range rows {
		if agentVersion != "" && row.MinAgentVersion != "" && row.MinAgentVersion > agentVersion {
			continue
		}
		keys[row.CapabilityKey] = true
	}
	return keys, nil
}

// ---------- 分享链接 ----------

func (r *BizLineRepository) CreateShareLink(ctx context.Context, link *BizLineShareLink) error {
	link.CreatedTime = time.Now()
	return r.Db.WithContext(ctx).Create(link).Error
}

// FindShareLink 只按令牌取记录，过期判定留给 Service：
// 过期与不存在要给出不同的提示，仓储层不该替它做这个决定。
func (r *BizLineRepository) FindShareLink(ctx context.Context, token string) (*BizLineShareLink, error) {
	var row BizLineShareLink
	if err := r.Db.WithContext(ctx).Where("token = ?", token).First(&row).Error; err != nil {
		return nil, err
	}
	return &row, nil
}

// PurgeExpiredShareLinks 在签发新链接时顺手清理，省一个定时任务。
func (r *BizLineRepository) PurgeExpiredShareLinks(ctx context.Context) error {
	return r.Db.WithContext(ctx).Where("expires_at < ?", time.Now()).Delete(&BizLineShareLink{}).Error
}
