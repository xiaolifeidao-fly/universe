package repository

import (
	"context"
	"errors"
	"strings"
	"time"

	"common/middleware/db"
	"gorm.io/gorm"
)

type UserQuery struct {
	Keyword string
	Role    string
	Status  string
	Offset  int
	Limit   int
}

type IdentityRepository struct{ db.Repository[*IdentityUser] }

func (r *IdentityRepository) AutoMigrate() error {
	return r.Db.AutoMigrate(&IdentityUser{}, &IdentityUserBizLine{}, &IdentityUserProgram{})
}

func (r *IdentityRepository) FindUserByUsername(ctx context.Context, username string) (*IdentityUser, error) {
	var row IdentityUser
	if err := r.Db.WithContext(ctx).Where("username = ?", username).First(&row).Error; err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *IdentityRepository) FindUser(ctx context.Context, id int64) (*IdentityUser, error) {
	var row IdentityUser
	if err := r.Db.WithContext(ctx).Where("id = ?", id).First(&row).Error; err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *IdentityRepository) ListUsers(ctx context.Context, q UserQuery) ([]*IdentityUser, int64, error) {
	database := r.Db.WithContext(ctx).Model(&IdentityUser{})
	if keyword := strings.TrimSpace(q.Keyword); keyword != "" {
		like := "%" + keyword + "%"
		database = database.Where("username LIKE ? OR display_name LIKE ?", like, like)
	}
	if q.Role != "" {
		database = database.Where("role = ?", q.Role)
	}
	if q.Status != "" {
		database = database.Where("status = ?", q.Status)
	}
	var total int64
	if err := database.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []*IdentityUser
	if err := database.Order("created_time asc").Offset(q.Offset).Limit(q.Limit).Find(&rows).Error; err != nil {
		return nil, 0, err
	}
	return rows, total, nil
}

func (r *IdentityRepository) CreateUser(ctx context.Context, row *IdentityUser) error {
	now := time.Now()
	row.CreatedTime = now
	row.UpdatedTime = now
	return r.Db.WithContext(ctx).Create(row).Error
}

func (r *IdentityRepository) UpdateUser(ctx context.Context, row *IdentityUser) error {
	return r.Db.WithContext(ctx).Model(&IdentityUser{}).Where("id = ?", row.ID).Updates(map[string]any{
		"username": row.Username, "display_name": row.DisplayName, "role": row.Role,
		"status": row.Status, "must_change_password": row.MustChangePassword,
		"password_hash": row.PasswordHash, "token_version": row.TokenVersion,
		"updated_time": time.Now(),
	}).Error
}

func (r *IdentityRepository) UpdateLastLogin(ctx context.Context, id int64) error {
	return r.Db.WithContext(ctx).Model(&IdentityUser{}).Where("id = ?", id).Updates(map[string]any{
		"last_login_at": time.Now(), "updated_time": time.Now(),
	}).Error
}

func (r *IdentityRepository) CountActiveAdmins(ctx context.Context) (int64, error) {
	var total int64
	err := r.Db.WithContext(ctx).Model(&IdentityUser{}).
		Where("role = ? AND status = ?", "admin", "active").Count(&total).Error
	return total, err
}

func (r *IdentityRepository) DeleteUser(ctx context.Context, id int64) error {
	return r.Db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("user_id = ?", id).Delete(&IdentityUserBizLine{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ?", id).Delete(&IdentityUserProgram{}).Error; err != nil {
			return err
		}
		result := tx.Where("id = ?", id).Delete(&IdentityUser{})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return gorm.ErrRecordNotFound
		}
		return nil
	})
}

func (r *IdentityRepository) ListBizLines(ctx context.Context, userID int64) ([]string, error) {
	rows, err := r.ListBizLineAssignments(ctx, userID)
	if err != nil {
		return nil, err
	}
	values := make([]string, 0, len(rows))
	for _, row := range rows {
		values = append(values, row.BizLine)
	}
	return values, nil
}

