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
		// 账号：共享端与使用端两张表，两批人在库里没有交集，和任务宇宙的账号体系也无关
		&GalaxyProviderUser{}, &GalaxyConsumerUser{},
		// 登录留痕：两端共用一张，端只是一列
		&GalaxyLoginRecord{},
		// 供给：机器 → 贡献 → 授权 → 座位
		&GalaxyNode{}, &GalaxyProvider{}, &GalaxyReputation{}, &GalaxyMachineBan{}, &GalaxyPairingCode{}, &GalaxyProviderKey{}, &GalaxyContribution{},
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
		// 门户：对外的模型目录与「联系我们」线索
		&GalaxyModel{}, &GalaxyModelGroup{}, &GalaxyLead{},
		// 使用者积分与分享
		&GalaxyPointsAccount{}, &GalaxyPointsLedger{}, &GalaxyReferral{}, &GalaxySetting{},
		// ai-bridge 与桌面客户端的版本分发，以及共享端的邀请返现
		&GalaxyBridgeRelease{}, &GalaxyDesktopRelease{}, &GalaxyProviderReferral{},
		// 管理端仪表盘的按小时用量汇总。派生数据，删了能重算
		&GalaxyUsageRollup{},
	}
}

func (r *GalaxyRepository) Tx(ctx context.Context, fn func(tx *GalaxyRepository) error) error {
	return r.Db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		scoped := &GalaxyRepository{}
		scoped.SetDb(tx)
		return fn(scoped)
	})
}
