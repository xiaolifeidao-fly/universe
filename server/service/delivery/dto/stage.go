// 阶段相关的请求与视图。

package dto

import (
	"contract"
)

// ---------- 阶段 ----------

type StageView struct {
	StageKey      string `json:"stageKey"`
	Seq           int    `json:"seq"`
	Tag           string `json:"tag"`
	TimeWindow    string `json:"timeWindow"`
	MaturityLevel string `json:"maturityLevel"`
	Title         string `json:"title"`
}

type SaveStageRequest struct {
	BizLine       contract.BizLine `json:"-"`
	ProgramID     int64            `json:"programId"`
	StageKey      string           `json:"stageKey"`
	Seq           int              `json:"seq"`
	Tag           string           `json:"tag"`
	TimeWindow    string           `json:"timeWindow"`
	MaturityLevel string           `json:"maturityLevel"`
	Title         string           `json:"title"`
}

type DeleteStageRequest struct {
	BizLine   contract.BizLine `json:"-"`
	ProgramID int64            `json:"programId"`
	StageKey  string           `json:"stageKey"`
}
