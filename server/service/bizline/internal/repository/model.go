// Package repository 只能被 service/bizline 目录树引用（Go internal 规则）。
package repository

import "time"

// BizLineDef 业务线注册表。
type BizLineDef struct {
	Id          int64     `gorm:"column:id;primaryKey;autoIncrement" description:"主键"`
	Code        string    `gorm:"column:code;type:varchar(32);uniqueIndex" description:"业务线编码 whatsapp/tiktok"`
	Name        string    `gorm:"column:name;type:varchar(64)" description:"业务线名称"`
	Description string    `gorm:"column:description;type:varchar(512)" description:"业务线描述，分享链接上展示给受邀人"`
	Enabled     bool      `gorm:"column:enabled;default:1" description:"是否启用"`
	Visible     bool      `gorm:"column:visible;default:1" description:"是否可见：置否后只有本空间管理员能看到它"`
	CreatedBy   int64     `gorm:"column:created_by;default:0" description:"创建人用户标识，创建者不能被移出空间"`
	CreatedTime time.Time `gorm:"column:created_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"创建时间"`
	UpdatedTime time.Time `gorm:"column:updated_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"更新时间"`
}

func (b *BizLineDef) TableName() string { return "zt_bizline_def" }
func (b *BizLineDef) Init()             {}

// BizLineCapability 业务线声明的端侧能力集。
// 端侧 poll 上报的 caps_version 与这张表比对，task 层据此过滤指令。
type BizLineCapability struct {
	Id              int64  `gorm:"column:id;primaryKey;autoIncrement" description:"主键"`
	BizLine         string `gorm:"column:biz_line;type:varchar(32);uniqueIndex:uk_bizline_cap,priority:1" description:"业务线"`
	CapabilityKey   string `gorm:"column:capability_key;type:varchar(64);uniqueIndex:uk_bizline_cap,priority:2" description:"能力标识 如 send_voice"`
	MinAgentVersion string `gorm:"column:min_agent_version;type:varchar(32)" description:"最低端侧版本"`
	Enabled         bool   `gorm:"column:enabled;default:1" description:"是否启用"`
}

func (b *BizLineCapability) TableName() string { return "zt_bizline_capability" }
func (b *BizLineCapability) Init()             {}

// BizLineShareLink 是空间的加入邀请。成员不再由管理员直接勾选，
// 只能拿着链接自助加入，链接本身决定加入后是只读还是写入。
type BizLineShareLink struct {
	Id          int64     `gorm:"column:id;primaryKey;autoIncrement" description:"主键"`
	Token       string    `gorm:"column:token;type:varchar(64);uniqueIndex" description:"链接令牌"`
	BizLine     string    `gorm:"column:biz_line;type:varchar(32);index:idx_bizline_share_line" description:"业务线编码"`
	Permission  string    `gorm:"column:permission;type:varchar(16)" description:"加入后的权限 read/write"`
	CreatedBy   string    `gorm:"column:created_by;type:varchar(64)" description:"创建人用户标识"`
	ExpiresAt   time.Time `gorm:"column:expires_at;type:timestamp" description:"过期时间，默认签发后 1 小时"`
	CreatedTime time.Time `gorm:"column:created_time;type:timestamp;default:CURRENT_TIMESTAMP" description:"创建时间"`
}

func (b *BizLineShareLink) TableName() string { return "zt_bizline_share_link" }
func (b *BizLineShareLink) Init()             {}
