// Package repository 只能被 service/bizline 目录树引用（Go internal 规则）。
package repository

import "time"

// BizLineDef 业务线注册表。
type BizLineDef struct {
	Id          int64     `gorm:"column:id;primaryKey;autoIncrement" description:"主键"`
	Code        string    `gorm:"column:code;type:varchar(32);uniqueIndex" description:"业务线编码 whatsapp/tiktok"`
	Name        string    `gorm:"column:name;type:varchar(64)" description:"业务线名称"`
	Enabled     bool      `gorm:"column:enabled;default:1" description:"是否启用"`
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
