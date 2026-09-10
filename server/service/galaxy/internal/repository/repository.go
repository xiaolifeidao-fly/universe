package repository

import (
	"context"

	"gorm.io/gorm"

	"common/middleware/db"
)

// GalaxyRepository 共享池的唯一持久化入口。泛型参数取本域最核心的表：工作单元。
type GalaxyRepository struct {
	db.Repository[*GalaxyUnit]
}

// AutoMigrate 建表。与 delivery 一致，不在服务启动时跑 —— 线上 DDL 不该是进程启动的副作用，
// 由 cmd/galaxyinit 显式调用。
func (r *GalaxyRepository) AutoMigrate() error {
	return r.Db.AutoMigrate(models()...)
}

// models 是池内全部表的唯一清单。AutoMigrate 与 galaxy.sql 的导出都从这里取 ——
// 两处各写一份的话，新表迟早只进其中一处，另一处要等到线上报「表不存在」才发现。
func models() []any {
	return []any{
		// 供给：机器 → 贡献 → 授权 → 座位
		&GalaxyNode{}, &GalaxyPairingCode{}, &GalaxyContribution{},
		&GalaxyQuotaGrant{}, &GalaxyQuotaWindow{}, &GalaxySeatBinding{},
		// 执行与计量
		&GalaxyUnit{}, &GalaxyUnitEvent{}, &GalaxyMeterRecord{}, &GalaxyUsageMismatch{},
		// 消费者
		&GalaxyConsumerKey{}, &GalaxyConsumerBalance{}, &GalaxyConsentRecord{},
		&GalaxyPrice{}, &GalaxyArtifact{}, &GalaxyPackage{}, &GalaxyOrder{},
		// 上下文账本（session 原语）
		&GalaxyLedgerSession{}, &GalaxyLedgerTurn{}, &GalaxyLedgerCheckpoint{},
		// 结算三本账、抽检与争议
		&GalaxyCreditAccount{}, &GalaxyConsumerLedger{}, &GalaxyProviderLedger{},
		&GalaxyPlatformLedger{}, &GalaxyPayout{}, &GalaxyAuditProbe{}, &GalaxyDispute{},
	}
}

func (r *GalaxyRepository) Tx(ctx context.Context, fn func(tx *GalaxyRepository) error) error {
	return r.Db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		scoped := &GalaxyRepository{}
		scoped.SetDb(tx)
		return fn(scoped)
	})
}
