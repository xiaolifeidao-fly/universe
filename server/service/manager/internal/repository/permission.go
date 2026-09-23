package repository

import (
	"context"
	"strings"

	"gorm.io/gorm/clause"
)

// ---------- 角色 ----------

func (r *ManagerRepository) CreateRole(ctx context.Context, row *ManagerRole) error {
	return r.Db.WithContext(ctx).Create(row).Error
}

func (r *ManagerRepository) FindRole(ctx context.Context, id int64) (*ManagerRole, error) {
	var row ManagerRole
	err := r.Db.WithContext(ctx).Where("id = ?", id).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *ManagerRepository) FindRoleByCode(ctx context.Context, code string) (*ManagerRole, error) {
	var row ManagerRole
	err := r.Db.WithContext(ctx).Where("code = ?", strings.TrimSpace(code)).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *ManagerRepository) UpdateRole(ctx context.Context, id int64, values map[string]any) error {
	return r.Db.WithContext(ctx).Model(&ManagerRole{}).Where("id = ?", id).Updates(values).Error
}

func (r *ManagerRepository) ListRoles(ctx context.Context, status string) ([]*ManagerRole, error) {
	tx := r.Db.WithContext(ctx)
	if status != "" {
		tx = tx.Where("status = ?", status)
	}
	var rows []*ManagerRole
	err := tx.Order("id").Find(&rows).Error
	return rows, err
}

// DeleteRole 删角色连同它的两组关联。留着关联行的话，角色 id 被复用时
// 旧授权会凭空复活到新角色头上。
func (r *ManagerRepository) DeleteRole(ctx context.Context, id int64) error {
	return r.Tx(ctx, func(tx *ManagerRepository) error {
		if err := tx.Db.WithContext(ctx).Where("role_id = ?", id).Delete(&ManagerUserRole{}).Error; err != nil {
			return err
		}
		if err := tx.Db.WithContext(ctx).Where("role_id = ?", id).Delete(&ManagerRoleResource{}).Error; err != nil {
			return err
		}
		return tx.Db.WithContext(ctx).Where("id = ?", id).Delete(&ManagerRole{}).Error
	})
}

// ---------- 资源 ----------

func (r *ManagerRepository) CreateResource(ctx context.Context, row *ManagerResource) error {
	return r.Db.WithContext(ctx).Create(row).Error
}

// UpsertResourceByCode 按 code 幂等写入。managerinit 会反复跑，
// 已存在的资源只更新可变字段，不重建 —— 重建会换掉 id，把角色授权全部作废。
func (r *ManagerRepository) UpsertResourceByCode(ctx context.Context, row *ManagerResource) error {
	return r.Db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "code"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"parent_id", "name", "resource_type", "method",
			"resource_url", "page_url", "icon", "sort_id", "status",
		}),
	}).Create(row).Error
}

func (r *ManagerRepository) FindResource(ctx context.Context, id int64) (*ManagerResource, error) {
	var row ManagerResource
	err := r.Db.WithContext(ctx).Where("id = ?", id).First(&row).Error
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *ManagerRepository) UpdateResource(ctx context.Context, id int64, values map[string]any) error {
	return r.Db.WithContext(ctx).Model(&ManagerResource{}).Where("id = ?", id).Updates(values).Error
}

// ListResources 取全部资源。表很小（页面 + 接口，百来行），一次读完在内存里拼树，
// 比按 parent_id 递归查省掉一串往返。
func (r *ManagerRepository) ListResources(ctx context.Context, resourceType, status string) ([]*ManagerResource, error) {
	tx := r.Db.WithContext(ctx)
	if resourceType != "" {
		tx = tx.Where("resource_type = ?", resourceType)
	}
	if status != "" {
		tx = tx.Where("status = ?", status)
	}
	var rows []*ManagerResource
	err := tx.Order("sort_id, id").Find(&rows).Error
	return rows, err
}

func (r *ManagerRepository) DeleteResource(ctx context.Context, id int64) error {
	return r.Tx(ctx, func(tx *ManagerRepository) error {
		if err := tx.Db.WithContext(ctx).Where("resource_id = ?", id).Delete(&ManagerRoleResource{}).Error; err != nil {
			return err
		}
		return tx.Db.WithContext(ctx).Where("id = ?", id).Delete(&ManagerResource{}).Error
	})
}

