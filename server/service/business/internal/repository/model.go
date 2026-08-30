package repository

import "time"

// BusinessRequirement is raw business-side intake. It intentionally has no
// foreign key to delivery tables, so product/research may later define a
// separate acceptance and conversion flow without coupling the two systems.
type BusinessRequirement struct {
	ID      int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);index:idx_business_requirement_program,priority:1;index:idx_business_requirement_creator,priority:1"`

	ProgramID int64  `gorm:"column:program_id;type:bigint;index:idx_business_requirement_program,priority:2"`
	Title     string `gorm:"column:title;type:varchar(255)"`
	Detail    string `gorm:"column:detail;type:mediumtext"`
	Status    string `gorm:"column:status;type:varchar(16);default:'submitted'"`

	CreatedBy     string    `gorm:"column:created_by;type:varchar(64);index:idx_business_requirement_creator,priority:2"`
	CreatedByName string    `gorm:"column:created_by_name;type:varchar(64)"`
	CreatedTime   time.Time `gorm:"column:created_time;type:timestamp;default:CURRENT_TIMESTAMP;index:idx_business_requirement_program,priority:3;index:idx_business_requirement_creator,priority:3"`
	UpdatedTime   time.Time `gorm:"column:updated_time;type:timestamp;default:CURRENT_TIMESTAMP"`
}

func (BusinessRequirement) TableName() string { return "zt_business_requirement" }
func (*BusinessRequirement) Init()            {}

// BusinessRequirementMessage persists both the business user's raw statements
// and remote AI replies. Each row belongs to the business intake domain only.
type BusinessRequirementMessage struct {
	ID      int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);index:idx_business_requirement_message,priority:1"`

	RequirementID int64     `gorm:"column:requirement_id;type:bigint;index:idx_business_requirement_message,priority:2"`
	Role          string    `gorm:"column:role;type:varchar(16)"`
	Content       string    `gorm:"column:content;type:mediumtext"`
	CreatedTime   time.Time `gorm:"column:created_time;type:timestamp;default:CURRENT_TIMESTAMP;index:idx_business_requirement_message,priority:3"`
}

func (BusinessRequirementMessage) TableName() string { return "zt_business_requirement_message" }
func (*BusinessRequirementMessage) Init()            {}

// BusinessRequirementDocument is a versioned AI-generated intake artefact.
// Product/research receives these server-stored documents as input to its own
// later grooming process; they are not delivery requirement documents.
type BusinessRequirementDocument struct {
	ID      int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_business_requirement_document,priority:1;index:idx_business_requirement_document,priority:1"`

	RequirementID int64     `gorm:"column:requirement_id;type:bigint;uniqueIndex:uk_business_requirement_document,priority:2;index:idx_business_requirement_document,priority:2"`
	Type          string    `gorm:"column:type;type:varchar(32);uniqueIndex:uk_business_requirement_document,priority:3"`
	Title         string    `gorm:"column:title;type:varchar(255)"`
	Content       string    `gorm:"column:content;type:mediumtext"`
	Version       int       `gorm:"column:version;uniqueIndex:uk_business_requirement_document,priority:4"`
	CreatedTime   time.Time `gorm:"column:created_time;type:timestamp;default:CURRENT_TIMESTAMP;index:idx_business_requirement_document,priority:3"`
}

func (BusinessRequirementDocument) TableName() string { return "zt_business_requirement_document" }
func (*BusinessRequirementDocument) Init()            {}
