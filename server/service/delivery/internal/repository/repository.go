package repository

import (
	"context"

	"gorm.io/gorm"

	"common/middleware/db"
)

// DeliveryRepository 交付推进域的唯一持久化入口。
// 泛型参数取本域最核心的表：任务本身。
type DeliveryRepository struct {
	db.Repository[*DeliveryItem]
}

// AutoMigrate 建表。项目暂时没有独立的迁移机制，由 cmd/dlvimport 显式调用，
// 不在服务启动时跑 —— 线上 DDL 不该是进程启动的副作用。
func (r *DeliveryRepository) AutoMigrate() error {
	return r.Db.AutoMigrate(
		&DeliveryProgram{}, &DeliveryStage{}, &DeliveryModule{}, &DeliveryRequirement{}, &DeliveryRequirementEvent{}, &DeliveryRequirementCompletionNotification{}, &DeliveryRequirementPlanningSession{}, &DeliveryRequirementTestingSession{},
		&DeliveryItem{}, &DeliveryItemExecutionSession{}, &DeliveryExecutionBatch{}, &DeliveryExecutionBatchItem{}, &DeliveryItemDependency{}, &DeliveryItemEvent{}, &DeliverySnapshot{},
	)
}

// Tx 在一个事务里跑，导入用。
func (r *DeliveryRepository) Tx(ctx context.Context, fn func(tx *DeliveryRepository) error) error {
	return r.Db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		scoped := &DeliveryRepository{}
		scoped.SetDb(tx)
		return fn(scoped)
	})
}
