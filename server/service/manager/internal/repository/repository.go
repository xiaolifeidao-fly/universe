package repository

import (
	"context"

	"gorm.io/gorm"

	"common/middleware/db"
)

type ManagerRepository struct {
	db.Repository[*ManagerUser]
}

// AutoMigrate 建表。与 identity / galaxy 一致，不在服务启动时跑 ——
// 线上 DDL 不该是进程启动的副作用，由 cmd/managerinit 显式调用。
func (r *ManagerRepository) AutoMigrate() error {
	return r.Db.AutoMigrate(models()...)
}

// models 是管理端权限体系全部表的唯一清单。
func models() []any {
	return []any{
		&ManagerUser{}, &ManagerRole{}, &ManagerResource{},
		&ManagerUserRole{}, &ManagerRoleResource{}, &ManagerLoginRecord{},
	}
}

func (r *ManagerRepository) Tx(ctx context.Context, fn func(tx *ManagerRepository) error) error {
	return r.Db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		scoped := &ManagerRepository{}
		scoped.SetDb(tx)
		return fn(scoped)
	})
}

func IsNotFound(err error) bool { return err == gorm.ErrRecordNotFound }