func (r *IdentityRepository) ListBizLineAssignments(ctx context.Context, userID int64) ([]*IdentityUserBizLine, error) {
	var rows []*IdentityUserBizLine
	if err := r.Db.WithContext(ctx).Where("user_id = ?", userID).Order("biz_line asc").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func (r *IdentityRepository) ListBizLineAssignmentsByBizLine(ctx context.Context, bizLine string) ([]*IdentityUserBizLine, error) {
	var rows []*IdentityUserBizLine
	if err := r.Db.WithContext(ctx).Where("biz_line = ?", bizLine).Order("user_id asc").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func (r *IdentityRepository) ListPrograms(ctx context.Context, userID int64) ([]*IdentityUserProgram, error) {
	var rows []*IdentityUserProgram
	if err := r.Db.WithContext(ctx).Where("user_id = ?", userID).Order("biz_line asc, program_id asc").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func (r *IdentityRepository) ListProgramAssignments(ctx context.Context, programID int64) ([]*IdentityUserProgram, error) {
	var rows []*IdentityUserProgram
	if err := r.Db.WithContext(ctx).Where("program_id = ?", programID).Order("user_id asc").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// ListActiveUsersByIDs 返回指定范围内仍可参与分配的成员。
// 不用关联外键，身份域和项目域仍以业务键解耦。
func (r *IdentityRepository) ListActiveUsersByIDs(ctx context.Context, ids []int64) ([]*IdentityUser, error) {
	if len(ids) == 0 {
		return []*IdentityUser{}, nil
	}
	var rows []*IdentityUser
	if err := r.Db.WithContext(ctx).
		Where("id IN ? AND status = ?", ids, "active").
		Order("id asc").
		Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func (r *IdentityRepository) ReplaceAssignments(ctx context.Context, userID int64, bizLines []string, programs []IdentityUserProgram) error {
	return r.Db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var existingBizLines []*IdentityUserBizLine
		if err := tx.Where("user_id = ?", userID).Find(&existingBizLines).Error; err != nil {
			return err
		}
		bizLineManagers := make(map[string]bool, len(existingBizLines))
		bizLineWriters := make(map[string]bool, len(existingBizLines))
		for _, assignment := range existingBizLines {
			bizLineManagers[assignment.BizLine] = assignment.IsManager
			bizLineWriters[assignment.BizLine] = assignment.CanWrite
		}
		var existingPrograms []*IdentityUserProgram
		if err := tx.Where("user_id = ?", userID).Find(&existingPrograms).Error; err != nil {
			return err
		}
		programManagers := make(map[int64]bool, len(existingPrograms))
		for _, assignment := range existingPrograms {
			programManagers[assignment.ProgramID] = assignment.IsManager
		}
		if err := tx.Where("user_id = ?", userID).Delete(&IdentityUserBizLine{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ?", userID).Delete(&IdentityUserProgram{}).Error; err != nil {
			return err
		}
		for _, bizLine := range bizLines {
			if err := tx.Create(&IdentityUserBizLine{UserID: userID, BizLine: bizLine, IsManager: bizLineManagers[bizLine], CanWrite: bizLineManagers[bizLine] || bizLineWriters[bizLine]}).Error; err != nil {
				return err
			}
		}
		for _, program := range programs {
			program.ID = 0
			program.UserID = userID
			program.IsManager = programManagers[program.ProgramID]
			if err := tx.Create(&program).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

func (r *IdentityRepository) ReplaceBizLineAssignments(ctx context.Context, bizLine string, rows []IdentityUserBizLine) error {
	return r.Db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("biz_line = ?", bizLine).Delete(&IdentityUserBizLine{}).Error; err != nil {
			return err
		}
		for _, row := range rows {
			row.ID = 0
			row.BizLine = bizLine
			if err := tx.Create(&row).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

func (r *IdentityRepository) ReplaceProgramAssignments(ctx context.Context, programID int64, bizLine string, rows []IdentityUserProgram) error {
	return r.Db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("program_id = ?", programID).Delete(&IdentityUserProgram{}).Error; err != nil {
			return err
		}
		for _, row := range rows {
			row.ID = 0
			row.ProgramID = programID
			row.BizLine = bizLine
			if err := tx.Create(&row).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

// FindBizLineAssignment 取一条成员关系，用于加入前的重复判断和权限调整。
func (r *IdentityRepository) FindBizLineAssignment(ctx context.Context, bizLine string, userID int64) (*IdentityUserBizLine, error) {
	var row IdentityUserBizLine
	if err := r.Db.WithContext(ctx).Where("biz_line = ? AND user_id = ?", bizLine, userID).First(&row).Error; err != nil {
		return nil, err
	}
	return &row, nil
}

// UpsertBizLineMember 单条写入成员关系。分享链接加入和踢人都只动一条记录，
// 不能走 ReplaceBizLineAssignments 那种整表重建的路径。
func (r *IdentityRepository) UpsertBizLineMember(ctx context.Context, row *IdentityUserBizLine) error {
	var existing IdentityUserBizLine
	err := r.Db.WithContext(ctx).Where("biz_line = ? AND user_id = ?", row.BizLine, row.UserID).First(&existing).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		row.ID = 0
		return r.Db.WithContext(ctx).Create(row).Error
	}
	if err != nil {
		return err
	}
	return r.Db.WithContext(ctx).Model(&existing).Updates(map[string]any{
		"is_manager": row.IsManager,
		"can_write":  row.CanWrite,
	}).Error
}

// DeleteBizLineMember 同时清掉该成员在这条业务线下的项目授权，
// 否则被移出空间的人还留着项目级可见性。
func (r *IdentityRepository) DeleteBizLineMember(ctx context.Context, bizLine string, userID int64) (int64, error) {
	var rows int64
	err := r.Db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("biz_line = ? AND user_id = ?", bizLine, userID).Delete(&IdentityUserProgram{}).Error; err != nil {
			return err
		}
		result := tx.Where("biz_line = ? AND user_id = ?", bizLine, userID).Delete(&IdentityUserBizLine{})
		rows = result.RowsAffected
		return result.Error
	})
	return rows, err
}

func (r *IdentityRepository) CountBizLineManagers(ctx context.Context, bizLine string) (int64, error) {
	var total int64
	err := r.Db.WithContext(ctx).Model(&IdentityUserBizLine{}).
		Where("biz_line = ? AND is_manager = ?", bizLine, true).Count(&total).Error
	return total, err
}

func (r *IdentityRepository) ListUsersByIDs(ctx context.Context, ids []int64) ([]*IdentityUser, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	var rows []*IdentityUser
	err := r.Db.WithContext(ctx).Where("id IN ?", ids).Order("id asc").Find(&rows).Error
	return rows, err
}

func IsNotFound(err error) bool { return errors.Is(err, gorm.ErrRecordNotFound) }
