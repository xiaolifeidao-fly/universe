// 模块相关的请求、查询与视图。

package dto

import (
	"contract"
)

// ---------- 模块 ----------

type ModuleView struct {
	ModuleKey string `json:"moduleKey"`
	Seq       int    `json:"seq"`
	Name      string `json:"name"`
	Weight    int    `json:"weight"`
	Kind      string `json:"kind"`
	ItemCount int64  `json:"itemCount"`
}

type SaveModuleRequest struct {
	BizLine   contract.BizLine `json:"-"`
	ProgramID int64            `json:"programId"`
	ModuleKey string           `json:"moduleKey"`
	Seq       int              `json:"seq"`
	Name      string           `json:"name"`
	Weight    int              `json:"weight"`
	Kind      string           `json:"kind"`
}

type ModuleQuery struct {
	Page
	BizLine   contract.BizLine `form:"-"`
	ProgramID int64            `form:"programId"`
}

type ModulePage struct {
	Total int64        `json:"total"`
	Data  []ModuleView `json:"data"`
}

type DeleteModuleRequest struct {
	BizLine         contract.BizLine `json:"-"`
	ProgramID       int64            `json:"programId"`
	ModuleKey       string           `json:"moduleKey"`
	TargetModuleKey string           `json:"targetModuleKey"`
}
