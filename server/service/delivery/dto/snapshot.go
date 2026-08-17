// 快照相关的请求、查询与视图。

package dto

import (
	"contract"
)

// ---------- 快照 ----------

type SnapshotQuery struct {
	BizLine   contract.BizLine `form:"-"`
	ProgramID int64            `form:"programId"`
	ModuleKey string           `form:"moduleKey"`
	From      string           `form:"from"`
	To        string           `form:"to"`
}

type SnapshotView struct {
	StatDate      string  `json:"statDate"`
	ModuleKey     string  `json:"moduleKey"`
	Progress      float64 `json:"progress"`
	MaturityScore float64 `json:"maturityScore"`
	TotalCount    int     `json:"totalCount"`
	DoneCount     int     `json:"doneCount"`
	DoingCount    int     `json:"doingCount"`
	BlockedCount  int     `json:"blockedCount"`
}

type RebuildSnapshotRequest struct {
	BizLine   contract.BizLine `json:"-"`
	ProgramID int64            `json:"programId"`
	// StatDate 留空表示今天。补历史只在补录数据时用得上。
	StatDate string `json:"statDate"`
}
