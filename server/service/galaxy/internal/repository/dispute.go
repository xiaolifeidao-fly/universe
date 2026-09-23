package repository

import (
	"context"
)

// DisputeQuery 工单列表的过滤条件。OwnerUserID 是消费者视角（只看自己的），
// Status / CID 是运营视角（看待办、看某个提供者身上有多少投诉）。
type DisputeQuery struct {
	BizLine     string
	OwnerUserID string
	CID         string
	Status      string
	UnitID      string
	Limit       int
}

// CreateDispute 建单。(biz_line, unit_id, attempt) 上有唯一键，
// 重复提交会撞唯一键失败 —— 这正是「同一笔钱不能被退两次」要的效果。
func (r *GalaxyRepository) CreateDispute(ctx context.Context, row *GalaxyDispute) error {
	return r.Db.WithContext(ctx).Create(row).Error
}

func (r *GalaxyRepository) FindDispute(ctx context.Context, bizLine, disputeID string) (*GalaxyDispute, error) {
	var row GalaxyDispute
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("dispute_id = ?", disputeID).
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *GalaxyRepository) ListDisputes(ctx context.Context, q DisputeQuery) ([]*GalaxyDispute, error) {
	tx := r.Db.WithContext(ctx).Model(&GalaxyDispute{}).Where("biz_line = ?", q.BizLine)
	if q.OwnerUserID != "" {
		tx = tx.Where("owner_user_id = ?", q.OwnerUserID)
	}
	if q.CID != "" {
		tx = tx.Where("cid = ?", q.CID)
	}
	if q.Status != "" {
		tx = tx.Where("status = ?", q.Status)
	}
	if q.UnitID != "" {
		tx = tx.Where("unit_id = ?", q.UnitID)
	}
	if q.Limit > 0 {
		tx = tx.Limit(q.Limit)
	}
	var rows []*GalaxyDispute
	err := tx.Order("created_time desc, id desc").Find(&rows).Error
	return rows, err
}

// UpdateDisputeStatus 条件更新：只有还停在 expect 里那几个状态的工单才动得了。
// 影响行数为 0 表示已经被别人处理过了 —— 两个运营同时点「支持申诉」时，
// 第二个人不该再退一次钱。
func (r *GalaxyRepository) UpdateDisputeStatus(ctx context.Context, bizLine, disputeID string, expect []string, values map[string]any) (bool, error) {
	result := r.Db.WithContext(ctx).Model(&GalaxyDispute{}).
		Where("biz_line = ?", bizLine).Where("dispute_id = ?", disputeID).
		Where("status IN ?", expect).
		Updates(values)
	if result.Error != nil {
		return false, result.Error
	}
	return result.RowsAffected > 0, nil
}

// ListMeterRecords 取一次执行的全部计量流水。追回按它算，不重新解析响应。
func (r *GalaxyRepository) ListMeterRecords(ctx context.Context, bizLine, unitID string, attempt int) ([]*GalaxyMeterRecord, error) {
	var rows []*GalaxyMeterRecord
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("unit_id = ?", unitID).Where("attempt = ?", attempt).
		Order("unit").Find(&rows).Error
	return rows, err
}

// CountOpenDisputes 某个提供者身上还没处理完的投诉数。运营列表按它排序：
// 一个贡献上堆着好几张开着的工单，比单张工单本身更值得先看一眼。
func (r *GalaxyRepository) CountOpenDisputes(ctx context.Context, bizLine, cid string) (int64, error) {
	var total int64
	err := r.Db.WithContext(ctx).Model(&GalaxyDispute{}).
		Where("biz_line = ?", bizLine).Where("cid = ?", cid).
		Where("status IN ?", []string{"open", "reviewing"}).
		Count(&total).Error
	return total, err
}