// ---------- 关联 ----------

func (r *ManagerRepository) ListUserRoles(ctx context.Context, userID int64) ([]*ManagerUserRole, error) {
	var rows []*ManagerUserRole
	err := r.Db.WithContext(ctx).Where("user_id = ?", userID).Order("id").Find(&rows).Error
	return rows, err
}

// ReplaceUserRoles 整组替换。逐条增删的话，中途失败会留下一个既不是旧集合、
// 也不是新集合的状态。
func (r *ManagerRepository) ReplaceUserRoles(ctx context.Context, userID int64, roleIDs []int64) error {
	return r.Tx(ctx, func(tx *ManagerRepository) error {
		if err := tx.Db.WithContext(ctx).Where("user_id = ?", userID).Delete(&ManagerUserRole{}).Error; err != nil {
			return err
		}
		rows := make([]*ManagerUserRole, 0, len(roleIDs))
		for _, roleID := range roleIDs {
			if roleID > 0 {
				rows = append(rows, &ManagerUserRole{UserID: userID, RoleID: roleID})
			}
		}
		if len(rows) == 0 {
			return nil
		}
		return tx.Db.WithContext(ctx).Create(rows).Error
	})
}

func (r *ManagerRepository) ListRoleResources(ctx context.Context, roleIDs []int64) ([]*ManagerRoleResource, error) {
	tx := r.Db.WithContext(ctx)
	if len(roleIDs) > 0 {
		tx = tx.Where("role_id IN ?", roleIDs)
	}
	var rows []*ManagerRoleResource
	err := tx.Order("id").Find(&rows).Error
	return rows, err
}

func (r *ManagerRepository) ReplaceRoleResources(ctx context.Context, roleID int64, resourceIDs []int64) error {
	return r.Tx(ctx, func(tx *ManagerRepository) error {
		if err := tx.Db.WithContext(ctx).Where("role_id = ?", roleID).Delete(&ManagerRoleResource{}).Error; err != nil {
			return err
		}
		rows := make([]*ManagerRoleResource, 0, len(resourceIDs))
		for _, resourceID := range resourceIDs {
			if resourceID > 0 {
				rows = append(rows, &ManagerRoleResource{RoleID: roleID, ResourceID: resourceID})
			}
		}
		if len(rows) == 0 {
			return nil
		}
		return tx.Db.WithContext(ctx).Create(rows).Error
	})
}

// UsersByRole 数一个角色下还有多少人，删角色前用来提示。
func (r *ManagerRepository) UsersByRole(ctx context.Context, roleID int64) (int64, error) {
	var total int64
	err := r.Db.WithContext(ctx).Model(&ManagerUserRole{}).Where("role_id = ?", roleID).Count(&total).Error
	return total, err
}

// ListUserIDsByRole 取一个角色下全部成员的业务键（user_id，不是自增 id）。
// 令牌存储按业务键索引会话，踢人时要的是它。
func (r *ManagerRepository) ListUserIDsByRole(ctx context.Context, roleID int64) ([]string, error) {
	var ids []string
	err := r.Db.WithContext(ctx).Model(&ManagerUser{}).
		Joins("JOIN zt_manager_user_role ON zt_manager_user_role.user_id = zt_manager_user.id").
		Where("zt_manager_user_role.role_id = ?", roleID).
		Pluck("zt_manager_user.user_id", &ids).Error
	return ids, err
}

// ListResourceCodes 按 code 批量取资源 id，给初始化命令按编码授权用。
func (r *ManagerRepository) ListResourceCodes(ctx context.Context, codes []string) (map[string]int64, error) {
	if len(codes) == 0 {
		return map[string]int64{}, nil
	}
	var rows []*ManagerResource
	if err := r.Db.WithContext(ctx).Where("code IN ?", codes).Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make(map[string]int64, len(rows))
	for _, row := range rows {
		out[row.Code] = row.ID
	}
	return out, nil
}
