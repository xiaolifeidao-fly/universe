package repository

import (
	"context"
	"time"
)

func (r *GalaxyRepository) CreateAuditProbe(ctx context.Context, row *GalaxyAuditProbe) error {
	return r.Db.WithContext(ctx).Create(row).Error
}

func (r *GalaxyRepository) FindAuditProbeByUnit(ctx context.Context, bizLine, unitID string) (*GalaxyAuditProbe, error) {
	var row GalaxyAuditProbe
	err := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine).Where("unit_id = ?", unitID).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *GalaxyRepository) UpdateAuditProbe(ctx context.Context, bizLine, probeID string, values map[string]any) error {
	return r.Db.WithContext(ctx).Model(&GalaxyAuditProbe{}).
		Where("biz_line = ?", bizLine).Where("probe_id = ?", probeID).
		Updates(values).Error
}

// ListReadyProbes 取待比对的抽检。ready 表示节点那次已经跑完、签名也记下了，
// 就差用 Hub 自己的账号重放一次。
func (r *GalaxyRepository) ListReadyProbes(ctx context.Context, bizLine string, limit int) ([]*GalaxyAuditProbe, error) {
	if limit <= 0 {
		limit = 20
	}
	var rows []*GalaxyAuditProbe
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("verdict = ?", "ready").
		Order("created_at").Limit(limit).Find(&rows).Error
	return rows, err
}

// CountVerdicts 数某个贡献最近的判定。累计两次伪造就摘除（设计文档 13）。
func (r *GalaxyRepository) CountVerdicts(ctx context.Context, bizLine, cid, verdict string, since time.Time) (int64, error) {
	var total int64
	err := r.Db.WithContext(ctx).Model(&GalaxyAuditProbe{}).
		Where("biz_line = ?", bizLine).Where("cid = ?", cid).
		Where("verdict = ?", verdict).Where("created_at >= ?", since).
		Count(&total).Error
	return total, err
}

// PurgeStaleProbeBodies 清掉超期未跑的抽检里留着的请求原文。
// 保留原文的唯一理由是「还要重放一次」；理由消失就该删。
func (r *GalaxyRepository) PurgeStaleProbeBodies(ctx context.Context, bizLine string, before time.Time) error {
	return r.Db.WithContext(ctx).Model(&GalaxyAuditProbe{}).
		Where("biz_line = ?", bizLine).Where("created_at < ?", before).
		Where("request_body <> ?", "").
		Updates(map[string]any{"request_body": "", "verdict": "skipped"}).Error
}

// ListRecentProbes 最近的抽检记录，运营后台用。
func (r *GalaxyRepository) ListRecentProbes(ctx context.Context, bizLine, cid string, limit int) ([]*GalaxyAuditProbe, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	tx := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine)
	if cid != "" {
		tx = tx.Where("cid = ?", cid)
	}
	var rows []*GalaxyAuditProbe
	err := tx.Order("created_at desc").Limit(limit).Find(&rows).Error
	return rows, err
}
