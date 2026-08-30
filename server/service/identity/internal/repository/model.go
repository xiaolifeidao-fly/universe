package repository

import "time"

type IdentityUser struct {
	ID           int64  `gorm:"column:id;primaryKey;autoIncrement"`
	Username     string `gorm:"column:username;type:varchar(64);uniqueIndex:uk_identity_user_username"`
	DisplayName  string `gorm:"column:display_name;type:varchar(128)"`
	PasswordHash string `gorm:"column:password_hash;type:varchar(255)"`
	Role         string `gorm:"column:role;type:varchar(16);index:idx_identity_user_status,priority:1"`
	// Persona stores the canonical comma-separated work identity set, for
	// example "business,product_research". It remains varchar(32) because
	// the product currently has exactly these two identities.
	Persona            string     `gorm:"column:persona;type:varchar(32);default:'product_research';index:idx_identity_user_persona,priority:1"`
	Status             string     `gorm:"column:status;type:varchar(16);index:idx_identity_user_status,priority:2"`
	MustChangePassword bool       `gorm:"column:must_change_password;default:false"`
	TokenVersion       int        `gorm:"column:token_version;default:1"`
	LastLoginAt        *time.Time `gorm:"column:last_login_at"`
	CreatedTime        time.Time  `gorm:"column:created_time;type:timestamp;default:CURRENT_TIMESTAMP"`
	UpdatedTime        time.Time  `gorm:"column:updated_time;type:timestamp;default:CURRENT_TIMESTAMP"`
}

func (u *IdentityUser) TableName() string { return "zt_identity_user" }
func (u *IdentityUser) Init()             {}

// IdentityUserBizLine expresses a user's visible business-line scope. It has
// no foreign key so the identity domain stays independently deployable.
type IdentityUserBizLine struct {
	ID        int64  `gorm:"column:id;primaryKey;autoIncrement"`
	UserID    int64  `gorm:"column:user_id;uniqueIndex:uk_identity_user_bizline,priority:1;index:idx_identity_user_bizline,priority:1"`
	BizLine   string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_identity_user_bizline,priority:2;index:idx_identity_user_bizline,priority:2"`
	IsManager bool   `gorm:"column:is_manager;default:false;index:idx_identity_user_bizline,priority:3"`
	// CanWrite 是空间成员的读写权。只读成员看得到空间和项目但一律不能写；
	// 管理员行始终带上这一位，判权时不必再做 is_manager 兜底。
	CanWrite  bool      `gorm:"column:can_write;default:false"`
	CreatedAt time.Time `gorm:"column:created_time;type:timestamp;default:CURRENT_TIMESTAMP"`
}

func (u *IdentityUserBizLine) TableName() string { return "zt_identity_user_biz_line" }
func (u *IdentityUserBizLine) Init()             {}

// IdentityUserProgram is the project-level scope. biz_line is a denormalized
// snapshot used for indexed assignment lookups; program_id is the delivery
// program table primary key used by runtime permission checks.
type IdentityUserProgram struct {
	ID        int64     `gorm:"column:id;primaryKey;autoIncrement"`
	UserID    int64     `gorm:"column:user_id;uniqueIndex:uk_identity_user_program,priority:1;index:idx_identity_user_program,priority:1"`
	BizLine   string    `gorm:"column:biz_line;type:varchar(32);index:idx_identity_user_program,priority:2"`
	ProgramID int64     `gorm:"column:program_id;type:bigint;uniqueIndex:uk_identity_user_program,priority:2;index:idx_identity_user_program,priority:3"`
	IsManager bool      `gorm:"column:is_manager;default:false;index:idx_identity_user_program,priority:4"`
	CreatedAt time.Time `gorm:"column:created_time;type:timestamp;default:CURRENT_TIMESTAMP"`
}

func (u *IdentityUserProgram) TableName() string { return "zt_identity_user_program" }
func (u *IdentityUserProgram) Init()             {}
