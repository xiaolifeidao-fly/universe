package repository

import (
	"context"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func (r *GalaxyRepository) CreateSession(ctx context.Context, row *GalaxyLedgerSession) error {
	return r.Db.WithContext(ctx).Create(row).Error
}

func (r *GalaxyRepository) FindSession(ctx context.Context, bizLine, sid string) (*GalaxyLedgerSession, error) {
	var row GalaxyLedgerSession
	err := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine).Where("sid = ?", sid).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// SessionQuery 会话列表的过滤条件。ConsumerKeys 是控制台用的：一个人名下的
// 全部密钥一次查完，语义与 UnitQuery.ConsumerKeys 一致。
type SessionQuery struct {
	BizLine      string
	ConsumerKey  string
	ConsumerKeys []string
	Kind         string
	State        string
	Limit        int
}

func (r *GalaxyRepository) ListSessions(ctx context.Context, q SessionQuery) ([]*GalaxyLedgerSession, error) {
	tx := r.Db.WithContext(ctx).Model(&GalaxyLedgerSession{}).Where("biz_line = ?", q.BizLine)
	if q.ConsumerKey != "" {
		tx = tx.Where("consumer_key = ?", q.ConsumerKey)
	}
	if len(q.ConsumerKeys) > 0 {
		tx = tx.Where("consumer_key IN ?", q.ConsumerKeys)
	}
	if q.Kind != "" {
		tx = tx.Where("kind = ?", q.Kind)
	}
	if q.State != "" {
		tx = tx.Where("state = ?", q.State)
	}
	if q.Limit > 0 {
		tx = tx.Limit(q.Limit)
	}
	var rows []*GalaxyLedgerSession
	err := tx.Order("created_time desc, id desc").Find(&rows).Error
	return rows, err
}

func (r *GalaxyRepository) UpdateSession(ctx context.Context, bizLine, sid string, values map[string]any) error {
	return r.Db.WithContext(ctx).Model(&GalaxyLedgerSession{}).
		Where("biz_line = ?", bizLine).Where("sid = ?", sid).
		Updates(values).Error
}

// ClaimTurnSeq 抢占一个回合序号。(sid, seq) 上有唯一键，重复提交同一个 seq
// 会撞唯一键失败 —— 这正是「重复的 turn.start 不重跑」要的效果。
func (r *GalaxyRepository) ClaimTurnSeq(ctx context.Context, row *GalaxyLedgerTurn) error {
	return r.Db.WithContext(ctx).Create(row).Error
}

func (r *GalaxyRepository) UpdateTurn(ctx context.Context, bizLine, sid string, seq int, values map[string]any) error {
	return r.Db.WithContext(ctx).Model(&GalaxyLedgerTurn{}).
		Where("biz_line = ?", bizLine).Where("sid = ?", sid).Where("seq = ?", seq).
		Updates(values).Error
}

func (r *GalaxyRepository) FindTurn(ctx context.Context, bizLine, sid string, seq int) (*GalaxyLedgerTurn, error) {
	var row GalaxyLedgerTurn
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("sid = ?", sid).Where("seq = ?", seq).
		First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *GalaxyRepository) FindTurnByUnit(ctx context.Context, bizLine, unitID string) (*GalaxyLedgerTurn, error) {
	var row GalaxyLedgerTurn
	err := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine).Where("unit_id = ?", unitID).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *GalaxyRepository) ListTurns(ctx context.Context, bizLine, sid string, fromSeq, limit int) ([]*GalaxyLedgerTurn, error) {
	tx := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("sid = ?", sid).Where("seq > ?", fromSeq)
	if limit > 0 {
		tx = tx.Limit(limit)
	}
	var rows []*GalaxyLedgerTurn
	err := tx.Order("seq").Find(&rows).Error
	return rows, err
}

// CompleteTurn 回合终态 + 会话游标一起更新。分开写的话，节点在两次写之间掉线
// 会留下「回合完了但 last_seq 没动」的会话，下一次续接就会重跑这一回合。
func (r *GalaxyRepository) CompleteTurn(ctx context.Context, bizLine, sid string, seq int, turn map[string]any, session map[string]any) error {
	return r.Tx(ctx, func(tx *GalaxyRepository) error {
		if err := tx.Db.WithContext(ctx).Model(&GalaxyLedgerTurn{}).
			Where("biz_line = ?", bizLine).Where("sid = ?", sid).Where("seq = ?", seq).
			Updates(turn).Error; err != nil {
			return err
		}
		if len(session) == 0 {
			return nil
		}
		return tx.Db.WithContext(ctx).Model(&GalaxyLedgerSession{}).
			Where("biz_line = ?", bizLine).Where("sid = ?", sid).
			Updates(session).Error
	})
}

func (r *GalaxyRepository) SaveCheckpoint(ctx context.Context, row *GalaxyLedgerCheckpoint) error {
	return r.Db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "biz_line"}, {Name: "sid"}, {Name: "seq"}},
		DoUpdates: clause.AssignmentColumns([]string{"provider", "cli_version", "object_key", "size"}),
	}).Create(row).Error
}

// LatestCheckpoint 取最近一次快照。跨节点续接优先用它，用不了才退回账本摘要。
func (r *GalaxyRepository) LatestCheckpoint(ctx context.Context, bizLine, sid string) (*GalaxyLedgerCheckpoint, error) {
	var row GalaxyLedgerCheckpoint
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).Where("sid = ?", sid).
		Order("seq desc").First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// SweepIdleSessions 关掉长期没有回合的会话，释放它钉着的座位。
func (r *GalaxyRepository) SweepIdleSessions(ctx context.Context, bizLine string, before time.Time) ([]*GalaxyLedgerSession, error) {
	var rows []*GalaxyLedgerSession
	err := r.Db.WithContext(ctx).
		Where("biz_line = ?", bizLine).
		Where("state IN ?", []string{"open", "pinned", "migrating"}).
		Where("COALESCE(last_turn_at, created_time) < ?", before).
		Limit(200).Find(&rows).Error
	return rows, err
}

var _ = gorm.ErrRecordNotFound
