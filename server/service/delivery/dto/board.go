// 看板与项目概览的查询与视图。

package dto

import (
	"contract"
)

// ---------- 看板 ----------

type BoardQuery struct {
	BizLine   contract.BizLine `form:"-"`
	ProgramID int64            `form:"programId"`
	// GroupBy stage / status / module，对应原型的三种分列方式。
	GroupBy        string `form:"groupBy"`
	StageKey       string `form:"stageKey"`
	ModuleKey      string `form:"moduleKey"`
	RequirementKey string `form:"requirementKey"`
	Status         string `form:"status"`
	// Phase 仅在 groupBy=status 时决定按哪个交付阶段分列；默认 requirement。
	Phase     string `form:"phase"`
	Kind      string `form:"kind"`
	OwnerName string `form:"ownerName"`
	Keyword   string `form:"keyword"`
}

type BoardColumn struct {
	Key       string     `json:"key"`
	Name      string     `json:"name"`
	Subtitle  string     `json:"subtitle"`
	Total     int        `json:"total"`
	DoneCount int        `json:"doneCount"`
	Progress  float64    `json:"progress"`
	Items     []ItemView `json:"items"`
}

type BoardView struct {
	ProgramID int64           `json:"programId"`
	GroupBy   string          `json:"groupBy"`
	Columns   []BoardColumn   `json:"columns"`
	Overview  ProgramOverview `json:"overview"`
	// RequirementOverview 只在按需求查看任务时返回，口径不受状态、阶段等看板筛选影响。
	RequirementOverview *ProgramOverview `json:"requirementOverview,omitempty"`
}

// ---------- 概览 ----------

type ModuleProgressView struct {
	ModuleKey string  `json:"moduleKey"`
	Name      string  `json:"name"`
	Weight    int     `json:"weight"`
	Kind      string  `json:"kind"`
	Total     int     `json:"total"`
	DoneCount int     `json:"doneCount"`
	Progress  float64 `json:"progress"`
}

type StageProgressView struct {
	StageKey      string  `json:"stageKey"`
	Tag           string  `json:"tag"`
	MaturityLevel string  `json:"maturityLevel"`
	Total         int     `json:"total"`
	DoneCount     int     `json:"doneCount"`
	Progress      float64 `json:"progress"`
}

type ProgramOverview struct {
	ProgramID int64  `json:"programId"`
	Name      string `json:"name"`
	// TotalCount 含 dropped，StatusCounts 按状态明细；进度统计一律排除 dropped。
	TotalCount   int            `json:"totalCount"`
	StatusCounts map[string]int `json:"statusCounts"`
	// MaturityScore 加权成熟度 = Σ(模块权重 × 模块进度) / Σ权重，汇报口径以它为准。
	MaturityScore float64 `json:"maturityScore"`
	// PlainProgress 未加权的任务平均进度，即原型页面显示的那个数，保留用于对照。
	PlainProgress  float64              `json:"plainProgress"`
	ModuleProgress []ModuleProgressView `json:"moduleProgress"`
	StageProgress  []StageProgressView  `json:"stageProgress"`
}
