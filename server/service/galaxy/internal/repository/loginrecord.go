package repository

import (
	"context"
)

// 登录留痕的持久化。两端共用一张表（zt_galaxy_login_record），端只是一列 ——
// 分表的理由在账号表上成立，在流水上不成立，见 GalaxyLoginRecord 的注释。

// CreateLoginRecord 落一行留痕。
//
// 调用方一律忽略它的错误：留痕写不进去不该把一次本来能成的登录变成失败，
// 也不该把一次本来该被拒的登录变成别的错。
func (r *GalaxyRepository) CreateLoginRecord(ctx context.Context, row *GalaxyLoginRecord) error {
	return r.Db.WithContext(ctx).Create(row).Error
}
