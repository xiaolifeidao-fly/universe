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
	// Remote conversation state is persisted so the web process can restart
	// while Kodes is still working and the browser can continue polling.
	RemoteThreadID string `gorm:"column:remote_thread_id;type:varchar(128)"`
	RemoteTurnID   string `gorm:"column:remote_turn_id;type:varchar(128)"`
	RemoteStatus   string `gorm:"column:remote_status;type:varchar(16);default:'idle'"`
	RemoteError    string `gorm:"column:remote_error;type:varchar(512)"`
	// RemoteMode tells what the running turn was asked to produce: an ordinary
	// interview reply, or the detailed document the business user confirmed.
	// It is persisted because the turn is finalized by a later poll request,
	// which otherwise could not tell the two apart.
	RemoteMode string `gorm:"column:remote_mode;type:varchar(16)"`
	// RemoteWorkspace is the logical directory resolved by remote Kodes. It is
	// frozen at submission time so later product/research reads use the
	// business user's own workspace rather than the current viewer's identity.
	RemoteWorkspace string `gorm:"column:remote_workspace;type:varchar(512)"`

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

// BusinessRequirementAttachment is the server-side manifest of a file the
// business user uploaded into an intake conversation. The bytes stay in the
// remote Kodes business workspace; this row only records what was sent, so
// the console can list attachments without asking the remote service.
type BusinessRequirementAttachment struct {
	ID      int64  `gorm:"column:id;primaryKey;autoIncrement"`
	BizLine string `gorm:"column:biz_line;type:varchar(32);index:idx_business_requirement_attachment,priority:1"`

	RequirementID int64 `gorm:"column:requirement_id;type:bigint;index:idx_business_requirement_attachment,priority:2"`
	// MessageID is zero until the upload is sent with a message. Unsent rows
	// keep the file reachable for preview while the user is still typing.
	MessageID int64 `gorm:"column:message_id;type:bigint;index:idx_business_requirement_attachment_message"`
	// RemoteID is the attachment identifier owned by remote Kodes; it is what
	// a conversation request and a download both address the file by.
	RemoteID    string    `gorm:"column:remote_id;type:varchar(128);uniqueIndex:uk_business_requirement_attachment_remote"`
	Name        string    `gorm:"column:name;type:varchar(255)"`
	ContentType string    `gorm:"column:content_type;type:varchar(128)"`
	Size        int64     `gorm:"column:size;type:bigint"`
	IsImage     bool      `gorm:"column:is_image;type:tinyint(1)"`
	CreatedBy   string    `gorm:"column:created_by;type:varchar(64)"`
	CreatedTime time.Time `gorm:"column:created_time;type:timestamp;default:CURRENT_TIMESTAMP;index:idx_business_requirement_attachment,priority:3"`
}

func (BusinessRequirementAttachment) TableName() string { return "zt_business_requirement_attachment" }
func (*BusinessRequirementAttachment) Init()            {}
